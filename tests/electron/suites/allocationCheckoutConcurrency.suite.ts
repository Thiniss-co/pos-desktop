import { equal, ok } from 'node:assert/strict'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'

import { closeDatabase } from '../../../src/main/database/connection'
import {
  allocationJournalAppend,
  allocationJournalInitialHash
} from '../../../src/main/services/allocationJournal'
import { databaseTest } from '../support/sandbox'
import { openTestDatabase, openSandboxDatabaseAtPath } from '../support/openTestDatabase'
import { realRepositories } from '../support/realRepositories'
import { startFreshProcess, type FreshProcessHandle } from '../support/freshProcess'
import {
  companyUuid,
  deviceUuid,
  setUpAuthorizedContext,
  trackedProductUuid,
  warehouseUuid
} from '../support/localSaleFixture'
import {
  COMPANY_UUID,
  DEVICE_UUID,
  PRODUCT_UUID,
  WAREHOUSE_UUID,
  grant as buildGrant
} from '../support/allocationScenario'

/**
 * BH-04B-3-R1 §2: checkout versus reconciliation, with genuine contention evidence.
 *
 * **What changed from the original BH-04B-3 version, and why.** The original test compared the
 * coverer's write-transaction-acquisition timestamp against the holder's row-insertion time plus a
 * fixed 400ms hold. That inequality holds whenever the coverer's process simply takes at least
 * ~300ms to start up and reach its own `BEGIN IMMEDIATE` — which real Electron process spawn,
 * module loading, and JIT warmup routinely do — regardless of whether the coverer's transaction was
 * ever actually attempted while the holder's lock was held. Repeating the test three times could
 * not close that gap: process-startup latency is itself fairly consistent, so a passing run on one
 * machine says nothing about whether real contention occurred.
 *
 * **The corrected mechanism.** `probe-and-checkout` sets `PRAGMA busy_timeout = 0` on its own
 * connection — the exact connection `LocalSaleService` goes on to use — and attempts
 * `BEGIN IMMEDIATE`. With a zero busy timeout, SQLite either grants the lock immediately or fails
 * immediately with `SQLITE_BUSY`/`SQLITE_LOCKED`; there is no internal wait to be confused with
 * scheduling jitter. Observing that failure is direct, instant-in-time evidence that another
 * connection currently holds the write lock. Only after that probe does the code restore
 * `busy_timeout` to the production value (5000ms) and proceed — first through
 * `setUpAuthorizedContext()`'s own setup writes, then through the real `LocalSaleService.complete()`
 * call. Because SQLite allows only one write transaction per database file at a time, confirming the
 * lock was held immediately before the *first* write this process attempts is sufficient to show
 * every subsequent write on that same connection — setup and the real sale alike — also had to wait:
 * there is no way for a later write on the same connection to have run earlier than an observed-busy
 * probe on that connection.
 *
 * The holder (`hold-lock`) never fabricates a consumption row: `BEGIN IMMEDIATE` alone already
 * takes the RESERVED lock that blocks a second writer, so holding it open (until an explicit
 * parent-controlled release file appears — never a fixed sleep) is sufficient contention by itself.
 *
 * **What this establishes.** That the real checkout path (`LocalSaleService.complete()`, exercised
 * through the same `setUpAuthorizedContext`/fixture every other checkout suite in this repo uses)
 * and reconciliation (`AllocationReconciliationService.applyCoverage()`) cannot interleave to
 * corrupt state, proven across two genuinely independent OS processes with real evidence of
 * overlap — not two connections driven from one JS thread, and not a sequential mock. It does not
 * establish anything about checkout-versus-*seal* (no seal request exists on the desktop yet) or
 * any backend release race; both remain slice 4.
 *
 * The third test in this file is explicitly a **sequential** cross-process ordering/recovery proof,
 * not a second concurrency race: each process runs to full completion before the next one starts.
 */

const WORKER_SOURCE = 'tests/electron/support/allocationConcurrencyWorker.ts'
const ALLOC_A = '00000000-0000-4000-8000-00000000d001'

