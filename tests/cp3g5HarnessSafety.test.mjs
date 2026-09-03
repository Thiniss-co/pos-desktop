/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(HERE, '..')
const SEEDER = join(PROJECT_ROOT, 'tests/electron/support/cp3g5/seedLiveBackend.php')
const WRAPPER = join(PROJECT_ROOT, 'scripts/cp3g5LiveUpload.mjs')
const BACKEND_ROOT = resolve(PROJECT_ROOT, '..', 'pos-backend')
const TEMP_ROOT = realpathSync(tmpdir())
const TOKEN_SENTINEL = 'token-sentinel-must-never-appear'
const GUARDED_ENVIRONMENT = [
  'APP_CONFIG_CACHE',
  'APP_ENV',
  'CP3G5_DIAGNOSTICS',
  'CP3G5_LIVE_HARNESS',
  'CP3G5_RESPONSE_FILE',
  'CP3G5_RUN_NONCE',
  'CP3G5_TEMP_ROOT',
  'DB_CONNECTION',
  'DB_DATABASE',
  'DB_URL'
]

function cleanEnvironment() {
  const environment = { ...process.env }

  for (const name of GUARDED_ENVIRONMENT) delete environment[name]

  return environment
}

function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function createFakeBackend() {
  const root = mkdtempSync(join(TEMP_ROOT, 'cp3g5-fake-backend-'))
  const canary = join(root, 'autoload-was-executed')
  mkdirSync(join(root, 'vendor'))
  mkdirSync(join(root, 'bootstrap'))
  writeFileSync(
    join(root, 'vendor/autoload.php'),
    `<?php file_put_contents(${JSON.stringify(canary)}, 'loaded');\n`
  )
  writeFileSync(join(root, 'bootstrap/app.php'), '<?php throw new RuntimeException("loaded");\n')

  return { canary, root }
}

function createAuthorizedRun() {
  const root = mkdtempSync(join(TEMP_ROOT, 'pos-desktop-cp3g5-'))
  const nonce = randomBytes(32).toString('hex')
  const database = join(root, 'cp3g5-backend.sqlite')
  const marker = join(root, '.cp3g5-harness')
  const response = join(root, 'cp3g5-fixture.json')
  writeFileSync(database, 'unchanged-database-sentinel', { mode: 0o600 })
  writeFileSync(marker, `${nonce}\n`, { mode: 0o600 })
  chmodSync(marker, 0o600)

  return {
    database,
    marker,
    nonce,
    response,
    root,
    environment: {
      ...cleanEnvironment(),
      APP_ENV: 'testing',
      CP3G5_LIVE_HARNESS: '1',
      CP3G5_RESPONSE_FILE: response,
      CP3G5_RUN_NONCE: nonce,
      CP3G5_TEMP_ROOT: root,
      DB_CONNECTION: 'sqlite',
      DB_DATABASE: database
    }
  }
}

function runSeeder(run, overrides = {}, backendRoot) {
  const fakeBackend = backendRoot ? null : createFakeBackend()
  const selectedBackend = backendRoot ?? fakeBackend.root
  const before =
    existsSync(run.database) && !readFileSync(run.database).includes(0)
      ? digest(run.database)
      : null
  const environment = { ...run.environment, ...overrides }

  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) delete environment[name]
  }

  const result = spawnSync('php', [SEEDER, selectedBackend, '12'], {
    cwd: PROJECT_ROOT,
    env: environment,
    encoding: 'utf8'
  })
  const after = before && existsSync(run.database) ? digest(run.database) : before

  return { after, before, fakeBackend, result }
}

