import { equal, ok } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import type { LocalSaleDependencies } from '../../../src/main/services/localSale.service'
import { licenseStatusFixture } from '../../../src/main/testing/fixtures/licenseStatus.fixture'
import { databaseTest } from '../support/sandbox'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories, type RealRepositories } from '../support/realRepositories'
import {
  companyUuid,
  deviceUuid,
  methodUuid,
  setUpAuthorizedContext,
  trackedProductUuid,
  validIntent,
  warehouseUuid
} from '../support/localSaleFixture'

/**
 * Rev 4 §5 on real SQLite: the physical-presence commit judges every window at ONE fresh trusted
 * instant `t1` read inside the serialized transaction, and an authority that lapses between the
 * preliminary check and the commit leaves the frozen intent intact (non-terminal).
 */

const T = '2026-01-01T02:00:00.000Z'
const AUTHORITY_UUID = 'abababab-abab-4bab-8bab-ababababab01'

function trackedIntent(): ReturnType<typeof validIntent> {
  return validIntent({
    items: [
      {
        id: 'item-1',
        productUuid: trackedProductUuid,
        quantity: '3.000',
        discountType: null,
        discountValue: 0
      }
    ],
    payments: [{ id: 'payment-1', paymentMethodUuid: methodUuid, amount: 1500, reference: null }]
  })
}

function storeAuthority(
  repositories: RealRepositories,
  notAfter: string,
  warehouse = warehouseUuid
): void {
  repositories.offlineSaleAuthorities.observe(
    {
      id: AUTHORITY_UUID,
      mode: 'physical_presence',
      policy_revision: 1,
      contract_version: 3,
      issued_at: '2026-01-01T00:30:00+00:00',
      not_before: '2026-01-01T00:30:00+00:00',
      not_after: notAfter,
      authority_hash: 'a'.repeat(64),
      warehouse_uuid: warehouse
    },
    companyUuid,
    deviceUuid,
    T
  )
}

interface MovableClock {
  set(iso: string | null, rollbackDetected?: boolean): void
  reading: () => { now: Date; rollbackDetected: boolean } | null
}

/** A trusted clock the test moves: `set(iso)` changes what the NEXT reading returns. */
function movableClock(start: string): MovableClock {
  let current: string | null = start
  let rollback = false
  return {
    set(iso: string | null, rollbackDetected = false) {
      current = iso
      rollback = rollbackDetected
    },
    reading: () =>
      current === null ? null : { now: new Date(current), rollbackDetected: rollback }
  }
}

function build(
  database: ReturnType<typeof openTestDatabase>,
  repositories: RealRepositories,
  clock: MovableClock,
  connectivity: 'online' | 'offline' = 'offline'
): ReturnType<typeof setUpAuthorizedContext> {
  const extra: Partial<LocalSaleDependencies> = {
    offlineSaleAuthorities: repositories.offlineSaleAuthorities,
    trustedClock: { now: () => clock.reading() }
  }
  return setUpAuthorizedContext(
    database,
    repositories,
    () => new Date(T),
    connectivity,
    true,
    extra
  )
}

interface AttemptRow {
  state: string
  intent_json: string | null
  failure_code: string | null
}

function attemptRow(database: ReturnType<typeof openTestDatabase>, key: string): AttemptRow {
  return database
    .prepare('SELECT state, intent_json, failure_code FROM sale_attempts WHERE attempt_key = ?')
    .get(key) as AttemptRow
}

databaseTest(
  'a tracked sale commits under a usable authority with every timestamp at t1',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const clock = movableClock('2026-01-01T02:00:05.000Z')
    const { localSale } = build(database, repositories, clock)
    storeAuthority(repositories, '2026-01-01T03:00:00+00:00')

    const outcome = localSale.complete('aaaaaaaa-0000-4000-8000-000000000001', trackedIntent())

    equal(outcome.outcome, 'committed')
    const committed = outcome as Extract<typeof outcome, { outcome: 'committed' }>
    equal(committed.invoice.soldAt, '2026-01-01T02:00:05.000Z')
    equal(committed.invoice.createdAt, '2026-01-01T02:00:05.000Z')
    equal(committed.invoice.uploadPayloadVersion, 3)
    equal(committed.invoice.offlineSaleAuthorityUuid, AUTHORITY_UUID)
    for (const payment of committed.payments) {
      equal(payment.paidAt, '2026-01-01T02:00:05.000Z')
    }
    equal(
      (JSON.parse(committed.invoice.commercialSnapshotJson) as { evaluatedAt?: string })
        .evaluatedAt,
      '2026-01-01T02:00:05.000Z'
    )
    closeDatabase(database)
  }
)