/** The identities `setUpAuthorizedContext()`/`LocalSaleService` hardcode, for the real-checkout test. */
function realCheckoutEnvironment(): Record<string, string> {
  return {
    POS_ITEST_ALLOCATION_UUID: ALLOC_A,
    POS_ITEST_COMPANY_UUID: companyUuid,
    POS_ITEST_DEVICE_UUID: deviceUuid,
    POS_ITEST_WAREHOUSE_UUID: warehouseUuid,
    POS_ITEST_PRODUCT_UUID: trackedProductUuid
  }
}

/** The synthetic-scenario identities `allocationScenario.ts` uses, for the sequential-order test. */
function syntheticEnvironment(): Record<string, string> {
  return {
    POS_ITEST_ALLOCATION_UUID: ALLOC_A,
    POS_ITEST_COMPANY_UUID: COMPANY_UUID,
    POS_ITEST_DEVICE_UUID: DEVICE_UUID,
    POS_ITEST_WAREHOUSE_UUID: WAREHOUSE_UUID,
    POS_ITEST_PRODUCT_UUID: PRODUCT_UUID
  }
}

databaseTest(
  'a busy probe with no writer present correctly reports no contention (sensitivity check for the overlap evidence)',
  async (sandbox) => {
    // No holder, nothing at all holds the write lock here. This is the negative control: it proves
    // the busy-probe mechanism the main test below relies on is discriminating — that it reports
    // `busy: false` in the absence of contention — rather than assuming a mechanism nobody has shown
    // can ever report `false` is meaningful when it reports `true`.
    closeDatabase(openTestDatabase(sandbox))

    const prober: FreshProcessHandle = startFreshProcess(sandbox, WORKER_SOURCE, 'probe-only', {
      POS_ITEST_COMMAND: 'probe-only'
    })
    const outcome = await prober.wait()

    equal(outcome.status, 0, outcome.stderr.slice(-2000))
    ok(outcome.result !== null, outcome.stderr.slice(-2000))
    equal(outcome.result?.outcome, 'probed')
    equal(
      outcome.result?.busy,
      false,
      'the probe reported contention with no writer present at all'
    )
  }
)

