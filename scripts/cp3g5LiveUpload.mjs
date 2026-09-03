#!/usr/bin/env node
/**
 * CP-3G-5 / CP-3G-6 live end-to-end upload gate.
 *
 * Creates a private, per-run authorization contract for the PHP seeder, runs Laravel only against
 * that run's disposable SQLite file, and always removes the complete temporary directory.
 *
 * **Process lifecycle (CP-3G-6 correction).** `php artisan serve` is a supervisor: the listening
 * socket is held by a `php -S` *grandchild*. Signalling only the artisan child left that grandchild
 * alive, holding the port with an already-deleted database, so a later run connected to a dead
 * server and failed with 500s. Every child this harness starts is therefore launched **detached**,
 * becoming its own process-group leader, and cleanup signals that whole group — never a process
 * discovered by name or by which port it happens to hold.
 *
 * The helpers below are exported so the lifecycle regressions in
 * `tests/cp3g5HarnessLifecycle.test.mjs` can drive them directly; running this file still executes
 * the gate.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
const PAYLOAD_COUNT = Number(process.env.CP3G5_PAYLOADS ?? 16)
const SUITE_TIMEOUT_MS = Number(process.env.CP3G5_SUITE_TIMEOUT_MS ?? 2_700_000)
const GRACEFUL_TERMINATION_MS = Number(process.env.CP3G5_GRACEFUL_MS ?? 5_000)
const FORCED_TERMINATION_MS = Number(process.env.CP3G5_FORCED_MS ?? 5_000)
const PORT_RELEASE_MS = 10_000

/**
 * Failure injection, for the lifecycle regressions only. Every value can make the run **fail
 * earlier**; none can relax an authorization check, widen a path guard, retain a sandbox, or skip
 * any part of cleanup.
 */
const FAULTS = new Set([
  'server-startup-failure',
  'fail-after-ready',
  'suite-failure',
  'suite-hang'
])
const FAULT = FAULTS.has(process.env.CP3G5_FAULT ?? '') ? process.env.CP3G5_FAULT : null

/**
 * Seed-only mode (CP-3G-7 F2 reproduction driver).
 *
 * Runs sandbox-create → migrate → seed → fixture-write and then the *identical* cleanup path,
 * skipping the server and the Electron suite. It relaxes no authorization check, no path guard and
 * no cleanup step: it only stops earlier, so a bounded reproduction run can exercise the seeding
 * stage many times without paying for a full live suite each iteration.
 */
const SEED_ONLY = process.env.CP3G5_SEED_ONLY === '1'

export class HarnessFailure extends Error {}

/** Internal control flow for seed-only mode. Never a failure, never reported as one. */
class SeedOnlyComplete extends Error {}

function fail(message) {
  throw new HarnessFailure(message)
}

// ---------------------------------------------------------------------------------------------
// Process primitives. Nothing here matches on a command name, and nothing acts on a process this
// harness did not start and record.
// ---------------------------------------------------------------------------------------------

/** `{ pid, ppid, pgid, sid }` from `/proc/<pid>/stat`, or null when the process is gone. */
export function readProcessStat(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // `comm` is parenthesised and may itself contain spaces or brackets; everything positional
    // starts after the final `)`.
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ')

    return { pid, ppid: Number(fields[1]), pgid: Number(fields[2]), sid: Number(fields[3]) }
  } catch {
    return null
  }
}

export function isProcessAlive(pid) {
  return readProcessStat(pid) !== null
}

/** Every live pid whose process group is exactly `processGroupId`. */
export function processGroupMembers(processGroupId) {
  const members = []

  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) {
      continue
    }

    const stat = readProcessStat(Number(entry))

    if (stat && stat.pgid === processGroupId) {
      members.push(stat.pid)
    }
  }

  return members.sort((left, right) => left - right)
}

export async function waitUntil(predicate, timeoutMs, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs

  for (;;) {
    if (await predicate()) {
      return true
    }

    if (Date.now() >= deadline) {
      return false
    }

    await new Promise((done) => setTimeout(done, intervalMs))
  }
}

/** Reserves a loopback port by binding and releasing it, so no fixed port is ever assumed. */
export function reserveLoopbackPort() {
  return new Promise((done, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => done(port))
    })
  })
}

export function loopbackPortIsFree(port) {
  return new Promise((done) => {
    const probe = createServer()
    probe.once('error', () => done(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => done(true)))
  })
}

