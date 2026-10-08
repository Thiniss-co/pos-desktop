/**
 * Disposable Laravel backend for Playwright journeys.
 *
 * Every write goes through the repository's guarded PHP entry points (`guardedArtisan.php`,
 * `guiFixture.php`), which re-verify the resolved connection in the writing process and refuse the
 * business databases, repository paths and real workstation profiles. The child environment is built
 * from scratch — never `...process.env` — so no `.env`, DB_URL or config cache can redirect it.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync, openSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKEND_ROOT, SANDBOX_SUPPORT } from './paths.mjs'

const FORBIDDEN = ['thinis_pos', 'thinis_pos_testing']

export async function freePort() {
  return await new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.on('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePort(port))
    })
  })
}

function assertDisposable(databasePath) {
  const temporaryRoot = realpathSync(tmpdir())
  if (!databasePath.startsWith(`${temporaryRoot}/`)) {
    throw new Error(`refusing: ${databasePath} is outside the system temporary directory`)
  }
  const stem = databasePath
    .split('/')
    .pop()
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
  if (FORBIDDEN.includes(stem)) {
    throw new Error('refusing: business database name')
  }
  if (databasePath.includes('/.config/pos-desktop')) {
    throw new Error('refusing: real workstation profile path')
  }
}

/** Every sandbox a journey started; the runner stops the survivors after each journey (stopAll). */
const liveSandboxes = new Set()

/** Stops every sandbox server still running; returns how many were left running. */
export async function stopAllSandboxes() {
  let leftRunning = 0
  for (const sandbox of [...liveSandboxes]) {
    if (sandbox.running()) leftRunning += 1
    await sandbox.stop().catch(() => undefined)
  }
  liveSandboxes.clear()
  return leftRunning
}

export async function startSandbox({
  runDir,
  name = 'backend',
  flags = {},
  port = null,
  guardHttp = process.env.POS_SANDBOX_GUARD_HTTP === '1',
  backendRoot = BACKEND_ROOT
} = {}) {
  // The backend tree serving this sandbox; `useBackend()` switches it (same database, same port), e.g. an older
  // backend first, then an upgrade (Platform Phase 6 compatibility journey `p6compat`).
  let root = backendRoot
  const dir = join(runDir, name)
  mkdirSync(dir, { recursive: true })
  const databasePath = join(realpathSync(dir), 'sandbox.sqlite')
  assertDisposable(databasePath)
  writeFileSync(databasePath, '')

  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: 'C.UTF-8',
    APP_ENV: 'testing',
    DB_CONNECTION: 'sqlite',
    DB_DATABASE: databasePath,
    POS_SANDBOX_EXPECTED_DB: databasePath,
    APP_CONFIG_CACHE: join(realpathSync(dir), 'laravel-config-cache.php'),
    SESSION_DRIVER: 'database',
    ...flags
  }

  const php = (args) => {
    const result = spawnSync('php', args, { cwd: root, env, encoding: 'utf8' })
    if (result.status !== 0) {
      throw new Error(
        `php ${args.slice(1).join(' ')} failed (${result.status}):\n${result.stdout}\n${result.stderr}`
      )
    }
    return result.stdout
  }

  php([join(SANDBOX_SUPPORT, 'guardedArtisan.php'), root, 'migrate'])
  php([join(SANDBOX_SUPPORT, 'guardedArtisan.php'), root, 'db:seed', 'DesktopMvpSmokeSeeder'])

  const listenPort = port ?? (await freePort())
  const origin = `http://127.0.0.1:${listenPort}`
  let server = null

  const sandbox = {
    dir,
    databasePath,
    env,
    origin,
    port: listenPort,
    guardHttp,
    get backendRoot() {
      return root
    },
    /**
     * Serves the same sandbox database from another backend tree: stop, switch, optionally migrate (an upgrade), start
     * again on the same port. Fixture operations run against the current tree as well.
     */
    async useBackend(nextRoot, { migrate = false } = {}) {
      await sandbox.stop()
      root = nextRoot
      if (migrate) php([join(SANDBOX_SUPPORT, 'guardedArtisan.php'), root, 'migrate'])
      await sandbox.start()
    },
    fixture(operation, argument = '') {
      const output = php([join(SANDBOX_SUPPORT, 'guiFixture.php'), root, operation, argument])
      const line = output.trim().split('\n').pop()
      return JSON.parse(line)
    },
    async start() {
      // A child killed by a signal keeps `exitCode === null` (its `signalCode` is set instead).
      const running = () => server && server.exitCode === null && server.signalCode === null
      if (running()) return
      const logFd = openSync(join(dir, 'server.log'), 'a')
      // POS_SANDBOX_GUARD_HTTP=1: every HTTP request is served through guardedHttpRouter.php, which
      // re-verifies the resolved database inside the serving process before handling it.
      const args = guardHttp
        ? [
            '-S',
            `127.0.0.1:${listenPort}`,
            '-t',
            join(root, 'public'),
            join(SANDBOX_SUPPORT, 'guardedHttpRouter.php')
          ]
        : ['artisan', 'serve', '--host=127.0.0.1', `--port=${listenPort}`, '--no-reload']
      server = spawn('php', args, {
        cwd: root,
        env: { ...env, PHP_CLI_SERVER_WORKERS: '1', POS_SANDBOX_BACKEND_ROOT: root },
        detached: true,
        stdio: ['ignore', logFd, logFd]
      })
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        try {
          const response = await fetch(new URL('/up', origin))
          if (response.status > 0) return
        } catch {
          await new Promise((r) => setTimeout(r, 200))
        }
      }
      throw new Error('sandbox backend never became ready')
    },
    running() {
      return Boolean(server) && server.exitCode === null && server.signalCode === null
    },
    async stop() {
      if (!server || server.exitCode !== null || server.signalCode !== null) return
      // A restart must wait for the exit event itself, not only for `/up` to stop answering.
      const exited = new Promise((resolve) => server.once('exit', resolve))
      try {
        process.kill(-server.pid, 'SIGTERM')
      } catch {
        // already gone
      }
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))])
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        try {
          await fetch(new URL('/up', origin))
          await new Promise((r) => setTimeout(r, 200))
        } catch {
          return
        }
      }
    }
  }

  await sandbox.start()
  liveSandboxes.add(sandbox)
  return sandbox
}
