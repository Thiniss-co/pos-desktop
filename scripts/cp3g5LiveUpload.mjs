#!/usr/bin/env node
/**
 * CP-3G-5 live end-to-end upload gate.
 *
 * Creates a private, per-run authorization contract for the PHP seeder, runs Laravel only against
 * that run's disposable SQLite file, and always removes the complete temporary directory.
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_ROOT = resolve(HERE, '..')
const BACKEND_ROOT = resolve(
  process.env.CP3G5_BACKEND_ROOT ?? resolve(DESKTOP_ROOT, '..', 'pos-backend')
)
const SEEDER = join(DESKTOP_ROOT, 'tests', 'electron', 'support', 'cp3g5', 'seedLiveBackend.php')
const SANDBOX_PREFIX = 'pos-desktop-cp3g5-'
const DATABASE_FILENAME = 'cp3g5-backend.sqlite'
const MARKER_FILENAME = '.cp3g5-harness'
const FIXTURE_FILENAME = 'cp3g5-fixture.json'
const PORT = Number(process.env.CP3G5_PORT ?? 8399)
const PAYLOAD_COUNT = Number(process.env.CP3G5_PAYLOADS ?? 16)

class HarnessFailure extends Error {}

function fail(message) {
  throw new HarnessFailure(message)
}

function sanitizedChildFailure(label, result) {
  const detail = result.error ? ` (${result.error.code ?? 'spawn error'})` : ''
  fail(`${label} failed with no child output forwarded${detail}`)
}

if (process.argv.length > 2) {
  console.error('[cp3g5] unsupported argument; this harness never retains temporary credentials')
  process.exit(1)
}

if (!existsSync(join(BACKEND_ROOT, 'artisan'))) {
  console.error('[cp3g5] Laravel backend is unavailable; set CP3G5_BACKEND_ROOT')
  process.exit(1)
}

const systemTemporaryRoot = realpathSync(tmpdir())

function createAuthorizedSandbox() {
  const generated = mkdtempSync(join(systemTemporaryRoot, SANDBOX_PREFIX))

  try {
    const root = realpathSync(generated)

    if (root !== generated) fail('generated temporary directory is not canonical')

    const database = join(root, DATABASE_FILENAME)
    const marker = join(root, MARKER_FILENAME)
    const fixture = join(root, FIXTURE_FILENAME)
    const runNonce = randomBytes(32).toString('hex')

    writeFileSync(database, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    writeFileSync(marker, `${runNonce}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    chmodSync(marker, 0o600)

    return { database, fixture, root, runNonce }
  } catch (error) {
    const stat = lstatSync(generated)

    if (
      dirname(generated) !== systemTemporaryRoot ||
      !basename(generated).startsWith(SANDBOX_PREFIX) ||
      stat.isSymbolicLink() ||
      !stat.isDirectory()
    ) {
      fail('temporary-directory initialization failed closed')
    }

    rmSync(generated, { recursive: true, force: true })

    if (existsSync(generated)) fail('temporary-directory initialization cleanup failed')

    throw error
  }
}

let authorizedSandbox

try {
  authorizedSandbox = createAuthorizedSandbox()
} catch {
  console.error('[cp3g5] temporary-directory initialization failed closed')
  process.exit(1)
}

const {
  database: databasePath,
  fixture: fixturePath,
  root: exactGeneratedSandbox,
  runNonce: nonce
} = authorizedSandbox

const childBaseEnvironment = { ...process.env }
delete childBaseEnvironment.APP_CONFIG_CACHE
delete childBaseEnvironment.DB_URL

const backendEnvironment = {
  ...childBaseEnvironment,
  APP_ENV: 'testing',
  APP_DEBUG: 'false',
  DB_CONNECTION: 'sqlite',
  DB_DATABASE: databasePath,
  DB_FOREIGN_KEYS: 'true',
  LOG_CHANNEL: 'errorlog',
  CP3G5_LIVE_HARNESS: '1',
  CP3G5_TEMP_ROOT: exactGeneratedSandbox,
  CP3G5_RUN_NONCE: nonce,
  CP3G5_RESPONSE_FILE: fixturePath
}

let server = null
let cleanupComplete = false

function shutdownServer() {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM')
  }
}

/** Delete only the exact directory returned by this run's mkdtemp call. */
function disposeSandbox(target) {
  if (cleanupComplete) return

  const resolvedTarget = resolve(target)
  const targetStat = lstatSync(target)

  if (
    target !== exactGeneratedSandbox ||
    resolvedTarget !== exactGeneratedSandbox ||
    dirname(target) !== systemTemporaryRoot ||
    !basename(target).startsWith(SANDBOX_PREFIX) ||
    targetStat.isSymbolicLink() ||
    !targetStat.isDirectory()
  ) {
    fail('refusing cleanup because the target is not the exact generated temporary directory')
  }

  rmSync(target, { force: true, recursive: true })

  if (existsSync(target)) {
    fail('temporary-directory removal could not be verified')
  }

  cleanupComplete = true
  console.log('[cp3g5] temporary directory removed and verified absent')
}

