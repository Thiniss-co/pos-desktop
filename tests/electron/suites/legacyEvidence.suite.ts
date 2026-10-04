import { equal, ok } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import { licenseStatusFixture } from '../../../src/main/testing/fixtures/licenseStatus.fixture'
import { databaseTest } from '../support/sandbox'
import { openTestDatabase } from '../support/openTestDatabase'
import { failingDatabase } from '../support/failingDatabase'
import { realRepositories } from '../support/realRepositories'
import { claimStuckAttempt, setUpAuthorizedContext, validIntent } from '../support/localSaleFixture'

/**
 * Rev 4 §9 (Rule L), on real SQLite: a claimed attempt with `dispatch_evidence='unknown'` (claimed by
 * a build that recorded no dispatch evidence — what migration 0016 writes for such rows; produced
 * here with the same UPDATE, a named simulation of that precondition) must keep its frozen intent
 * on EVERY reachable path until the explicit acknowledgement-cancel records the uncertainty.
 */

const KEY = 'bbbbbbbb-0000-4000-8000-000000000001'
const VALID = '2026-01-01T02:00:00.000Z'
const AFTER_EXPIRY = '2026-01-04T00:00:01.000Z'

interface AttemptRow {
  state: string
  intent_json: string | null
  failure_code: string | null
}

function attemptRow(database: ReturnType<typeof openTestDatabase>): AttemptRow {
  return database
    .prepare('SELECT state, intent_json, failure_code FROM sale_attempts WHERE attempt_key = ?')
    .get(KEY) as AttemptRow
}

/** Keeps the license boundary out of the way so only the catalog window is crossed. */
function keepLicenseValid(repositories: ReturnType<typeof realRepositories>): void {
  repositories.licenseMetadata.setValidatedStatus(
    { ...licenseStatusFixture(), nextValidationDueAt: '2026-01-10T00:00:00+00:00' },
    '2026-01-01T00:00:00Z'
  )
}

interface LegacySetUp {
  readonly database: ReturnType<typeof openTestDatabase>
  readonly repositories: ReturnType<typeof realRepositories>
  readonly fixture: ReturnType<typeof setUpAuthorizedContext>
  readonly frozen: string
  readonly setNow: (iso: string) => void
}

function setUp(sandbox: Parameters<Parameters<typeof databaseTest>[1]>[0]): LegacySetUp {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  let now = VALID
  const fixture = setUpAuthorizedContext(database, repositories, () => new Date(now))
  keepLicenseValid(repositories)
  claimStuckAttempt(repositories, fixture.authority, KEY, validIntent())
  database
    .prepare("UPDATE sale_attempts SET dispatch_evidence = 'unknown' WHERE attempt_key = ?")
    .run(KEY)
  const frozen = attemptRow(database).intent_json
  ok(frozen, 'the legacy attempt carries its intent')
  return {
    database,
    repositories,
    fixture,
    frozen,
    setNow: (iso: string) => {
      now = iso
    }
  }
}

databaseTest(
  'a legacy attempt retried on a stale catalog keeps its intent (not rejected)',
  (sandbox) => {
    const s = setUp(sandbox)
    s.setNow(AFTER_EXPIRY)

    const outcome = s.fixture.localSale.retry(KEY)

    equal(outcome.outcome, 'failed')
    equal((outcome as { code: string }).code, 'legacy-uncertainty-unresolved')
    const row = attemptRow(s.database)
    equal(row.state, 'claimed')
    equal(row.intent_json, s.frozen, 'frozen intent byte-identical')
    closeDatabase(s.database)
  }
)

databaseTest(
  'a legacy attempt whose transaction throws (invariant) keeps its intent',
  (sandbox) => {
    const s = setUp(sandbox)
    const failing = s.fixture.withWriteDatabase(
      failingDatabase(s.database, { failOnWriteNumber: 3 })
    )

    const outcome = failing.retry(KEY)

    equal(outcome.outcome, 'failed')
    equal((outcome as { code: string }).code, 'legacy-uncertainty-unresolved')
    equal(attemptRow(s.database).state, 'claimed')
    equal(attemptRow(s.database).intent_json, s.frozen)
    closeDatabase(s.database)
  }
)

databaseTest('a legacy attempt survives restart with its intent and is re-surfaced', (sandbox) => {
  const s = setUp(sandbox)
  s.setNow(AFTER_EXPIRY)
  s.fixture.localSale.retry(KEY)

  // A "restart": a fresh service over the same database.
  const restarted = setUpAuthorizedContext(
    s.database,
    s.repositories,
    () => new Date(AFTER_EXPIRY),
    'online',
    false
  )
  const pending = restarted.localSale.pendingAttempts()
  equal(attemptRow(s.database).state, 'claimed')
  equal(attemptRow(s.database).intent_json, s.frozen)
  equal(pending.blockingAttempt?.attemptKey, KEY, 're-surfaced as the blocking attempt')
  equal(pending.blockingAttempt?.dispatchEvidence, 'unknown')
  closeDatabase(s.database)
})

databaseTest(
  'acknowledgement-cancel records the uncertainty verbatim, then abandons',
  (sandbox) => {
    const s = setUp(sandbox)
    s.setNow(AFTER_EXPIRY)
    s.fixture.localSale.retry(KEY)

    const refused = s.fixture.localSale.abandon(KEY)
    equal((refused as { code?: string }).code, 'legacy-uncertainty-acknowledgement-required')
    equal(attemptRow(s.database).intent_json, s.frozen)

    const cancelled = s.fixture.localSale.abandon(KEY, { acknowledgeLegacyUncertainty: true })
    equal(cancelled.outcome, 'abandoned')
    const uncertainty = s.database
      .prepare('SELECT * FROM legacy_dispatch_uncertainties WHERE attempt_key = ?')
      .get(KEY) as Record<string, unknown> | undefined
    ok(uncertainty, 'the uncertainty was recorded before the intent was cleared')
    equal(attemptRow(s.database).state, 'abandoned')
    closeDatabase(s.database)
  }
)

databaseTest('a recorded-evidence attempt keeps the existing terminal rule', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  let now = VALID
  const fixture = setUpAuthorizedContext(database, repositories, () => new Date(now))
  keepLicenseValid(repositories)
  claimStuckAttempt(repositories, fixture.authority, KEY, validIntent())
  now = AFTER_EXPIRY

  const outcome = fixture.localSale.retry(KEY)

  equal(outcome.outcome, 'rejected')
  equal((outcome as { failureCode: string }).failureCode, 'catalog-superseded')
  equal(attemptRow(database).state, 'rejected')
  closeDatabase(database)
})