/** Listening-socket inodes on the loopback address for `port`, from the kernel's own tables. */
export function listeningSocketInodes(port) {
  const wanted = port.toString(16).toUpperCase().padStart(4, '0')
  const inodes = []

  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let raw = ''

    try {
      raw = readFileSync(table, 'utf8')
    } catch {
      continue
    }

    for (const line of raw.split('\n').slice(1)) {
      const columns = line.trim().split(/\s+/)

      if (columns.length < 10 || columns[3] !== '0A') {
        continue
      }

      if (columns[1].endsWith(`:${wanted}`)) {
        inodes.push(columns[9])
      }
    }
  }

  return inodes
}

/** True when `pid` holds one of `inodes` open. Used to prove a listener is ours — never to kill. */
export function processOwnsSocketInode(pid, inodes) {
  const wanted = new Set(inodes.map((inode) => `socket:[${inode}]`))

  try {
    for (const handle of readdirSync(`/proc/${pid}/fd`)) {
      try {
        if (wanted.has(readlinkSync(`/proc/${pid}/fd/${handle}`))) {
          return true
        }
      } catch {
        // The descriptor closed while being read; it cannot be the one we are looking for.
      }
    }
  } catch {
    return false
  }

  return false
}

/**
 * Starts one child as the leader of its **own** process group, so the whole tree beneath it can be
 * signalled without ever touching this harness's own group.
 *
 * If the group cannot be established the child is terminated by its recorded pid and the run stops.
 * There is deliberately no broad fallback: killing by name or by port is how a harness destroys
 * something it does not own.
 */
export function startOwnedProcessGroup(command, args, options = {}) {
  const child = spawn(command, args, { ...options, detached: true })

  if (typeof child.pid !== 'number' || child.pid <= 1) {
    fail(`${command} could not be started in its own process group`)
  }

  const stat = readProcessStat(child.pid)
  const ownGroup = readProcessStat(process.pid)?.pgid ?? process.pid
  const exited = new Promise((done) => {
    child.once('close', (code, signal) => done({ code, signal }))
    child.once('error', () => done({ code: null, signal: null }))
  })

  if (stat !== null && (stat.pgid !== child.pid || stat.pgid === ownGroup)) {
    // Only ever the recorded pid: the group identity is exactly what is in doubt here.
    try {
      process.kill(child.pid, 'SIGKILL')
    } catch {
      // Already gone.
    }

    fail(`${command} did not become its own process-group leader`)
  }

  return {
    command,
    child,
    pid: child.pid,
    // A child that exits between spawn and the stat read is still owned by its own group.
    processGroupId: child.pid,
    exited,
    members: () => processGroupMembers(child.pid)
  }
}

function signalOwnedGroup(processGroupId, signal) {
  const ownGroup = readProcessStat(process.pid)?.pgid ?? process.pid

  if (
    !Number.isInteger(processGroupId) ||
    processGroupId <= 1 ||
    processGroupId === process.pid ||
    processGroupId === ownGroup
  ) {
    fail('refusing to signal a process group this harness does not own')
  }

  try {
    process.kill(-processGroupId, signal)
  } catch (error) {
    if (error.code !== 'ESRCH') {
      throw error
    }
  }
}

/**
 * Terminates an owned group: `SIGTERM`, a bounded wait, then `SIGKILL` to the same group and
 * another bounded wait, then proof that no member of that group is left.
 */
export async function terminateOwnedProcessGroup(owned, options = {}) {
  if (!owned) {
    return { terminated: true, escalated: false, survivors: [] }
  }

  const gracefulMs = options.gracefulMs ?? GRACEFUL_TERMINATION_MS
  const forcedMs = options.forcedMs ?? FORCED_TERMINATION_MS
  const group = owned.processGroupId
  const empty = async () => processGroupMembers(group).length === 0

  signalOwnedGroup(group, 'SIGTERM')

  let escalated = false

  if (!(await waitUntil(empty, gracefulMs))) {
    escalated = true
    signalOwnedGroup(group, 'SIGKILL')
    await waitUntil(empty, forcedMs)
  }

  const survivors = processGroupMembers(group)

  return { terminated: survivors.length === 0, escalated, survivors }
}

// ---------------------------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// CP-3G-7 F2 — redaction-safe lifecycle diagnostics.
//
// The child's stdout and stderr are still never forwarded. The only thing that crosses the
// boundary is a `CP3G5-DIAG {json}` line the seeder emits about *itself*, and even that is
// re-validated here against a fixed key/value allowlist before it is shown. A key that is not on
// the list, or a value that is not enum-shaped, is dropped rather than printed.
// ---------------------------------------------------------------------------------------------

