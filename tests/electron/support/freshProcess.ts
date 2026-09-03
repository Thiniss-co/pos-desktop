import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
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

/**
 * Resolves the **real** Electron binary, not `node_modules/.bin/electron`.
 *
 * That bin is a Node wrapper which spawns the real binary as its own child and forwards only
 * `SIGINT`/`SIGTERM`. A `SIGKILL` aimed at the wrapper would therefore kill the wrapper and orphan
 * the process the test is trying to crash. CP-3G-6 sends the signal to the process that owns the
 * SQLite handle, so it must address that process directly.
 */
function realElectronBinary(): string {
  const distributionRoot = join(projectRoot, 'node_modules', 'electron', 'dist')
  const relative = readFileSync(join(projectRoot, 'node_modules', 'electron', 'path.txt'), 'utf8')
  const binary = join(distributionRoot, relative.trim())

  if (!existsSync(binary)) {
    throw new Error(`Electron binary is missing: ${binary}`)
  }

  return binary
}

/** Bundles one fresh-process worker into the sandbox and returns the bundle path. */
function bundleWorker(sandbox: DatabaseSandbox, workerSource: string, label: string): string {
  if (!existsSync(workerSource)) {
    throw new Error(`Fresh-process worker is missing: ${workerSource}`)
  }

  const bundlePath = join(sandbox.root, `worker-${label}-${process.hrtime.bigint()}.cjs`)
  const esbuildPath = join(projectRoot, 'node_modules', '.bin', 'esbuild')
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

  return bundlePath
}

export interface FreshProcessHandle {
  /** The process id of the real Electron process, i.e. the one a `SIGKILL` must address. */
  readonly pid: number
  /**
   * Waits until the worker publishes the named coordination file, and returns its parsed content.
   *
   * The file is the only channel between a parked worker and the test: the worker writes it and
   * then blocks, so the parent can verify external state (the server's committed rows) *before*
   * it kills the process. It carries counts, states and identities — never a credential.
   */
  waitForMarker(markerPath: string, timeoutMs?: number): Promise<Record<string, unknown>>
  /** Sends a real signal to the real process. Nothing in the worker can catch `SIGKILL`. */
  kill(signal: NodeJS.Signals): void
  /** Resolves once the process has actually exited. */
  wait(): Promise<FreshProcessOutcome>
}

/**
 * Starts one worker command in a **genuinely separate Electron process** and hands the caller the
 * live process, rather than waiting for it to finish.
 *
 * `runFreshProcess` covers workers that kill *themselves* at a chosen write boundary. CP-3G-6 needs
 * the stronger form: the worker parks at a boundary, the test verifies the outside world, and the
 * **test** then delivers `SIGKILL` from another process. A signal delivered that way cannot be
 * caught, cannot unwind, and runs no `finally` block — which is exactly the property a crash proof
 * must not fake.
 */
export function startFreshProcess(
  sandbox: DatabaseSandbox,
  workerSource: string,
  label: string,
  environment: Readonly<Record<string, string>> = {}
): FreshProcessHandle {
  const bundlePath = bundleWorker(sandbox, workerSource, label)
  const child = spawn(realElectronBinary(), [bundlePath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_PATH: join(projectRoot, 'node_modules'),
      POS_ITEST_DB_PATH: sandbox.databasePath,
      ...environment
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })

  const exited = new Promise<FreshProcessOutcome>((resolve) => {
    child.on('close', (status, signal) => {
      const resultLine = stdout
        .split('\n')
        .reverse()
        .find((line) => line.startsWith(RESULT_PREFIX))

      resolve({
        status,
        signal,
        killedBySignal: signal === 'SIGKILL' || /exited with signal SIGKILL/.test(stderr),
        stdout,
        stderr,
        result: resultLine
          ? (JSON.parse(resultLine.slice(RESULT_PREFIX.length)) as Record<string, unknown>)
          : null
      })
    })
  })

  let exitedEarly = false
  void exited.then(() => {
    exitedEarly = true
  })

  return {
    pid: child.pid ?? -1,
    async waitForMarker(markerPath, timeoutMs = 90_000) {
      const deadline = Date.now() + timeoutMs

      while (Date.now() < deadline) {
        if (existsSync(markerPath)) {
          return JSON.parse(readFileSync(markerPath, 'utf8')) as Record<string, unknown>
        }

        if (exitedEarly) {
          throw new Error(
            `Fresh process exited before reaching its boundary: ${stderr.slice(-2000)}`
          )
        }

        await new Promise((done) => setTimeout(done, 20))
      }

      throw new Error(`Fresh process never reached its boundary: ${markerPath}`)
    },
    kill(signal) {
      child.kill(signal)
    },
    wait: () => exited
  }
}
