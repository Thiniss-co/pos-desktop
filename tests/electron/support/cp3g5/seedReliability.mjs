#!/usr/bin/env node
/**
 * CP-3G-7 F2 — bounded reproduction / reliability driver for the authorized live harness.
 *
 * This driver never touches the seeder, the sandbox, the nonce or the database itself. It only
 * spawns `scripts/cp3g5LiveUpload.mjs` — the one authorized entry point — a bounded number of
 * times and reads its already-sanitized stdout/stderr. Every guarantee the wrapper makes therefore
 * still holds for every iteration: its own mkdtemp directory, its own nonce, its own SQLite file,
 * its own result file, its own port, and its own complete cleanup.
 *
 * Two modes:
 *
 *   CP3G5_SEED_ONLY=1  — exercise sandbox → migrate → seed → fixture-write → cleanup (fast).
 *   full               — the complete live gate, server and Electron suite included.
 *
 * It lives beside the seeder, inside `tests/electron/support/cp3g5/`, because that directory is
 * already excluded from packaged output by `!tests/electron/support/cp3g5/**`. Putting it here
 * keeps a new harness asset out of `app.asar` without touching `electron-builder.yml`, which the
 * open F1 packaging finding still owns.
 *
 * Usage:
 *   node tests/electron/support/cp3g5/seedReliability.mjs --iterations 50 [--seed-only]
 *        [--stop-on-failure] [--payloads 21] [--log <path>]
 *
 * It is bounded by construction: `--iterations` is required to be a positive integer no greater
 * than MAX_ITERATIONS, and the loop has no other exit path.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(HERE, '..', '..', '..', '..')
const WRAPPER = join(PROJECT_ROOT, 'scripts', 'cp3g5LiveUpload.mjs')
const SANDBOX_PREFIX = 'pos-desktop-cp3g5-'
const ELECTRON_TEMP_PREFIX = 'pos-desktop-electron-node-'
const MAX_ITERATIONS = 500

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name)

  return index === -1 || index + 1 >= process.argv.length ? fallback : process.argv[index + 1]
}

const iterations = Number(argument('--iterations', '0'))
const seedOnly = process.argv.includes('--seed-only')
const stopOnFailure = process.argv.includes('--stop-on-failure')
const payloads = argument('--payloads', '21')
const logPath = argument('--log', null)

if (!Number.isInteger(iterations) || iterations < 1 || iterations > MAX_ITERATIONS) {
  console.error(`[cp3g5-reliability] --iterations must be an integer in 1..${MAX_ITERATIONS}`)
  process.exit(2)
}

/** Anything matching the harness's own temporary-name shapes, left behind by anyone. */
function strayTemporaryDirectories() {
  return readdirSync(tmpdir()).filter(
    (entry) => entry.startsWith(SANDBOX_PREFIX) || entry.startsWith(ELECTRON_TEMP_PREFIX)
  )
}

const DIAGNOSTIC_LINE = /\[cp3g5\] diagnostic (\{[^\n]*\})/g
const IDENTITY_LINE = /\[cp3g5\] run identity ([0-9a-f]{12})/
const PORT_LINE = /ready on http:\/\/127\.0\.0\.1:(\d+)/

if (!existsSync(WRAPPER)) {
  console.error('[cp3g5-reliability] the authorized wrapper is missing')
  process.exit(2)
}

const strayBefore = strayTemporaryDirectories()

if (strayBefore.length > 0) {
  console.error(`[cp3g5-reliability] refusing to start: ${strayBefore.length} pre-existing harness temporary directories`)
  process.exit(2)
}

const results = []
const identities = new Set()
const ports = new Set()
let passed = 0
let failed = 0
let duplicateIdentity = false
let duplicatePort = false
let leftovers = 0

for (let iteration = 1; iteration <= iterations; iteration++) {
  const started = Date.now()
  const run = spawnSync(process.execPath, [WRAPPER], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      CP3G5_PAYLOADS: String(payloads),
      ...(seedOnly ? { CP3G5_SEED_ONLY: '1' } : {})
    }
  })

  const stdout = run.stdout ?? ''
  const stderr = run.stderr ?? ''
  const diagnostics = [...stderr.matchAll(DIAGNOSTIC_LINE)].flatMap((match) => {
    try {
      return [JSON.parse(match[1])]
    } catch {
      return []
    }
  })

  const identity = IDENTITY_LINE.exec(stdout)?.[1] ?? null
  const port = PORT_LINE.exec(stdout)?.[1] ?? null

  if (identity !== null) {
    if (identities.has(identity)) duplicateIdentity = true

    identities.add(identity)
  }

  if (port !== null) {
    if (ports.has(port)) duplicatePort = true

    ports.add(port)
  }

  // A leftover here is attributable to the iteration that just ended: the driver refused to start
  // with any pre-existing directory, and it checks after every single run.
  const stray = strayTemporaryDirectories()

  if (stray.length > 0) leftovers += stray.length

  const record = {
    iteration,
    exit: run.status,
    signal: run.signal ?? null,
    identity,
    port,
    durationMs: Date.now() - started,
    diagnostics,
    strayAfter: stray.length
  }

  results.push(record)

  if (run.status === 0) {
    passed += 1
  } else {
    failed += 1
  }

  const summary = diagnostics
    .map((entry) => [entry.phase, entry.operation, entry.code, entry.exception, entry.sqlstate, entry.identifier]
      .filter(Boolean)
      .join('/'))
    .join(' | ')

  console.log(
    `[cp3g5-reliability] ${iteration}/${iterations} exit=${run.status} identity=${identity ?? '-'}` +
      `${port ? ` port=${port}` : ''} stray=${stray.length}${summary ? ` :: ${summary}` : ''}`
  )

  if (logPath !== null) appendFileSync(logPath, `${JSON.stringify(record)}\n`, 'utf8')

  if (run.status !== 0 && stopOnFailure) {
    console.log('[cp3g5-reliability] stopping on first failure, as requested')
    break
  }
}

const executed = results.length

console.log('')
console.log(`[cp3g5-reliability] mode                : ${seedOnly ? 'seed-only' : 'full live'}`)
console.log(`[cp3g5-reliability] iterations executed : ${executed}`)
console.log(`[cp3g5-reliability] passed              : ${passed}`)
console.log(`[cp3g5-reliability] failed              : ${failed}`)
console.log(`[cp3g5-reliability] unique identities   : ${identities.size} (duplicate: ${duplicateIdentity})`)
console.log(`[cp3g5-reliability] unique ports        : ${ports.size} (duplicate: ${duplicatePort})`)
console.log(`[cp3g5-reliability] leftover temp dirs  : ${leftovers}`)

const clean =
  failed === 0 &&
  leftovers === 0 &&
  !duplicateIdentity &&
  !duplicatePort &&
  identities.size === executed

console.log(`[cp3g5-reliability] verdict             : ${clean ? 'PASS' : 'FAIL'}`)

process.exit(clean ? 0 : 1)