/** The lifecycle positions a run can occupy. Reported verbatim; never derived from child output. */
const LIFECYCLE_PHASES = [
  'sandbox-create',
  'authorization',
  'pre-bootstrap-check',
  'laravel-bootstrap',
  'migrate',
  'seed',
  'fixture-write',
  'server-start',
  'electron-run',
  'server-stop',
  'cleanup'
]

const DIAGNOSTIC_STRING_KEYS = ['phase', 'operation', 'code', 'exception', 'sqlstate', 'identifier']
const DIAGNOSTIC_NUMBER_KEYS = ['driver_code', 'transaction_level', 'iteration']
const DIAGNOSTIC_VALUE_SHAPE = /^[A-Za-z0-9_.\\-]{1,120}$/
const DIAGNOSTIC_LINE = /^CP3G5-DIAG (\{[^\n]{0,2000}\})$/

let currentPhase = 'sandbox-create'
const diagnosticRecords = []

function setPhase(phase) {
  if (!LIFECYCLE_PHASES.includes(phase)) fail('unknown lifecycle phase')

  currentPhase = phase
}

/** Record one diagnostic. Only whitelisted, shape-checked fields survive. */
function recordDiagnostic(fields) {
  const safe = { phase: currentPhase }

  for (const key of DIAGNOSTIC_STRING_KEYS) {
    const value = fields[key]

    if (typeof value === 'string' && DIAGNOSTIC_VALUE_SHAPE.test(value)) safe[key] = value
  }

  for (const key of DIAGNOSTIC_NUMBER_KEYS) {
    const value = fields[key]

    if (Number.isInteger(value)) safe[key] = value
  }

  diagnosticRecords.push(safe)
  console.error(`[cp3g5] diagnostic ${JSON.stringify(safe)}`)

  return safe
}

/**
 * Parse the seeder's own diagnostic line out of a captured stderr buffer.
 *
 * Everything that is not an exact `CP3G5-DIAG {json}` line is discarded, so an unexpected warning,
 * a stack trace or a leaked value can never be echoed by this function.
 */
export function parseChildDiagnostics(stderr) {
  if (typeof stderr !== 'string') return []

  const parsed = []

  for (const line of stderr.split('\n')) {
    const match = DIAGNOSTIC_LINE.exec(line.trim())

    if (match === null) continue

    let candidate

    try {
      candidate = JSON.parse(match[1])
    } catch {
      continue
    }

    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue

    const safe = {}

    for (const key of DIAGNOSTIC_STRING_KEYS) {
      const value = candidate[key]

      if (typeof value === 'string' && DIAGNOSTIC_VALUE_SHAPE.test(value)) safe[key] = value
    }

    for (const key of DIAGNOSTIC_NUMBER_KEYS) {
      const value = candidate[key]

      if (Number.isInteger(value)) safe[key] = value
    }

    if (Object.keys(safe).length > 0) parsed.push(safe)
  }

  return parsed
}