databaseTest(
  'the real checkout path composes correctly with reconciliation under genuine, evidenced write-lock contention',
  async (sandbox) => {
    // Seed everything through one connection first: bootstrap/catalog/session/shift via the exact
    // production fixture every checkout suite uses, plus the allocation grant `complete()` will
    // consume from. Then close — from here on, only the two worker processes and the final
    // independent read-backs touch the file.
    const seedDatabase = openTestDatabase(sandbox)
    const seedRepositories = realRepositories(seedDatabase)
    setUpAuthorizedContext(seedDatabase, seedRepositories)
    seedRepositories.stockAllocations.upsertGrant({
      allocationUuid: ALLOC_A,
      contractVersion: 1,
      companyUuid,
      deviceUuid,
      warehouseUuid,
      productUuid: trackedProductUuid,
      serverSequence: 1,
      lifecycleGeneration: 1,
      grantedQuantityMilli: 5_000,
      consumeUntil: '2099-01-01T00:00:00.000Z',
      envelopeHash: 'a'.repeat(64),
      receivedAt: '2026-01-01T00:00:00.000Z'
    })
    closeDatabase(seedDatabase)

    const lockMarkerPath = join(sandbox.root, 'hold-lock.marker.json')
    const releasePath = join(sandbox.root, 'hold-lock.release')
    const readyPath = join(sandbox.root, 'checkout.ready.json')
    const probeResultPath = join(sandbox.root, 'checkout.probe-result.json')
    const attemptKey = '99999999-9999-4999-8999-000000000001'

    const holder: FreshProcessHandle = startFreshProcess(sandbox, WORKER_SOURCE, 'hold-lock', {
      POS_ITEST_COMMAND: 'hold-lock',
      POS_ITEST_MARKER_PATH: lockMarkerPath,
      POS_ITEST_RELEASE_PATH: releasePath
    })

    // Confirms the holder's `BEGIN IMMEDIATE` genuinely succeeded and is still open — before the
    // second process is even started.
    const lockMarker = await holder.waitForMarker(lockMarkerPath)
    ok(lockMarker.holding === true)

    const checkout: FreshProcessHandle = startFreshProcess(
      sandbox,
      WORKER_SOURCE,
      'probe-and-checkout',
      {
        ...realCheckoutEnvironment(),
        POS_ITEST_COMMAND: 'probe-and-checkout',
        POS_ITEST_READY_PATH: readyPath,
        POS_ITEST_PROBE_RESULT_PATH: probeResultPath,
        POS_ITEST_ATTEMPT_KEY: attemptKey
      }
    )

    await checkout.waitForMarker(readyPath)
    const probeResult = await checkout.waitForMarker(probeResultPath)

    // The load-bearing assertion: the checkout process's own connection — the same one
    // `LocalSaleService` is about to use — genuinely observed the write lock held, at an instant
    // strictly before it attempted any write of its own (setup or sale). If this is false, the
    // rest of the test proves nothing about contention and must not proceed as though it did.
    equal(
      probeResult.busy,
      true,
      'the checkout process did not observe real write-lock contention before its first write — this run establishes nothing about serialization and must fail rather than continue'
    )

    // Only now — after contention is positively confirmed, never on a timer — release the holder.
    writeFileSync(releasePath, JSON.stringify({ releasedAt: Date.now() }))

    const [holderOutcome, checkoutOutcome] = await Promise.all([holder.wait(), checkout.wait()])

    equal(holderOutcome.status, 0, holderOutcome.stderr.slice(-2000))
    equal(holderOutcome.result?.outcome, 'released')
    equal(checkoutOutcome.status, 0, checkoutOutcome.stderr.slice(-2000))
    ok(checkoutOutcome.result !== null, checkoutOutcome.stderr.slice(-2000))
    equal(
      checkoutOutcome.result?.outcome,
      'committed',
      `the real checkout did not commit: ${JSON.stringify(checkoutOutcome.result)}`
    )
    equal(checkoutOutcome.result?.busy, true)

    // Independent final read: a fresh connection this test opens itself, after both processes have
    // fully exited, reading exactly what the real production checkout path produced.
    const database = openSandboxDatabaseAtPath(sandbox.databasePath)
    const repositories = realRepositories(database)

    const consumptionRows = database
      .prepare(
        'SELECT * FROM local_stock_allocation_consumptions WHERE allocation_uuid = ? ORDER BY consumption_sequence'
      )
      .all(ALLOC_A) as Record<string, unknown>[]
    equal(consumptionRows.length, 1, 'expected exactly one real consumption row, no duplicates')
    const [row] = consumptionRows
    equal(row.quantity_milli, 1000)
    equal(row.consumption_sequence, 1)
    equal(row.rights_generation, 1)
    ok(typeof row.request_hash === 'string' && (row.request_hash as string).length === 64)
    ok(typeof row.chain_hash === 'string' && (row.chain_hash as string).length === 64)

    // Reconciliation now composes against the REAL evidence the real checkout produced — not a
    // value this test precomputed — proving the two paths compose correctly end to end.
    const boundaryOutcome = repositories.allocationReconciliation.applyCoverage(
      {
        allocationUuid: ALLOC_A,
        rightsGeneration: 1,
        acceptedConsumptionSequence: row.consumption_sequence as number,
        acceptedConsumedQuantityMilli: row.quantity_milli as number,
        acceptedChainHash: row.chain_hash as string
      },
      { companyUuid, deviceUuid },
      'invoice_upload',
      new Date().toISOString()
    )
    equal(boundaryOutcome.kind, 'accepted', JSON.stringify(boundaryOutcome))
    equal(repositories.stockAllocations.spendableMilli(ALLOC_A), 4_000)

    closeDatabase(database)
  }
)