databaseTest(
  'an authority that lapses between the preliminary check and t1 is non-terminal',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const clock = movableClock('2026-01-01T02:59:59.000Z')
    const { localSale } = build(database, repositories, clock)
    storeAuthority(repositories, '2026-01-01T03:00:00+00:00')
    const key = 'aaaaaaaa-0000-4000-8000-000000000002'

    const prepared = localSale.prepareCompletion(key, trackedIntent())
    ok(prepared.kind === 'ready')
    const t0 = localSale.preliminaryInstant()
    ok(t0 && localSale.hasUsableAuthority(prepared, t0), 'usable at the preliminary instant t0')
    const frozen = attemptRow(database, key).intent_json

    // The wait (a renewal, an upload, a slow network) crosses not_after exactly: half-open → outside.
    clock.set('2026-01-01T03:00:00.000Z')
    const outcome = localSale.runPrepared(prepared)

    equal(outcome.outcome, 'failed')
    equal((outcome as { code: string }).code, 'offline-sale-authority-unavailable')
    const row = attemptRow(database, key)
    equal(row.state, 'claimed')
    equal(row.intent_json, frozen, 'the frozen intent is byte-identical')

    // A renewal lands (new authority); the same attempt now commits at a fresh t1.
    repositories.offlineSaleAuthorities.observe(
      {
        id: 'abababab-abab-4bab-8bab-ababababab02',
        mode: 'physical_presence',
        policy_revision: 1,
        contract_version: 3,
        issued_at: '2026-01-01T03:00:00+00:00',
        not_before: '2026-01-01T03:00:00+00:00',
        not_after: '2026-01-02T03:00:00+00:00',
        authority_hash: 'b'.repeat(64),
        warehouse_uuid: warehouseUuid
      },
      companyUuid,
      deviceUuid,
      T
    )
    clock.set('2026-01-01T03:00:10.000Z')
    const retried = localSale.retry(key)
    equal(retried.outcome, 'committed')
    equal(
      (retried as Extract<typeof retried, { outcome: 'committed' }>).invoice.soldAt,
      '2026-01-01T03:00:10.000Z'
    )
    closeDatabase(database)
  }
)

databaseTest(
  'a catalog window closing between t0 and t1 keeps the existing terminal rule',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const clock = movableClock('2026-01-03T23:59:59.000Z')
    const { localSale } = build(database, repositories, clock)
    // Keep the license boundary out of the way so only the catalog window is crossed.
    repositories.licenseMetadata.setValidatedStatus(
      { ...licenseStatusFixture(), nextValidationDueAt: '2026-01-10T00:00:00+00:00' },
      '2026-01-01T00:00:00Z'
    )
    storeAuthority(repositories, '2026-01-05T00:00:00+00:00')
    const key = 'aaaaaaaa-0000-4000-8000-000000000003'

    const prepared = localSale.prepareCompletion(key, trackedIntent())
    ok(prepared.kind === 'ready')
    clock.set('2026-01-04T00:00:00.000Z') // catalog valid_until, half-open
    const outcome = localSale.runPrepared(prepared)

    equal(outcome.outcome, 'rejected')
    equal((outcome as { failureCode: string }).failureCode, 'catalog-superseded')
    closeDatabase(database)
  }
)

databaseTest(
  'the license validation boundary crossing between t0 and t1 is non-terminal context-changed',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const clock = movableClock('2026-01-03T23:59:59.000Z')
    const { localSale } = build(database, repositories, clock)
    storeAuthority(repositories, '2026-01-05T00:00:00+00:00')
    const key = 'aaaaaaaa-0000-4000-8000-000000000008'

    const prepared = localSale.prepareCompletion(key, trackedIntent())
    ok(prepared.kind === 'ready')
    clock.set('2026-01-04T00:00:00.000Z') // nextValidationDueAt
    const outcome = localSale.runPrepared(prepared)

    equal(outcome.outcome, 'failed')
    equal((outcome as { code: string }).code, 'context-changed')
    equal(attemptRow(database, key).state, 'claimed')
    closeDatabase(database)
  }
)

databaseTest(
  'no trusted instant, or a detected rollback, refuses as non-terminal clock-untrusted',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const clock = movableClock('2026-01-01T02:00:00.000Z')
    const { localSale } = build(database, repositories, clock)
    storeAuthority(repositories, '2026-01-01T03:00:00+00:00')

    clock.set(null)
    const nullClock = localSale.complete('aaaaaaaa-0000-4000-8000-000000000004', trackedIntent())
    equal((nullClock as { code?: string }).code, 'clock-untrusted')
    equal(attemptRow(database, 'aaaaaaaa-0000-4000-8000-000000000004').state, 'claimed')

    clock.set('2026-01-01T02:00:00.000Z', true)
    const rolledBack = localSale.retry('aaaaaaaa-0000-4000-8000-000000000004')
    equal((rolledBack as { code?: string }).code, 'clock-untrusted')
    closeDatabase(database)
  }
)