function handleSignal(exitCode) {
  shutdownServer()

  try {
    disposeSandbox(exactGeneratedSandbox)
  } catch {
    // Preserve a non-zero signal exit without exposing filesystem or child-process detail.
  }

  process.exit(exitCode)
}

process.once('SIGINT', () => handleSignal(130))
process.once('SIGTERM', () => handleSignal(143))

let exitCode = 1

try {
  console.log('[cp3g5] created an authorized disposable backend database')

  const migrate = spawnSync('php', ['artisan', 'migrate', '--force', '--no-interaction'], {
    cwd: BACKEND_ROOT,
    env: backendEnvironment,
    encoding: 'utf8'
  })

  if (migrate.status !== 0) {
    sanitizedChildFailure('backend migration', migrate)
  }

  console.log('[cp3g5] backend migrations applied to the disposable database')

  const seed = spawnSync('php', [SEEDER, BACKEND_ROOT, String(PAYLOAD_COUNT)], {
    cwd: BACKEND_ROOT,
    env: backendEnvironment,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  })

  if (seed.status !== 0 || seed.stdout !== '' || !existsSync(fixturePath)) {
    sanitizedChildFailure('fixture seeding', seed)
  }

  if ((lstatSync(fixturePath).mode & 0o777) !== 0o600 || lstatSync(fixturePath).isSymbolicLink()) {
    fail('fixture seeding did not produce an owner-only response file')
  }

  console.log(`[cp3g5] minted ${PAYLOAD_COUNT} upload fixtures through private file IPC`)

  server = spawn('php', ['artisan', 'serve', '--host=127.0.0.1', `--port=${PORT}`], {
    cwd: BACKEND_ROOT,
    env: backendEnvironment,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  // Drain and discard server output. Laravel errors can contain credentials or request context,
  // and unread pipes can eventually block the child process.
  server.stdout.on('data', () => {})
  server.stderr.on('data', () => {})
  server.on('error', () => {})

  const origin = `http://127.0.0.1:${PORT}`
  let ready = false

  for (let attempt = 0; attempt < 80 && !ready; attempt += 1) {
    await new Promise((done) => setTimeout(done, 250))

    try {
      const probe = await fetch(`${origin}/up`, { signal: AbortSignal.timeout(1000) })
      ready = probe.ok
    } catch {
      ready = false
    }
  }

  if (!ready) {
    fail('the disposable Laravel server never became ready')
  }

  console.log(`[cp3g5] live Laravel ready on ${origin}`)

  const suiteEnvironment = { ...process.env }
  delete suiteEnvironment.CP3G5_LIVE_HARNESS
  delete suiteEnvironment.CP3G5_TEMP_ROOT
  delete suiteEnvironment.CP3G5_RUN_NONCE
  delete suiteEnvironment.CP3G5_RESPONSE_FILE

  const suite = spawnSync(
    process.execPath,
    [join(DESKTOP_ROOT, 'scripts', 'runElectronNode.mjs'), join('tests', 'electron', 'index.ts')],
    {
      cwd: DESKTOP_ROOT,
      env: {
        ...suiteEnvironment,
        CP3G5_FIXTURE: fixturePath,
        CP3G5_API_ORIGIN: origin,
        CP3G5_BACKEND_DB: databasePath
      },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    }
  )

  if (suite.status !== 0) {
    sanitizedChildFailure('Electron SQLite suite', suite)
  }

  console.log('[cp3g5] Electron SQLite live suite passed')
  exitCode = 0
} catch (error) {
  const message = error instanceof HarnessFailure ? error.message : 'unexpected harness failure'
  console.error(`[cp3g5] ${message}`)
  exitCode = 1
} finally {
  shutdownServer()

  try {
    disposeSandbox(exactGeneratedSandbox)
  } catch {
    console.error('[cp3g5] temporary-directory cleanup failed closed')
    exitCode = 1
  }
}

process.exit(exitCode)
