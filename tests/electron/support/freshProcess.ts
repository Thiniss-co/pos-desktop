import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { DatabaseSandbox } from './sandbox'

// The suite bundle is CJS, so `import.meta.url` is unavailable. `scripts/runElectronNode.mjs`
// always spawns the harness with the project root as its working directory, and the check below
// fails loudly rather than silently spawning against the wrong tree.
const projectRoot = resolve(process.cwd())

export interface FreshProcessOutcome {
  /** Process exit code — `null` when the process was terminated by a signal. */
  readonly status: number | null
  /** The terminating signal, when the launcher propagated one. */
  readonly signal: NodeJS.Signals | null
  /**
   * Whether the worker was hard-killed. The `electron` bin is a Node wrapper around the real
   * binary: it catches the child's `SIGKILL` and exits 1 itself, reporting the signal on stderr,
   * so the raw `signal` field alone would read as `null` for a genuine kill.
   */
  readonly killedBySignal: boolean
  readonly stdout: string
  readonly stderr: string
  /** The single `@@RESULT@@` JSON line the worker printed, when it got that far. */
  readonly result: Record<string, unknown> | null
}

export const RESULT_PREFIX = '@@RESULT@@'

/**
 * Runs one worker command in a **genuinely separate Electron process** against the sandbox
 * database file, and waits for it to exit.
 *
 * This is what makes the plan's fresh-process recovery tests real rather than simulated: the
 * worker shares nothing with this process — no in-memory attempt key, no service instance, no
 * open handle, no retained test variable. Everything it acts on it must discover from on-disk
 * state alone. A `SIGKILL`ed worker is a real killed process, not a caught exception.
 *
 * The bundle is written inside `sandbox.root` so the sandbox's own disposal removes it; this
 * module never deletes anything itself.
 */
export function runFreshProcess(
  sandbox: DatabaseSandbox,
  command: string,
  environment: Readonly<Record<string, string>> = {}
): FreshProcessOutcome {
  const workerSource = resolve(projectRoot, 'tests/electron/support/recoveryWorker.ts')

  if (!existsSync(workerSource)) {
    throw new Error(`Fresh-process worker is missing: ${workerSource}`)
  }

  const bundlePath = join(sandbox.root, `worker-${command}-${process.hrtime.bigint()}.cjs`)
  const esbuildPath = join(projectRoot, 'node_modules', '.bin', 'esbuild')
  const electronPath = join(projectRoot, 'node_modules', '.bin', 'electron')

  const bundled = spawnSync(
    esbuildPath,
    [
      workerSource,
      '--bundle',
      '--platform=node',
      '--format=cjs',
      '--target=node22',
      '--alias:@shared=./src/shared',
      '--external:better-sqlite3',
      '--external:electron',
      `--outfile=${bundlePath}`
    ],
    { cwd: projectRoot, encoding: 'utf8' }
  )

  if (bundled.status !== 0) {
    throw new Error(`Fresh-process worker failed to bundle: ${bundled.stderr}`)
  }

  const run = spawnSync(electronPath, [bundlePath], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_PATH: join(projectRoot, 'node_modules'),
      POS_ITEST_DB_PATH: sandbox.databasePath,
      POS_ITEST_COMMAND: command,
      ...environment
    }
  })

  const stdout = run.stdout ?? ''
  const resultLine = stdout
    .split('\n')
    .reverse()
    .find((line) => line.startsWith(RESULT_PREFIX))

  const stderr = run.stderr ?? ''

  return {
    status: run.status,
    signal: run.signal,
    killedBySignal: run.signal === 'SIGKILL' || /exited with signal SIGKILL/.test(stderr),
    stdout,
    stderr,
    result: resultLine
      ? (JSON.parse(resultLine.slice(RESULT_PREFIX.length)) as Record<string, unknown>)
      : null
  }
}