databaseTest(
  'BH-04B-4 committed recovery intent wins real checkout contention and remains denied after reconciliation',
  async (sandbox) => {
    const seedDatabase = openTestDatabase(sandbox)
    const seedRepositories = realRepositories(seedDatabase)
    setUpAuthorizedContext(seedDatabase, seedRepositories)
    seedRepositories.stockAllocations.upsertGrant({
      allocationUuid: ALLOC_A,
      contractVersion: 1,
      companyUuid,
      deviceUuid,
      warehouseUuid,
      productUuid: trackedProductUuid,
      serverSequence: 1,
      lifecycleGeneration: 1,
      grantedQuantityMilli: 5_000,
      consumeUntil: '2099-01-01T00:00:00.000Z',
      envelopeHash: 'a'.repeat(64),
      receivedAt: '2026-01-01T00:00:00.000Z'
    })
    closeDatabase(seedDatabase)

    const markerPath = join(sandbox.root, 'recovery.marker.json')
    const releasePath = join(sandbox.root, 'recovery.release')
    const readyPath = join(sandbox.root, 'recovery-checkout.ready.json')
    const probePath = join(sandbox.root, 'recovery-checkout.probe.json')
    const holder = startFreshProcess(sandbox, WORKER_SOURCE, 'hold-recovery-intent', {
      ...realCheckoutEnvironment(),
      POS_ITEST_COMMAND: 'hold-recovery-intent',
      POS_ITEST_MARKER_PATH: markerPath,
      POS_ITEST_RELEASE_PATH: releasePath
    })
    const marker = await holder.waitForMarker(markerPath)
    equal(marker.state, 'intent')

    const checkout = startFreshProcess(sandbox, WORKER_SOURCE, 'recovery-checkout', {
      ...realCheckoutEnvironment(),
      POS_ITEST_COMMAND: 'probe-and-checkout',
      POS_ITEST_READY_PATH: readyPath,
      POS_ITEST_PROBE_RESULT_PATH: probePath,
      POS_ITEST_ATTEMPT_KEY: '99999999-9999-4999-8999-000000000441'
    })
    await checkout.waitForMarker(readyPath)
    equal((await checkout.waitForMarker(probePath)).busy, true)
    writeFileSync(releasePath, JSON.stringify({ release: true }))

    const [holderOutcome, checkoutOutcome] = await Promise.all([holder.wait(), checkout.wait()])
    equal(holderOutcome.status, 0, holderOutcome.stderr.slice(-2000))
    equal(holderOutcome.result?.outcome, 'intent-committed')
    equal(checkoutOutcome.status, 0, checkoutOutcome.stderr.slice(-2000))
    equal(checkoutOutcome.result?.busy, true)
    ok(checkoutOutcome.result?.outcome !== 'committed')

    const database = openSandboxDatabaseAtPath(sandbox.databasePath)
    const repositories = realRepositories(database)
    equal(
      database.prepare('SELECT COUNT(*) FROM local_stock_allocation_consumptions').pluck().get(),
      0
    )

    // A later valid ordinary reconciliation clears coverage holds, but the independent recovery
    // row survives and the old generation still cannot become selectable or spendable.
    const boundary = {
      allocationUuid: ALLOC_A,
      rightsGeneration: 1,
      acceptedConsumptionSequence: 0,
      acceptedConsumedQuantityMilli: 0,
      acceptedChainHash: allocationJournalInitialHash(ALLOC_A, 1)
    }
    equal(
      repositories.allocationReconciliation.applyCoverage(
        boundary,
        { companyUuid, deviceUuid },
        'bootstrap',
        new Date().toISOString()
      ).kind,
      'accepted'
    )
    equal(repositories.stockAllocations.spendableMilli(ALLOC_A), 0)
    equal(
      repositories.stockAllocations.usableGrantsForProduct(
        { companyUuid, deviceUuid, warehouseUuid },
        trackedProductUuid,
        new Date().toISOString()
      ).length,
      0
    )
    closeDatabase(database)
  }
)

