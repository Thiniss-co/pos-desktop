/* eslint-disable @typescript-eslint/explicit-function-return-type */
/**
 * Refusal coverage for `tests/electron/support/sandbox/laravelSandboxGuard.php`.
 *
 * Every case runs against a FAKE backend whose autoloader writes a canary file. A refusal must
 * happen before that autoloader runs, so no case can reach Laravel, a `.env`, MySQL or any business
 * database — the refusal is verified without connecting to anything.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(HERE, '..')
const SANDBOX_DIR = join(PROJECT_ROOT, 'tests/electron/support/sandbox')
const GUARDED_ARTISAN = join(SANDBOX_DIR, 'guardedArtisan.php')
const GUI_FIXTURE = join(SANDBOX_DIR, 'guiFixture.php')
const TEMP_ROOT = realpathSync(tmpdir())
const SELECTION = [
  'APP_CONFIG_CACHE',
  'APP_ENV',
  'DB_CONNECTION',
  'DB_DATABASE',
  'DB_URL',
  'POS_SANDBOX_EXPECTED_DB'
]

function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function createFakeBackend() {
  const root = mkdtempSync(join(TEMP_ROOT, 'sandbox-guard-backend-'))
  const canary = join(root, 'autoload-was-executed')
  mkdirSync(join(root, 'vendor'))
  mkdirSync(join(root, 'bootstrap'))
  writeFileSync(join(root, 'artisan'), '<?php\n')
  writeFileSync(
    join(root, 'vendor/autoload.php'),
    `<?php file_put_contents(${JSON.stringify(canary)}, 'loaded');\n`
  )
  writeFileSync(join(root, 'bootstrap/app.php'), '<?php throw new RuntimeException("loaded");\n')

  return { canary, root }
}

function createSandbox(name = 'gui-backend.sqlite') {
  const root = mkdtempSync(join(TEMP_ROOT, 'sandbox-guard-run-'))
  const database = join(root, name)
  writeFileSync(database, 'unchanged-database-sentinel', { mode: 0o600 })

  return { root, database, configCache: join(root, 'laravel-config-cache.php') }
}

function approvedEnvironment(sandbox) {
  const environment = { ...process.env }

  for (const name of SELECTION) delete environment[name]

  return {
    ...environment,
    APP_ENV: 'testing',
    DB_CONNECTION: 'sqlite',
    DB_DATABASE: sandbox.database,
    POS_SANDBOX_EXPECTED_DB: sandbox.database,
    APP_CONFIG_CACHE: sandbox.configCache
  }
}

function run(script, args, environment, backend) {
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) delete environment[name]
  }

  return spawnSync('php', [script, backend.root, ...args], {
    cwd: PROJECT_ROOT,
    env: environment,
    encoding: 'utf8'
  })
}

function assertRefused(result, reason, backend, sandbox, before) {
  assert.equal(result.status, 3, result.stderr)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, new RegExp(`^sandbox guard refused: ${reason}\\n$`))
  assert.equal(existsSync(backend.canary), false, 'Laravel must never have been loaded')

  if (sandbox && before) assert.equal(digest(sandbox.database), before)
}

function refusalCase(name, reason, prepare, { script = GUARDED_ARTISAN, args = ['migrate'] } = {}) {
  test(name, () => {
    const backend = createFakeBackend()
    const sandbox = createSandbox()
    const before = digest(sandbox.database)

    try {
      const environment = approvedEnvironment(sandbox)
      prepare(environment, sandbox)
      assertRefused(run(script, args, environment, backend), reason, backend, sandbox, before)
    } finally {
      rmSync(backend.root, { recursive: true, force: true })
      rmSync(sandbox.root, { recursive: true, force: true })
    }
  })
}

refusalCase(
  'refuses when no environment selection exists at all',
  'POS_SANDBOX_EXPECTED_DB is not set',
  (environment) => {
    for (const name of SELECTION) environment[name] = undefined
  }
)

refusalCase(
  'refuses when the expected database is absent',
  'POS_SANDBOX_EXPECTED_DB is not set',
  (environment) => {
    environment.POS_SANDBOX_EXPECTED_DB = undefined
  }
)

refusalCase('refuses a non-testing environment', 'APP_ENV is not testing', (environment) => {
  environment.APP_ENV = 'local'
})

refusalCase('refuses a MySQL connection', 'DB_CONNECTION is not sqlite', (environment) => {
  environment.DB_CONNECTION = 'mysql'
})

refusalCase(
  'refuses a DB_URL override',
  'DB_URL is set and would override the selected database',
  (environment) => {
    environment.DB_URL = 'mysql://root@127.0.0.1/thinis_pos'
  }
)

refusalCase(
  'refuses the thinis_pos business database by name',
  'the selected database is a business database',
  (environment) => {
    environment.DB_DATABASE = 'thinis_pos'
  }
)

refusalCase(
  'refuses the thinis_pos_testing database by name',
  'the selected database is a business database',
  (environment) => {
    environment.DB_DATABASE = 'thinis_pos_testing'
    environment.POS_SANDBOX_EXPECTED_DB = 'thinis_pos_testing'
  }
)

test('refuses a sandbox file whose stem is a business database name', () => {
  const backend = createFakeBackend()
  const sandbox = createSandbox('thinis_pos_testing.sqlite')
  const before = digest(sandbox.database)

  try {
    assertRefused(
      run(GUARDED_ARTISAN, ['migrate'], approvedEnvironment(sandbox), backend),
      'the selected database is a business database',
      backend,
      sandbox,
      before
    )
  } finally {
    rmSync(backend.root, { recursive: true, force: true })
    rmSync(sandbox.root, { recursive: true, force: true })
  }
})

refusalCase(
  'refuses a DB_DATABASE that differs from the approved file',
  'DB_DATABASE does not match the approved sandbox database',
  (environment, sandbox) => {
    const other = join(sandbox.root, 'other.sqlite')
    writeFileSync(other, '')
    environment.DB_DATABASE = other
  }
)

refusalCase(
  'refuses a database inside the backend repository',
  'the approved sandbox database is outside the system temporary directory',
  (environment) => {
    const repositoryDatabase = resolve(
      PROJECT_ROOT,
      '..',
      'pos-backend',
      'database',
      'database.sqlite'
    )
    environment.DB_DATABASE = repositoryDatabase
    environment.POS_SANDBOX_EXPECTED_DB = repositoryDatabase
  }
)

refusalCase(
  'refuses a database under the real workstation profile',
  'the approved sandbox database is outside the system temporary directory',
  (environment) => {
    const profileDatabase = join(homedir(), '.config', 'pos-desktop', 'pos-desktop.sqlite')
    environment.DB_DATABASE = profileDatabase
    environment.POS_SANDBOX_EXPECTED_DB = profileDatabase
  }
)

refusalCase(
  'refuses a symlinked sandbox database',
  'the approved sandbox database is not an existing regular file',
  (environment, sandbox) => {
    const link = join(sandbox.root, 'link.sqlite')
    symlinkSync(sandbox.database, link)
    environment.DB_DATABASE = link
    environment.POS_SANDBOX_EXPECTED_DB = link
  }
)

refusalCase(
  'refuses when no isolated config cache is named',
  'APP_CONFIG_CACHE must name an isolated file inside the sandbox',
  (environment) => {
    environment.APP_CONFIG_CACHE = undefined
  }
)

refusalCase(
  'refuses a config cache outside the sandbox',
  'APP_CONFIG_CACHE is not inside the sandbox directory',
  (environment) => {
    environment.APP_CONFIG_CACHE = resolve(
      PROJECT_ROOT,
      '..',
      'pos-backend',
      'bootstrap',
      'cache',
      'config.php'
    )
  }
)

refusalCase(
  'refuses when a cached configuration already exists',
  'a Laravel configuration cache exists in the sandbox',
  (_environment, sandbox) => {
    writeFileSync(sandbox.configCache, '<?php return [];\n')
  }
)

refusalCase(
  'refuses an artisan command outside the whitelist',
  'the command is not on the guarded whitelist',
  () => {},
  { args: ['migrate:fresh'] }
)

refusalCase(
  'refuses db:seed without a seeder class',
  'db:seed needs one seeder class name',
  () => {},
  { args: ['db:seed', '--class=Anything'] }
)

refusalCase(
  'the GUI fixture refuses a mismatched selection the same way',
  'DB_DATABASE does not match the approved sandbox database',
  (environment) => {
    environment.DB_DATABASE = '/tmp/does-not-matter.sqlite'
  },
  { script: GUI_FIXTURE, args: ['mode-physical-presence'] }
)