databaseTest('an authority for another warehouse never authorizes this attempt', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  const clock = movableClock('2026-01-01T02:00:00.000Z')
  const { localSale } = build(database, repositories, clock)
  storeAuthority(repositories, '2026-01-01T03:00:00+00:00', '12121212-1212-4121-8121-121212121212')

  const outcome = localSale.complete('aaaaaaaa-0000-4000-8000-000000000005', trackedIntent())

  // No PP authority for THIS warehouse ever existed → the legacy allocation rule, unchanged.
  equal(outcome.outcome, 'rejected')
  equal((outcome as { failureCode: string }).failureCode, 'stock-allocation-unavailable')
  closeDatabase(database)
})

databaseTest(
  'allocation-mode control: no authority at all keeps the legacy terminal rejection',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const clock = movableClock('2026-01-01T02:00:00.000Z')
    const { localSale } = build(database, repositories, clock)

    const outcome = localSale.complete('aaaaaaaa-0000-4000-8000-000000000006', trackedIntent())

    equal(outcome.outcome, 'rejected')
    equal((outcome as { failureCode: string }).failureCode, 'stock-allocation-unavailable')
    closeDatabase(database)
  }
)

databaseTest('an unavailable allocation capability does not block a PP sale (A6)', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  const clock = movableClock('2026-01-01T02:00:00.000Z')
  const { localSale } = build(database, repositories, clock)
  storeAuthority(repositories, '2026-01-01T03:00:00+00:00')
  repositories.stockAllocations.markCapabilityUnavailable(T)

  const outcome = localSale.complete('aaaaaaaa-0000-4000-8000-000000000007', trackedIntent())

  equal(outcome.outcome, 'committed')
  const items = (outcome as Extract<typeof outcome, { outcome: 'committed' }>).items
  equal(items[0].uncoveredMilli, 3000)
  closeDatabase(database)
})

databaseTest(
  'no attempt is claimed while a catalog install hold is active, or for a superseded revision',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const clock = movableClock('2026-01-01T02:00:00.000Z')
    let holdActive = true
    const { localSale } = setUpAuthorizedContext(
      database,
      repositories,
      () => new Date(T),
      'online',
      true,
      {
        offlineSaleAuthorities: repositories.offlineSaleAuthorities,
        trustedClock: { now: () => clock.reading() },
        installGate: { isHoldActive: () => holdActive }
      }
    )
    storeAuthority(repositories, '2026-01-01T03:00:00+00:00')
    const count = (): number =>
      (database.prepare('SELECT COUNT(*) AS n FROM sale_attempts').get() as { n: number }).n

    const during = localSale.complete('aaaaaaaa-0000-4000-8000-000000000009', trackedIntent())
    equal((during as { code?: string }).code, 'catalog-updating')
    equal(count(), 0)

    holdActive = false
    const stale = localSale.complete(
      'aaaaaaaa-0000-4000-8000-00000000000a',
      trackedIntent().catalogRevision === 'f'.repeat(64)
        ? trackedIntent()
        : { ...trackedIntent(), catalogRevision: 'f'.repeat(64) }
    )
    equal((stale as { code?: string }).code, 'catalog-updated')
    equal(count(), 0)

    const fine = localSale.complete('aaaaaaaa-0000-4000-8000-00000000000b', trackedIntent())
    equal(fine.outcome, 'committed')
    closeDatabase(database)
  }
)

databaseTest(
  'a wall clock rolled back past the license anchor is refused pre-claim as clock-untrusted (C11)',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const clock = movableClock(T)
    // Commercial access reads a wall clock 10 minutes before the 00:00 license anchor.
    const { localSale } = setUpAuthorizedContext(
      database,
      repositories,
      () => new Date('2025-12-31T23:50:00.000Z'),
      'offline',
      true,
      {
        offlineSaleAuthorities: repositories.offlineSaleAuthorities,
        trustedClock: { now: () => clock.reading() }
      }
    )
    storeAuthority(repositories, '2026-01-01T03:00:00+00:00')

    const key = 'aaaaaaaa-0000-4000-8000-0000000000c1'
    const outcome = localSale.complete(key, trackedIntent())

    equal(outcome.outcome, 'failed')
    equal((outcome as { code?: string }).code, 'clock-untrusted')
    equal((outcome as { attemptKey?: string | null }).attemptKey, null)
    equal(
      (
        database
          .prepare('SELECT COUNT(*) AS n FROM sale_attempts WHERE attempt_key = ?')
          .get(key) as { n: number }
      ).n,
      0,
      'nothing is claimed'
    )
    closeDatabase(database)
  }
)