function assertRejected(execution) {
  assert.notEqual(execution.result.status, 0)
  assert.equal(execution.result.stdout, '')
  assert.match(execution.result.stderr, /^CP-3G-5 seeder rejected: [A-Za-z -]+\n$/)
  assert.doesNotMatch(execution.result.stderr, /(?:token|Bearer|Stack trace|#0|\.php:\d)/i)
  assert.equal(execution.after, execution.before)

  if (execution.fakeBackend) assert.equal(existsSync(execution.fakeBackend.canary), false)
}

function removeRun(run, execution) {
  if (execution?.fakeBackend) rmSync(execution.fakeBackend.root, { recursive: true, force: true })
  rmSync(run.root, { recursive: true, force: true })
}

function rejectedCase(name, mutate) {
  test(name, () => {
    const run = createAuthorizedRun()
    let execution

    try {
      const overrides = mutate(run) ?? {}
      execution = runSeeder(run, overrides)
      assertRejected(execution)
      assert.equal(existsSync(run.response), false)
    } finally {
      removeRun(run, execution)
    }
  })
}

rejectedCase('rejects execution without the dedicated environment marker', () => ({
  CP3G5_LIVE_HARNESS: undefined
}))

rejectedCase('rejects the normal MySQL connection before bootstrap', () => ({
  DB_CONNECTION: 'mysql',
  DB_DATABASE: 'thinis_pos'
}))

rejectedCase('rejects the backend default connection before bootstrap', () => ({
  DB_CONNECTION: undefined
}))

rejectedCase('rejects a relative SQLite database path', () => ({ DB_DATABASE: 'relative.sqlite' }))

rejectedCase('rejects a SQLite database outside the authorized root', () => {
  const outside = join(TEMP_ROOT, `cp3g5-outside-${randomBytes(8).toString('hex')}.sqlite`)
  writeFileSync(outside, 'outside')
  rmSync(outside)
  return { DB_DATABASE: outside }
})

rejectedCase('rejects an in-memory SQLite database', () => ({ DB_DATABASE: ':memory:' }))

rejectedCase('rejects a missing nonce', () => ({ CP3G5_RUN_NONCE: undefined }))

rejectedCase('rejects an incorrect nonce without exposing marker content', (run) => {
  writeFileSync(run.marker, `${TOKEN_SENTINEL}\n`)
  chmodSync(run.marker, 0o600)
  return {}
})

rejectedCase('rejects a missing marker file', (run) => {
  rmSync(run.marker)
  return {}
})

rejectedCase('rejects a symlinked database path', (run) => {
  const target = join(run.root, 'symlink-target.sqlite')
  rmSync(run.database)
  writeFileSync(target, 'unchanged-database-sentinel')
  symlinkSync(target, run.database)
  return {}
})

rejectedCase('rejects lexical path traversal even when it resolves inside the root', (run) => {
  const nested = join(run.root, 'nested')
  mkdirSync(nested)
  return { DB_DATABASE: `${nested}/../cp3g5-backend.sqlite` }
})

rejectedCase('rejects a non-CP-3G-5 database filename', (run) => {
  const wrongName = join(run.root, 'backend.sqlite')
  writeFileSync(wrongName, 'outside')
  return { DB_DATABASE: wrongName }
})

test('the exact incident command now fails before Laravel bootstrap', () => {
  const result = spawnSync('php', [SEEDER, BACKEND_ROOT, '12'], {
    cwd: PROJECT_ROOT,
    env: cleanEnvironment(),
    encoding: 'utf8'
  })

  assert.notEqual(result.status, 0)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'CP-3G-5 seeder rejected: authorization marker missing\n')
})

test('post-bootstrap validation rejects a DB_URL override without writes or secret output', () => {
  const run = createAuthorizedRun()
  let execution

  try {
    const outside = join(TEMP_ROOT, `${TOKEN_SENTINEL}.sqlite`)
    writeFileSync(outside, '')
    execution = runSeeder(run, { DB_URL: `sqlite:///${outside}` }, BACKEND_ROOT)
    assertRejected(execution)
    assert.equal(existsSync(run.response), false)
    rmSync(outside, { force: true })
  } finally {
    removeRun(run, execution)
  }
})

test('wrapper redacts child output and removes its sandbox on a seeded failure', () => {
  const before = new Set(
    readdirSync(TEMP_ROOT).filter((name) => name.startsWith('pos-desktop-cp3g5-'))
  )
  const result = spawnSync(process.execPath, [WRAPPER], {
    cwd: PROJECT_ROOT,
    env: {
      ...cleanEnvironment(),
      CP3G5_BACKEND_ROOT: BACKEND_ROOT,
      CP3G5_PAYLOADS: '0',
      DB_URL: `sqlite:///${TOKEN_SENTINEL}`
    },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  })
  const after = new Set(
    readdirSync(TEMP_ROOT).filter((name) => name.startsWith('pos-desktop-cp3g5-'))
  )

  assert.notEqual(result.status, 0)
  assert.deepEqual(after, before)
  assert.match(result.stdout, /temporary directory removed and verified absent/)
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(TOKEN_SENTINEL, 'i'))
  assert.doesNotMatch(
    `${result.stdout}${result.stderr}`,
    /(?:plainTextToken|Bearer|Stack trace|#0)/i
  )
})