databaseTest(
  'sequential cross-process ordering: coverage before a committed row fails closed, then a later message converges (not a second race)',
  async (sandbox) => {
    closeDatabase(openTestDatabase(sandbox))
    const seedDatabase = openSandboxDatabaseAtPath(sandbox.databasePath)
    realRepositories(seedDatabase).stockAllocations.ingestBootstrapSnapshot(
      1,
      [buildGrant(ALLOC_A, { grantedQuantityMilli: 10_000 })],
      '2026-09-06T00:00:00.000Z',
      'reconciliation_v2'
    )
    closeDatabase(seedDatabase)

    const invoiceUuid = '00000000-0000-4000-8000-e00000000101'
    const itemUuid = '00000000-0000-4000-8000-e00000000102'
    const localUuid = '00000000-0000-4000-8000-e00000000103'
    const requestHash = 'd'.repeat(64)
    const expectedChainHash = allocationJournalAppend(allocationJournalInitialHash(ALLOC_A, 1), {
      allocationUuid: ALLOC_A,
      rightsGeneration: 1,
      consumptionSequence: 1,
      localConsumptionUuid: localUuid,
      invoiceIdempotencyKey: invoiceUuid,
      itemLineUuid: itemUuid,
      quantityMilli: 3_000,
      requestHash
    }).chainHash

    // Each `await ...wait()` below blocks for that whole process's completion before the next one
    // is even started — this is a real cross-process *ordering* proof (each side genuinely runs in
    // its own process), but the two sides are never open at the same time, so it establishes
    // nothing about lock contention. That is deliberate: the property under test here is arrival
    // order (BH-04A §3.1's "older/lost/early" scenarios), not serialization.
    const earlyCoverer: FreshProcessHandle = startFreshProcess(
      sandbox,
      WORKER_SOURCE,
      'apply-coverage-early',
      {
        ...syntheticEnvironment(),
        POS_ITEST_COMMAND: 'apply-coverage',
        POS_ITEST_SEQUENCE: '1',
        POS_ITEST_QUANTITY_MILLI: '3000',
        POS_ITEST_CHAIN_HASH: expectedChainHash
      }
    )
    const earlyOutcome = await earlyCoverer.wait()
    equal(earlyOutcome.status, 0, earlyOutcome.stderr.slice(-2000))
    equal(earlyOutcome.result?.outcome, 'rejected')
    equal(earlyOutcome.result?.reason, 'sequence-beyond-local-history')

    {
      const database = openSandboxDatabaseAtPath(sandbox.databasePath)
      const repositories = realRepositories(database)
      equal(repositories.stockAllocations.spendableMilli(ALLOC_A), 0)
      ok(repositories.stockAllocations.findHold(ALLOC_A, 1) !== null)
      closeDatabase(database)
    }

    const seedingCommit: FreshProcessHandle = startFreshProcess(
      sandbox,
      WORKER_SOURCE,
      'commit-consumption',
      {
        ...syntheticEnvironment(),
        POS_ITEST_COMMAND: 'commit-consumption',
        POS_ITEST_INVOICE_UUID: invoiceUuid,
        POS_ITEST_ITEM_UUID: itemUuid,
        POS_ITEST_LOCAL_UUID: localUuid,
        POS_ITEST_REQUEST_HASH: requestHash
      }
    )
    const commitOutcome = await seedingCommit.wait()
    equal(commitOutcome.status, 0, commitOutcome.stderr.slice(-2000))
    equal(commitOutcome.result?.outcome, 'committed')

    const lateCoverer: FreshProcessHandle = startFreshProcess(
      sandbox,
      WORKER_SOURCE,
      'apply-coverage-late',
      {
        ...syntheticEnvironment(),
        POS_ITEST_COMMAND: 'apply-coverage',
        POS_ITEST_SEQUENCE: '1',
        POS_ITEST_QUANTITY_MILLI: '3000',
        POS_ITEST_CHAIN_HASH: expectedChainHash
      }
    )
    const lateOutcome = await lateCoverer.wait()
    equal(lateOutcome.status, 0, lateOutcome.stderr.slice(-2000))
    equal(lateOutcome.result?.outcome, 'accepted', JSON.stringify(lateOutcome.result))

    const database = openSandboxDatabaseAtPath(sandbox.databasePath)
    const repositories = realRepositories(database)
    equal(repositories.stockAllocations.findHold(ALLOC_A, 1), null)
    equal(repositories.stockAllocations.spendableMilli(ALLOC_A), 7_000)
    closeDatabase(database)
  }
)
