import { equal } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import { AttemptSettlementService } from '../../../src/main/services/attemptSettlement.service'
import { licenseStatusFixture } from '../../../src/main/testing/fixtures/licenseStatus.fixture'
import { databaseTest } from '../support/sandbox'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories, type RealRepositories } from '../support/realRepositories'
import {
  claimStuckAttempt,
  companyUuid,
  deviceUuid,
  setUpAuthorizedContext,
  trackedProductUuid,
  userUuid,
  validIntent,
  warehouseUuid
} from '../support/localSaleFixture'

/**
 * Rev 4 §9.1 on real SQLite: main settles ONLY a provably superseded, recorded-evidence claim —
 * through the same transition a retry would take — and never a legacy one, a still-committable
 * one, an in-flight one, or anything committed. Dispatch evidence rows are never touched.
 */

const KEY = 'cccccccc-0000-4000-8000-000000000001'
const VALID = '2026-01-01T02:00:00.000Z'
const AFTER_EXPIRY = '2026-01-04T00:00:01.000Z'

interface Built {
  readonly database: ReturnType<typeof openTestDatabase>
  readonly repositories: RealRepositories
  readonly service: AttemptSettlementService
  readonly settled: string[]
  readonly setNow: (iso: string) => string
  readonly setInFlight: (value: boolean) => boolean
}

interface AttemptRow {
  state: string
  failure_code: string | null
  intent_json: string | null
}

function build(sandbox: Parameters<Parameters<typeof databaseTest>[1]>[0]): Built {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  let now = VALID
  const fixture = setUpAuthorizedContext(database, repositories, () => new Date(now))
  repositories.licenseMetadata.setValidatedStatus(
    { ...licenseStatusFixture(), nextValidationDueAt: '2026-01-10T00:00:00+00:00' },
    '2026-01-01T00:00:00Z'
  )
  claimStuckAttempt(repositories, fixture.authority, KEY, validIntent())
  let inFlight = false
  const settled: string[] = []
  const service = new AttemptSettlementService({
    database,
    saleAttempts: repositories.saleAttempts,
    owner: () => ({ companyUuid, deviceUuid, userUuid }),
    catalog: fixture.catalog,
    completionInFlight: () => inFlight,
    now: () => new Date(now),
    onSettled: (result) => settled.push(result)
  })
  return {
    database,
    repositories,
    service,
    settled,
    setNow: (iso: string) => (now = iso),
    setInFlight: (value: boolean) => (inFlight = value)
  }
}

function row(database: ReturnType<typeof openTestDatabase>): AttemptRow {
  return database
    .prepare('SELECT state, failure_code, intent_json FROM sale_attempts WHERE attempt_key = ?')
    .get(KEY) as AttemptRow
}

function recordDispatch(repositories: RealRepositories): void {
  repositories.allocationDispatches.insertForClaimedAttempt({
    attemptKey: KEY,
    owner: { companyUuid, deviceUuid, warehouseUuid, actorUserUuid: userUuid },
    body: {
      idempotency_key: 'd'.repeat(64),
      allocation_payload_version: 2,
      items: [{ product_uuid: trackedProductUuid, quantity: '1.000' }]
    },
    createdAt: VALID
  })
}

databaseTest('a still-committable claim is left alone', (sandbox) => {
  const s = build(sandbox)
  equal(s.service.settleSuperseded(), 'none')
  equal(row(s.database).state, 'claimed')
  equal(s.settled.length, 0)
  closeDatabase(s.database)
})

databaseTest(
  'a superseded recorded-evidence claim settles as catalog-superseded; dispatch rows untouched',
  (sandbox) => {
    const s = build(sandbox)
    recordDispatch(s.repositories)
    const dispatchBefore = s.database
      .prepare('SELECT idempotency_key, state, request_hash FROM attempt_allocation_dispatches')
      .all()
    s.setNow(AFTER_EXPIRY)

    equal(s.service.settleSuperseded(), 'settled')

    const settledRow = row(s.database)
    equal(settledRow.state, 'rejected')
    equal(settledRow.failure_code, 'catalog-superseded')
    equal(
      JSON.stringify(
        s.database
          .prepare('SELECT idempotency_key, state, request_hash FROM attempt_allocation_dispatches')
          .all()
      ),
      JSON.stringify(dispatchBefore)
    )
    equal(s.settled[0], 'settled')
    closeDatabase(s.database)
  }
)

databaseTest('a superseded legacy (unknown-evidence) claim is never rejected', (sandbox) => {
  const s = build(sandbox)
  s.database
    .prepare("UPDATE sale_attempts SET dispatch_evidence = 'unknown' WHERE attempt_key = ?")
    .run(KEY)
  const frozen = row(s.database).intent_json
  s.setNow(AFTER_EXPIRY)

  equal(s.service.settleSuperseded(), 'legacy-unresolved')
  equal(row(s.database).state, 'claimed')
  equal(row(s.database).intent_json, frozen)
  closeDatabase(s.database)
})

databaseTest('a completion in flight is skipped', (sandbox) => {
  const s = build(sandbox)
  s.setNow(AFTER_EXPIRY)
  s.setInFlight(true)
  equal(s.service.settleSuperseded(), 'in-flight')
  equal(row(s.database).state, 'claimed')
  closeDatabase(s.database)
})

databaseTest('committed attempts are never settled', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  let now = VALID
  const fixture = setUpAuthorizedContext(database, repositories, () => new Date(now))
  const committed = fixture.localSale.complete(
    'cccccccc-0000-4000-8000-000000000002',
    validIntent()
  )
  equal(committed.outcome, 'committed')
  const payloadBefore = database.prepare('SELECT payload_json, payload_hash FROM sync_queue').all()
  now = AFTER_EXPIRY
  const service = new AttemptSettlementService({
    database,
    saleAttempts: repositories.saleAttempts,
    owner: () => ({ companyUuid, deviceUuid, userUuid }),
    catalog: fixture.catalog,
    completionInFlight: () => false,
    now: () => new Date(now)
  })

  equal(service.settleSuperseded(), 'none')
  equal(
    JSON.stringify(database.prepare('SELECT payload_json, payload_hash FROM sync_queue').all()),
    JSON.stringify(payloadBefore)
  )
  closeDatabase(database)
})