function sanitizedChildFailure(label, result) {
  const detail = result.error ? ` (${result.error.code ?? 'spawn error'})` : ''

  for (const diagnostic of parseChildDiagnostics(result.stderr)) {
    recordDiagnostic(diagnostic)
  }

  recordDiagnostic({
    code: 'child-failed',
    operation: label.replaceAll(' ', '-'),
    ...(Number.isInteger(result.status) ? { driver_code: result.status } : {})
  })

  fail(`${label} failed with no child output forwarded${detail}`)
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

async function main() {
  if (process.argv.length > 2) {
    console.error('[cp3g5] unsupported argument; this harness never retains temporary credentials')
    return 1
  }

  if (!existsSync(join(BACKEND_ROOT, 'artisan'))) {
    console.error('[cp3g5] Laravel backend is unavailable; set CP3G5_BACKEND_ROOT')
    return 1
  }

  let authorizedSandbox

  setPhase('sandbox-create')

  try {
    authorizedSandbox = createAuthorizedSandbox()
  } catch {
    console.error('[cp3g5] temporary-directory initialization failed closed')
    return 1
  }

  const {
    database: databasePath,
    fixture: fixturePath,
    root: exactGeneratedSandbox
  } = authorizedSandbox
  let nonce = authorizedSandbox.runNonce

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
    // Switches on the seeder's own whitelisted lifecycle diagnostics (CP-3G-7 F2). Unauthorized
    // direct invocations never set this, so their rejection output stays exactly as CP-3G-5 froze it.
    CP3G5_DIAGNOSTICS: '1',
    CP3G5_TEMP_ROOT: exactGeneratedSandbox,
    CP3G5_RUN_NONCE: nonce,
    CP3G5_RESPONSE_FILE: fixturePath
  }

  let serverGroup = null
  let suiteGroup = null
  let selectedPort = null
  let recordedServerPids = []
  let cleanupComplete = false
  let cleanupDiagnostics = []

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

  /**
   * The ordered teardown. Every step is verified, and the disposable database is removed **only**
   * once no owned server process can still have it open.
   */
  async function cleanup() {
    const diagnostics = []

    // 1. Electron test children first: they are the only thing still talking to the server.
    const suiteTermination = await terminateOwnedProcessGroup(suiteGroup)

    if (!suiteTermination.terminated) {
      diagnostics.push('electron suite process group survived termination')
    }

    // 2. The complete Laravel tree — artisan supervisor and its php -S grandchild alike.
    const serverTermination = await terminateOwnedProcessGroup(serverGroup)

    if (!serverTermination.terminated) {
      diagnostics.push('laravel server process group survived termination')
    }

    // 3. Every pid this run recorded for the server must be gone.
    for (const pid of recordedServerPids) {
      if (isProcessAlive(pid)) {
        diagnostics.push('a recorded laravel server process is still running')
        break
      }
    }

    // 4. The port must be rebindable, which also proves no listener survived.
    if (
      selectedPort !== null &&
      !(await waitUntil(() => loopbackPortIsFree(selectedPort), PORT_RELEASE_MS))
    ) {
      diagnostics.push('the selected loopback port was not released')
    }

    // 5/6. Only now is it safe to remove the database and its directory, and prove it is gone.
    if (diagnostics.length === 0) {
      disposeSandbox(exactGeneratedSandbox)
    } else {
      console.error('[cp3g5] retaining the temporary directory: a server may still hold it open')
    }

    // 7. Drop the references to this run's authorization material.
    nonce = null
    backendEnvironment.CP3G5_RUN_NONCE = ''

    if (serverTermination.escalated || suiteTermination.escalated) {
      console.log('[cp3g5] a process group required forced termination after SIGTERM')
    }

    cleanupDiagnostics = diagnostics

    return diagnostics
  }

  let signalled = false

  async function handleSignal(exitCode) {
    if (signalled) return

    signalled = true

    try {
      await cleanup()
    } catch {
      // Preserve a non-zero signal exit without exposing filesystem or child-process detail.
    }

    process.exit(exitCode)
  }

  process.once('SIGINT', () => void handleSignal(130))
  process.once('SIGTERM', () => void handleSignal(143))

  let testExitCode = 1

  try {
    // An opaque, per-run identity: enough for a repetition driver to prove that no two iterations
    // shared a sandbox or a database, without disclosing the sandbox path or the run nonce.
    const runIdentity = createHash('sha256').update(basename(exactGeneratedSandbox)).digest('hex').slice(0, 12)

    console.log(`[cp3g5] run identity ${runIdentity}`)
    console.log('[cp3g5] created an authorized disposable backend database')

    setPhase('migrate')

    const migrate = spawnSync('php', ['artisan', 'migrate', '--force', '--no-interaction'], {
      cwd: BACKEND_ROOT,
      env: backendEnvironment,
      encoding: 'utf8'
    })

    if (migrate.status !== 0) {
      sanitizedChildFailure('backend migration', migrate)
    }

    console.log('[cp3g5] backend migrations applied to the disposable database')

    setPhase('seed')

    const seed = spawnSync('php', [SEEDER, BACKEND_ROOT, String(PAYLOAD_COUNT)], {
      cwd: BACKEND_ROOT,
      env: backendEnvironment,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024
    })

    if (seed.status !== 0 || seed.stdout !== '' || !existsSync(fixturePath)) {
      sanitizedChildFailure('fixture seeding', seed)
    }

    if (
      (lstatSync(fixturePath).mode & 0o777) !== 0o600 ||
      lstatSync(fixturePath).isSymbolicLink()
    ) {
      fail('fixture seeding did not produce an owner-only response file')
    }

    console.log(`[cp3g5] minted ${PAYLOAD_COUNT} upload fixtures through private file IPC`)

    if (SEED_ONLY) {
      // The seeding stage is what this mode exists to exercise. Everything after it is skipped;
      // nothing before it, and nothing in cleanup, is skipped.
      console.log('[cp3g5] seed-only mode: fixture minted, skipping server and suite')
      testExitCode = 0

      throw new SeedOnlyComplete()
    }

    setPhase('server-start')

    // A per-run loopback port. No fixed port number is assumed anywhere in this harness, and a port
    // already in use is a reason to stop — never a reason to reclaim it from whoever holds it.
    selectedPort = await reserveLoopbackPort()

    if (!(await loopbackPortIsFree(selectedPort))) {
      fail('the selected loopback port was taken before the server started')
    }

    const serverArguments = [
      'artisan',
      'serve',
      '--host=127.0.0.1',
      `--port=${selectedPort}`,
      ...(FAULT === 'server-startup-failure' ? ['--cp3g5-invalid-option'] : [])
    ]

    serverGroup = startOwnedProcessGroup('php', serverArguments, {
      cwd: BACKEND_ROOT,
      env: backendEnvironment,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    // Drain and discard server output. Laravel errors can contain credentials or request context,
    // and unread pipes can eventually block the child process.
    serverGroup.child.stdout.on('data', () => {})
    serverGroup.child.stderr.on('data', () => {})
    serverGroup.child.on('error', () => {})

    const origin = `http://127.0.0.1:${selectedPort}`
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

    // The listener must belong to this run's own process group. Answering `/up` is not enough:
    // that is exactly what a stale orphan from an earlier run did while its database was gone.
    recordedServerPids = serverGroup.members()

    const inodes = listeningSocketInodes(selectedPort)
    const ownsListener = recordedServerPids.some((pid) => processOwnsSocketInode(pid, inodes))

    if (!ownsListener) {
      fail('the process answering on the selected port is not owned by this run')
    }

    console.log(`[cp3g5] live Laravel ready on ${origin}, owned by this run's process group`)

    if (FAULT === 'fail-after-ready') {
      fail('injected failure after the server became ready')
    }

    const suiteEnvironment = { ...process.env }
    delete suiteEnvironment.CP3G5_LIVE_HARNESS
    delete suiteEnvironment.CP3G5_TEMP_ROOT
    delete suiteEnvironment.CP3G5_RUN_NONCE
    delete suiteEnvironment.CP3G5_RESPONSE_FILE

    const suiteCommand =
      FAULT === 'suite-hang'
        ? [process.execPath, ['-e', 'setInterval(() => {}, 1000)']]
        : [
            process.execPath,
            [
              join(DESKTOP_ROOT, 'scripts', 'runElectronNode.mjs'),
              FAULT === 'suite-failure'
                ? join('tests', 'electron', 'cp3g5-missing-entry.ts')
                : join('tests', 'electron', 'index.ts')
            ]
          ]

    setPhase('electron-run')

    suiteGroup = startOwnedProcessGroup(suiteCommand[0], suiteCommand[1], {
      cwd: DESKTOP_ROOT,
      env: {
        ...suiteEnvironment,
        CP3G5_FIXTURE: fixturePath,
        CP3G5_API_ORIGIN: origin,
        CP3G5_BACKEND_DB: databasePath
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    // Drained and discarded, exactly as before: suite output can carry request context, and an
    // unread pipe can eventually block the child.
    suiteGroup.child.stdout.on('data', () => {})
    suiteGroup.child.stderr.on('data', () => {})

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      void terminateOwnedProcessGroup(suiteGroup)
    }, SUITE_TIMEOUT_MS)
    const suite = await suiteGroup.exited
    clearTimeout(timer)

    if (timedOut) {
      fail('the Electron SQLite suite exceeded its time budget and was terminated')
    }

    if (suite.code !== 0) {
      sanitizedChildFailure('Electron SQLite suite', { status: suite.code })
    }

    console.log('[cp3g5] Electron SQLite live suite passed')
    testExitCode = 0
  } catch (error) {
    if (error instanceof SeedOnlyComplete) {
      // Not a failure: the seed-only path reached its end and jumped straight to cleanup.
      testExitCode = 0
    } else {
      const message = error instanceof HarnessFailure ? error.message : 'unexpected harness failure'

      if (!(error instanceof HarnessFailure)) {
        recordDiagnostic({ code: 'unexpected-harness-failure' })
      }

      console.error(`[cp3g5] ${message}`)
      testExitCode = 1
    }
  }

  try {
    setPhase('cleanup')
    await cleanup()
  } catch {
    cleanupDiagnostics = ['cleanup failed closed']
  }

  if (cleanupDiagnostics.length > 0) {
    // Reported in its own right: a cleanup failure is never folded into a test failure.
    for (const diagnostic of cleanupDiagnostics) {
      console.error(`[cp3g5] cleanup failure: ${diagnostic}`)
    }

    if (testExitCode !== 0) {
      console.error('[cp3g5] the run also failed before cleanup')
    }

    return 2
  }

  return testExitCode
}

/* c8 ignore start */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
/* c8 ignore stop */
