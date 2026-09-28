#!/usr/bin/env node
/**
 * PS7 — the physical-presence sale, end to end, against a real Laravel over real HTTP.
 *
 * A deliberately small sibling of `cp3g5LiveUpload.mjs`. That harness proves the v2 upload path and
 * suppresses child output as a security property (child output can carry fixture content); this one
 * exists to prove the v3 path and to be **debuggable**, so it forwards the suite's output.
 *
 * It seeds through `php artisan tinker` rather than the CP-3G-5 seeder, because that seeder carries
 * its own per-run authorization contract that only its own harness can satisfy — reproducing that
 * contract here would mean duplicating a security mechanism rather than reusing one.
 *
 * ## Safety
 *
 *  - the backend database is a fresh SQLite file inside a per-run `mkdtemp` directory. The
 *    developer's own database is never opened, migrated, or read;
 *  - `APP_ENV=testing` and an explicit `DB_DATABASE` path are passed to every child, so nothing
 *    falls back to `.env`;
 *  - every child is spawned DETACHED and killed by process group, because `php artisan serve` holds
 *    its listening socket in a grandchild — signalling only the direct child leaves the port held;
 *  - the temporary directory is removed in a `finally`, and its absence is verified.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_ROOT = resolve(HERE, '..')
const BACKEND_ROOT = resolve(DESKTOP_ROOT, '..', 'pos-backend')
const GUARDED_ARTISAN = join(
  DESKTOP_ROOT,
  'tests',
  'electron',
  'support',
  'sandbox',
  'guardedArtisan.php'
)
const READY_TIMEOUT_MS = 60_000

function log(message) {
  console.log(`[ps7-live] ${message}`)
}

async function freePort() {
  return await new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.on('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePort(port))
    })
  })
}

function killGroup(child) {
  if (!child || child.exitCode !== null) {
    return
  }

  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    // Already gone.
  }
}

async function waitForServer(origin) {
  const deadline = Date.now() + READY_TIMEOUT_MS

  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL('/api/v1/desktop/bootstrap', origin), {
        headers: { Accept: 'application/json' }
      })

      // Any HTTP answer means the socket is live; 401 is the expected unauthenticated response.
      if (response.status > 0) {
        return
      }
    } catch {
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  throw new Error('the live backend never became ready')
}

const sandbox = mkdtempSync(join(realpathSync(tmpdir()), 'pos-ps7-live-'))
const databasePath = join(sandbox, 'ps7-backend.sqlite')
const fixturePath = join(sandbox, 'ps7-fixture.json')

let server = null

try {
  writeFileSync(databasePath, '')
  log(`created a disposable backend database inside ${sandbox}`)

  const inherited = { ...process.env }
  // A URL or a cached config would silently win over DB_DATABASE; neither may reach a child.
  delete inherited.DB_URL
  delete inherited.APP_CONFIG_CACHE

  const backendEnv = {
    ...inherited,
    APP_ENV: 'testing',
    DB_CONNECTION: 'sqlite',
    DB_DATABASE: databasePath,
    // An isolated, never-written config cache path: `bootstrap/cache/config.php` can't apply.
    APP_CONFIG_CACHE: join(sandbox, 'laravel-config-cache.php'),
    // Read by tests/electron/support/sandbox/laravelSandboxGuard.php in the writing process.
    POS_SANDBOX_EXPECTED_DB: databasePath,
    // The capability is enabled ONLY for this disposable run, through the environment. No real
    // configuration file is written or changed.
    POS_OFFLINE_PHYSICAL_PRESENCE_ENABLED: 'true'
  }

  // Migrate and seed in the same PHP process that verifies the resolved connection.
  const migrate = spawnSync('php', [GUARDED_ARTISAN, BACKEND_ROOT, 'migrate'], {
    cwd: BACKEND_ROOT,
    env: backendEnv,
    encoding: 'utf8'
  })

  if (migrate.status !== 0) {
    throw new Error(`migrations failed:\n${migrate.stdout}\n${migrate.stderr}`)
  }

  log('backend migrations applied to the disposable database')

  const seed = spawnSync(
    'php',
    [GUARDED_ARTISAN, BACKEND_ROOT, 'ps7:seed-physical-presence-fixture', fixturePath],
    { cwd: BACKEND_ROOT, env: backendEnv, encoding: 'utf8' }
  )

  if (seed.status !== 0) {
    throw new Error(`seeding failed:\n${seed.stdout}\n${seed.stderr}`)
  }

  log('minted the physical-presence fixture')

  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`

  server = spawn('php', ['artisan', 'serve', '--host=127.0.0.1', `--port=${port}`], {
    cwd: BACKEND_ROOT,
    env: backendEnv,
    detached: true,
    stdio: 'ignore'
  })

  await waitForServer(origin)
  log(`live Laravel ready on ${origin}, owned by this run's process group`)

  const suite = spawnSync('node', ['scripts/runElectronNode.mjs', 'tests/electron/index.ts'], {
    cwd: DESKTOP_ROOT,
    env: {
      ...process.env,
      CP3G5_FIXTURE: fixturePath,
      CP3G5_API_ORIGIN: origin,
      CP3G5_BACKEND_DB: databasePath
    },
    // Forwarded deliberately: being able to see WHY a live assertion failed is the whole point of
    // this script existing alongside the CP-3G-5 harness.
    stdio: 'inherit'
  })

  if (suite.status !== 0) {
    throw new Error('the Electron live suite failed')
  }

  log('physical-presence live suite passed')
} finally {
  killGroup(server)
  rmSync(sandbox, { recursive: true, force: true })

  if (existsSync(sandbox)) {
    log(`WARNING: temporary directory ${sandbox} could not be removed`)
  } else {
    log('temporary directory removed and verified absent')
  }
}
