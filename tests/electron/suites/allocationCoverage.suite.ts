import { equal, notEqual, ok } from 'node:assert/strict'

import { closeDatabase, type SqliteDatabase } from '../../../src/main/database/connection'
import { AllocationReconciliationService } from '../../../src/main/services/allocationReconciliation.service'
import { allocationJournalInitialHash } from '../../../src/main/services/allocationJournal'
import { databaseTest } from '../support/sandbox'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories, type RealRepositories } from '../support/realRepositories'
import {
  COMPANY_UUID,
  DEVICE_UUID,
  OTHER_COMPANY_UUID,
  OTHER_DEVICE_UUID,
  emptyBoundary,
  grant as buildGrant,
  owner,
  writeInvoiceSkeleton,
  writeLocalJournal
} from '../support/allocationScenario'

/**
 * BH-04B-3 §7 items 5-9 and 11: the exact BH-04A §3.1 coverage boundary — validation, monotonicity,
 * conflict detection, fail-closed evidence handling, and transactional coupling — proven against
 * real repositories over a real SQLite file, never in-memory fakes.
 */

const ALLOC_A = '00000000-0000-4000-8000-00000000a001'
const ALLOC_B = '00000000-0000-4000-8000-00000000a002'

function setUp(database: SqliteDatabase): {
  readonly repositories: RealRepositories
  readonly reconciliation: AllocationReconciliationService
} {
  const repositories = realRepositories(database)
  return { repositories, reconciliation: repositories.allocationReconciliation }
}

/**
 * A real bootstrap snapshot describes ALL of a device's grants at once, so seeding two allocations
 * with two separate `ingestBootstrapSnapshot()` calls at the same revision is a genuine conflict
 * (the second call looks like it is redescribing revision 1 without the first grant). The first
 * allocation in a test seeds the initial snapshot; every allocation after it joins as a top-up,
 * exactly like a second grant arriving after the device already has a bootstrap snapshot.
 */
function seedGrant(
  repositories: RealRepositories,
  allocationUuid: string,
  overrides: Parameters<typeof buildGrant>[1] = {}
): void {
  const grantRow = buildGrant(allocationUuid, overrides)
  const observedAt = '2026-09-06T00:00:00.000Z'

  if (repositories.stockAllocations.getCapability() === null) {
    repositories.stockAllocations.ingestBootstrapSnapshot(
      1,
      [grantRow],
      observedAt,
      'reconciliation_v2'
    )
    return
  }

  repositories.stockAllocations.ingestTopUpGrants([grantRow], observedAt)
}

let invoiceCounter = 0

function seedLocalConsumption(
  database: SqliteDatabase,
  allocationUuid: string,
  rightsGeneration: number,
  sequence: number,
  quantityMilli: number
): void {
  invoiceCounter += 1
  const invoiceUuid = `00000000-0000-4000-8000-0000000${String(invoiceCounter).padStart(5, '0')}`
  const itemUuid = `00000000-0000-4000-8000-0000001${String(invoiceCounter).padStart(5, '0')}`
  writeInvoiceSkeleton(database, invoiceUuid, itemUuid)
  writeLocalJournal(database, allocationUuid, rightsGeneration, [
    {
      localUuid: `00000000-0000-4000-8000-0000002${String(invoiceCounter).padStart(5, '0')}`,
      sequence,
      quantityMilli,
      invoiceLocalUuid: invoiceUuid,
      itemLocalUuid: itemUuid,
      lineIndex: 0,
      requestHash: 'a'.repeat(64)
    }
  ])
}

/**
 * Seeds a grant plus a complete local journal of `quantities`, sequence 1..n, and returns the exact
 * boundary a server would publish after accepting the whole prefix.
 *
 * Each quantity is its OWN sale — a separate invoice and item — because the schema's
 * `UNIQUE (invoice_local_uuid, item_local_uuid, allocation_uuid)` constraint means one item line
 * consumes a given allocation at most once; multiple sequences against the same allocation always
 * come from separate sales committed over time, never from one item split against itself.
 */
function seedGrantWithJournal(
  database: SqliteDatabase,
  repositories: RealRepositories,
  allocationUuid: string,
  grantedMilli: number,
  quantities: readonly number[]
): ReturnType<typeof writeLocalJournal> {
  seedGrant(repositories, allocationUuid, { grantedQuantityMilli: grantedMilli })

  const specs = quantities.map((quantityMilli, index) => {
    invoiceCounter += 1
    const suffix = String(invoiceCounter).padStart(6, '0')
    const invoiceUuid = `00000000-0000-4000-8000-1${suffix}`
    const itemUuid = `00000000-0000-4000-8000-2${suffix}`
    writeInvoiceSkeleton(database, invoiceUuid, itemUuid)

    return {
      localUuid: `00000000-0000-4000-8000-3${suffix}`,
      sequence: index + 1,
      quantityMilli,
      invoiceLocalUuid: invoiceUuid,
      itemLocalUuid: itemUuid,
      lineIndex: 0,
      requestHash: 'b'.repeat(64)
    }
  })

  return writeLocalJournal(database, allocationUuid, 1, specs)
}

// ---------------------------------------------------------------------------------------------
// Item 6: grant 10.000 / local committed sale 3.000 remains 7.000 in both arrival orders.
// ---------------------------------------------------------------------------------------------

databaseTest(
  'a stale snapshot (acknowledgement arrives first) leaves spendable at exactly 7.000',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { repositories, reconciliation } = setUp(database)

    seedGrant(repositories, ALLOC_A, { grantedQuantityMilli: 10_000 })
    seedLocalConsumption(database, ALLOC_A, 1, 1, 3_000)

    // The boundary has not moved yet: s=0. The local committed row above s is still deducted.
    const outcome = reconciliation.applyCoverage(emptyBoundary(ALLOC_A), owner, 'bootstrap', 'now')
    equal(outcome.kind, 'accepted')
    equal(repositories.stockAllocations.spendableMilli(ALLOC_A), 7_000)

    closeDatabase(database)
  }
)

databaseTest(
  'a refreshed snapshot (bootstrap arrives first) also leaves spendable at 7.000',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { repositories, reconciliation } = setUp(database)

    seedGrant(repositories, ALLOC_A, { grantedQuantityMilli: 10_000 })
    const boundary = seedLocalConsumptionAndBoundary(database, ALLOC_A, 3_000)

    const outcome = reconciliation.applyCoverage(boundary, owner, 'bootstrap', 'now')
    equal(outcome.kind, 'accepted')
    // Acknowledgement status never enters the arithmetic — both pending and acknowledged rows above
    // the boundary sequence count, and here the row is exactly AT the boundary, so it is not deducted
    // again: 10.000 - 3.000 covered - 0 uncovered = 7.000.
    equal(repositories.stockAllocations.spendableMilli(ALLOC_A), 7_000)

    closeDatabase(database)
  }
)

function seedLocalConsumptionAndBoundary(
  database: SqliteDatabase,
  allocationUuid: string,
  quantityMilli: number
): ReturnType<typeof writeLocalJournal> {
  invoiceCounter += 1
  const invoiceUuid = `00000000-0000-4000-8000-0000006${String(invoiceCounter).padStart(5, '0')}`
  const itemUuid = `00000000-0000-4000-8000-0000007${String(invoiceCounter).padStart(5, '0')}`
  writeInvoiceSkeleton(database, invoiceUuid, itemUuid)
  return writeLocalJournal(database, allocationUuid, 1, [
    {
      localUuid: `00000000-0000-4000-8000-0000008${String(invoiceCounter).padStart(5, '0')}`,
      sequence: 1,
      quantityMilli,
      invoiceLocalUuid: invoiceUuid,
      itemLocalUuid: itemUuid,
      lineIndex: 0,
      requestHash: 'c'.repeat(64)
    }
  ])
}

// ---------------------------------------------------------------------------------------------
// Item 5: all six §3.1 arrival scenarios.
// ---------------------------------------------------------------------------------------------

databaseTest(
  'lost HTTP response: boundary stays at s=0 but the local deduction still applies',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { repositories } = setUp(database)

    seedGrant(repositories, ALLOC_A, { grantedQuantityMilli: 10_000 })
    seedLocalConsumption(database, ALLOC_A, 1, 1, 3_000)

    // No coverage ever applied (the response was lost) — legacy conservative guard still holds because
    // no boundary was ever accepted, so the grant is simply not usable until reconciliation runs.
    equal(repositories.stockAllocations.findCoverageBoundary(ALLOC_A, 1), null)
    equal(repositories.stockAllocations.spendableMilli(ALLOC_A), 0)

    closeDatabase(database)
  }
)

databaseTest(
  'an exact upload replay does not duplicate or change the accepted boundary',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { repositories, reconciliation } = setUp(database)

    const boundary = seedGrantWithJournal(database, repositories, ALLOC_A, 10_000, [3_000])

    const first = reconciliation.applyCoverage(boundary, owner, 'invoice_upload', 't1')
    const replay = reconciliation.applyCoverage(boundary, owner, 'invoice_upload', 't2')

    equal(first.kind, 'accepted')
    equal(replay.kind, 'accepted')
    equal(repositories.stockAllocations.spendableMilli(ALLOC_A), 7_000)

    closeDatabase(database)
  }
)

databaseTest(
  'an older snapshot arriving after a newer one is discarded, never regressing coverage',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { repositories, reconciliation } = setUp(database)

    const newer = seedGrantWithJournal(database, repositories, ALLOC_A, 10_000, [3_000, 2_000])
    const older = { ...newer, acceptedConsumptionSequence: 1, acceptedConsumedQuantityMilli: 3_000 }

    const acceptNewer = reconciliation.applyCoverage(newer, owner, 'bootstrap', 't1')
    equal(acceptNewer.kind, 'accepted')

    const acceptOlder = reconciliation.applyCoverage(older, owner, 'top_up', 't2')
    equal(acceptOlder.kind, 'ignored-older')

    // The stored boundary is unchanged — still the newer one.
    const stored = repositories.stockAllocations.findCoverageBoundary(ALLOC_A, 1)
    equal(stored?.acceptedConsumptionSequence, newer.acceptedConsumptionSequence)
    equal(stored?.acceptedChainHash, newer.acceptedChainHash)
    equal(repositories.stockAllocations.spendableMilli(ALLOC_A), 5_000)

    closeDatabase(database)
  }
)

databaseTest(
  'concurrent new local sale during reconciliation: the deduction cannot straddle the boundary update',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { repositories, reconciliation } = setUp(database)

    const boundary = seedGrantWithJournal(database, repositories, ALLOC_A, 10_000, [3_000])

    // A new sale commits sequence 2 for 2.000 "concurrently" with reconciliation (in this
    // single-process proof, simply before the boundary is applied).
    seedLocalConsumption(database, ALLOC_A, 1, 2, 2_000)

    const outcome = reconciliation.applyCoverage(boundary, owner, 'invoice_upload', 'now')
    equal(outcome.kind, 'accepted')
    // The boundary (s=1) covers only the first 3.000; the concurrently-committed sequence 2 is above
    // it and is deducted regardless of when the boundary landed relative to that commit.
    equal(repositories.stockAllocations.spendableMilli(ALLOC_A), 10_000 - 3_000 - 2_000)

    closeDatabase(database)
  }
)

// ---------------------------------------------------------------------------------------------
// Item 7: multiple allocations and companies/devices cannot share or overwrite each other's boundary.
// ---------------------------------------------------------------------------------------------

databaseTest(
  'two allocations under the same owner keep fully independent boundaries',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { repositories, reconciliation } = setUp(database)

    const boundaryA = seedGrantWithJournal(database, repositories, ALLOC_A, 10_000, [3_000])
    const boundaryB = seedGrantWithJournal(database, repositories, ALLOC_B, 5_000, [1_000, 500])

    reconciliation.applyCoverage(boundaryA, owner, 'bootstrap', 'now')
    reconciliation.applyCoverage(boundaryB, owner, 'bootstrap', 'now')

    equal(repositories.stockAllocations.spendableMilli(ALLOC_A), 7_000)
    equal(repositories.stockAllocations.spendableMilli(ALLOC_B), 3_500)
    notEqual(
      repositories.stockAllocations.findCoverageBoundary(ALLOC_A, 1)?.acceptedChainHash,
      repositories.stockAllocations.findCoverageBoundary(ALLOC_B, 1)?.acceptedChainHash
    )

    closeDatabase(database)
  }
)

databaseTest(
  'a grant owned by another company or device rejects an incoming boundary as foreign-owner',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { repositories, reconciliation } = setUp(database)

    const boundary = seedGrantWithJournal(database, repositories, ALLOC_A, 10_000, [3_000])

    const foreignCompany = reconciliation.applyCoverage(
      boundary,
      { companyUuid: OTHER_COMPANY_UUID, deviceUuid: DEVICE_UUID },
      'bootstrap',
      'now'
    )
    const foreignDevice = reconciliation.applyCoverage(
      boundary,
      { companyUuid: COMPANY_UUID, deviceUuid: OTHER_DEVICE_UUID },
      'bootstrap',
      'now'
    )

    equal(foreignCompany.kind, 'rejected')
    equal((foreignCompany as { reason: string }).reason, 'foreign-owner')
    equal(foreignDevice.kind, 'rejected')
    equal((foreignDevice as { reason: string }).reason, 'foreign-owner')
    // A rejected foreign-owner attempt must never establish a boundary or spendability for this grant.
    equal(repositories.stockAllocations.findCoverageBoundary(ALLOC_A, 1), null)
    equal(repositories.stockAllocations.spendableMilli(ALLOC_A), 0)

    closeDatabase(database)
  }
)

// ---------------------------------------------------------------------------------------------
// Item 8: lower sequence ignored; equal sequence with changed q/h conflicts; newer coverage at the
// same lifecycle revision advances correctly.
// ---------------------------------------------------------------------------------------------

databaseTest(
  'a lower sequence than already accepted is silently ignored, not applied',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { repositories, reconciliation } = setUp(database)

    const full = seedGrantWithJournal(database, repositories, ALLOC_A, 10_000, [3_000, 2_000])
    const partial = {
      ...full,
      acceptedConsumptionSequence: 1,
      acceptedConsumedQuantityMilli: 3_000
    }

    reconciliation.applyCoverage(full, owner, 'bootstrap', 't1')
    const outcome = reconciliation.applyCoverage(partial, owner, 'top_up', 't2')

    equal(outcome.kind, 'ignored-older')
    equal(
      repositories.stockAllocations.findCoverageBoundary(ALLOC_A, 1)?.acceptedConsumptionSequence,
      2
    )

    closeDatabase(database)
  }
)

databaseTest(
  'equal sequence with a different quantity or hash is a conflict, not an idempotent update',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { repositories, reconciliation } = setUp(database)

    const boundary = seedGrantWithJournal(database, repositories, ALLOC_A, 10_000, [3_000])
    reconciliation.applyCoverage(boundary, owner, 'bootstrap', 't1')

    const conflictingQuantity = { ...boundary, acceptedConsumedQuantityMilli: 3_500 }
    const conflictingHash = { ...boundary, acceptedChainHash: 'f'.repeat(64) }

    const outcomeQuantity = reconciliation.applyCoverage(conflictingQuantity, owner, 'top_up', 't2')
    const outcomeHash = reconciliation.applyCoverage(conflictingHash, owner, 'top_up', 't3')

    equal(outcomeQuantity.kind, 'rejected')
    equal((outcomeQuantity as { reason: string }).reason, 'conflict')
    equal(outcomeHash.kind, 'rejected')
    equal((outcomeHash as { reason: string }).reason, 'conflict')

    // The originally accepted boundary must survive both conflicting attempts untouched.
    const stored = repositories.stockAllocations.findCoverageBoundary(ALLOC_A, 1)
    equal(stored?.acceptedConsumedQuantityMilli, 3_000)
    equal(stored?.acceptedChainHash, boundary.acceptedChainHash)
    // A conflict holds the grant — spending stays denied even though the ORIGINAL boundary was valid.
    equal(repositories.stockAllocations.spendableMilli(ALLOC_A), 0)
    ok(repositories.stockAllocations.findHold(ALLOC_A, 1) !== null)

    closeDatabase(database)
  }
)

databaseTest(
  'newer valid coverage at an unchanged lifecycle revision still advances (revision is not a coverage signal)',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { repositories, reconciliation } = setUp(database)

    seedGrant(repositories, ALLOC_A, { grantedQuantityMilli: 10_000, lifecycleGeneration: 3 })

    // Two independent sales over time — real committed evidence, not one item re-split against
    // itself. `seedGrantWithJournal`'s pattern (separate invoice per sequence) applies here too, but
    // this test needs the *first-entry-only* boundary as an intermediate step, so it is built by
    // hand from the same two sales rather than reusing that helper's all-at-once return value.
    invoiceCounter += 1
    const firstInvoice = `00000000-0000-4000-8000-4${String(invoiceCounter).padStart(6, '0')}`
    const firstItem = `00000000-0000-4000-8000-5${String(invoiceCounter).padStart(6, '0')}`
    writeInvoiceSkeleton(database, firstInvoice, firstItem)

    const first = writeLocalJournal(database, ALLOC_A, 1, [
      {
        localUuid: `00000000-0000-4000-8000-6${String(invoiceCounter).padStart(6, '0')}`,
        sequence: 1,
        quantityMilli: 1_000,
        invoiceLocalUuid: firstInvoice,
        itemLocalUuid: firstItem,
        lineIndex: 0,
        requestHash: 'd'.repeat(64)
      }
    ])
    reconciliation.applyCoverage(first, owner, 'bootstrap', 't1')
    equal(repositories.stockAllocations.spendableMilli(ALLOC_A), 9_000)

    // A second, independent sale commits sequence 2 against the SAME allocation, and its boundary
    // is accepted, WITHOUT the allocation's own lifecycle_generation changing at all (still 3) —
    // proving lifecycle revision and consumption sequence are tracked independently.
    invoiceCounter += 1
    const secondInvoice = `00000000-0000-4000-8000-4${String(invoiceCounter).padStart(6, '0')}`
    const secondItem = `00000000-0000-4000-8000-5${String(invoiceCounter).padStart(6, '0')}`
    writeInvoiceSkeleton(database, secondInvoice, secondItem)

    const second = writeLocalJournal(database, ALLOC_A, 1, [
      {
        localUuid: `00000000-0000-4000-8000-6${String(invoiceCounter).padStart(6, '0')}`,
        sequence: 2,
        quantityMilli: 500,
        invoiceLocalUuid: secondInvoice,
        itemLocalUuid: secondItem,
        lineIndex: 0,
        requestHash: 'e'.repeat(64)
      }
    ])
    const outcome = reconciliation.applyCoverage(second, owner, 'invoice_upload', 't2')
    equal(outcome.kind, 'accepted')
    equal(repositories.stockAllocations.spendableMilli(ALLOC_A), 8_500)

    closeDatabase(database)
  }
)

// ---------------------------------------------------------------------------------------------
// Item 9: missing history, sequence gaps, wrong quantity/hash/generation, unsafe numeric values and
// impossible spendable amounts all fail closed without destroying evidence.
// ---------------------------------------------------------------------------------------------

databaseTest(
  'a boundary naming an unknown local allocation is rejected without a hold row',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { repositories, reconciliation } = setUp(database)

    const outcome = reconciliation.applyCoverage(emptyBoundary(ALLOC_A), owner, 'bootstrap', 'now')
    equal(outcome.kind, 'rejected')
    equal((outcome as { reason: string }).reason, 'unknown-allocation')
    // There is no grant identity to key a hold on, so none is written — confirmed, not assumed.
    equal(repositories.stockAllocations.findHold(ALLOC_A, 1), null)

    closeDatabase(database)
  }
)

databaseTest("a sequence beyond this device's own local history fails closed", (sandbox) => {
  const database = openTestDatabase(sandbox)
  const { repositories, reconciliation } = setUp(database)

  seedGrant(repositories, ALLOC_A, { grantedQuantityMilli: 10_000 })
  seedLocalConsumption(database, ALLOC_A, 1, 1, 3_000)

  const impossible = {
    allocationUuid: ALLOC_A,
    rightsGeneration: 1,
    acceptedConsumptionSequence: 5,
    acceptedConsumedQuantityMilli: 9_000,
    acceptedChainHash: 'a'.repeat(64)
  }
  const outcome = reconciliation.applyCoverage(impossible, owner, 'bootstrap', 'now')
  equal(outcome.kind, 'rejected')
  equal((outcome as { reason: string }).reason, 'sequence-beyond-local-history')
  equal(repositories.stockAllocations.spendableMilli(ALLOC_A), 0)
  equal(repositories.stockAllocations.findHold(ALLOC_A, 1)?.reason, 'coverage_inconsistent')

  // Local evidence is untouched by the rejection — the one committed row is still there.
  equal(
    (
      database
        .prepare(
          'SELECT COUNT(*) AS n FROM local_stock_allocation_consumptions WHERE allocation_uuid = ?'
        )
        .get(ALLOC_A) as { n: number }
    ).n,
    1
  )

  closeDatabase(database)
})

databaseTest(
  'a sequence gap in local history is an incomplete prefix, not a partial acceptance',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { repositories, reconciliation } = setUp(database)

    seedGrant(repositories, ALLOC_A, { grantedQuantityMilli: 10_000 })
    // Sequence 1 exists; sequence 2 is missing; sequence 3 exists — a genuine gap.
    seedLocalConsumption(database, ALLOC_A, 1, 1, 1_000)
    seedLocalConsumption(database, ALLOC_A, 1, 3, 1_000)

    const claimingTwo = {
      allocationUuid: ALLOC_A,
      rightsGeneration: 1,
      acceptedConsumptionSequence: 2,
      acceptedConsumedQuantityMilli: 2_000,
      acceptedChainHash: 'a'.repeat(64)
    }
    const outcome = reconciliation.applyCoverage(claimingTwo, owner, 'bootstrap', 'now')
    equal(outcome.kind, 'rejected')
    equal((outcome as { reason: string }).reason, 'incomplete-local-prefix')
    equal(repositories.stockAllocations.spendableMilli(ALLOC_A), 0)

    closeDatabase(database)
  }
)

databaseTest(
  'a quantity that disagrees with the local prefix sum fails closed as quantity-mismatch',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { repositories, reconciliation } = setUp(database)

    const boundary = seedGrantWithJournal(database, repositories, ALLOC_A, 10_000, [3_000])
    const wrongQuantity = { ...boundary, acceptedConsumedQuantityMilli: 4_000 }

    const outcome = reconciliation.applyCoverage(wrongQuantity, owner, 'bootstrap', 'now')
    equal(outcome.kind, 'rejected')
    equal((outcome as { reason: string }).reason, 'quantity-mismatch')

    closeDatabase(database)
  }
)

databaseTest(
  'a hash that disagrees with the recomputed journal chain fails closed as hash-mismatch',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { repositories, reconciliation } = setUp(database)

    const boundary = seedGrantWithJournal(database, repositories, ALLOC_A, 10_000, [3_000])
    const wrongHash = { ...boundary, acceptedChainHash: '9'.repeat(64) }

    const outcome = reconciliation.applyCoverage(wrongHash, owner, 'bootstrap', 'now')
    equal(outcome.kind, 'rejected')
    equal((outcome as { reason: string }).reason, 'hash-mismatch')

    closeDatabase(database)
  }
)

databaseTest(
  's=0 requires exactly q=0 and the backend initial hash, never a fabricated empty boundary',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { repositories, reconciliation } = setUp(database)

    seedGrant(repositories, ALLOC_A, { grantedQuantityMilli: 10_000 })

    const wrongInitialHash = {
      allocationUuid: ALLOC_A,
      rightsGeneration: 1,
      acceptedConsumptionSequence: 0,
      acceptedConsumedQuantityMilli: 0,
      acceptedChainHash: '7'.repeat(64)
    }
    const outcome = reconciliation.applyCoverage(wrongInitialHash, owner, 'bootstrap', 'now')
    equal(outcome.kind, 'rejected')
    equal((outcome as { reason: string }).reason, 'hash-mismatch')

    // The real initial hash is accepted.
    const correct = reconciliation.applyCoverage(emptyBoundary(ALLOC_A), owner, 'bootstrap', 'now')
    equal(correct.kind, 'accepted')

    closeDatabase(database)
  }
)

databaseTest(
  'a rights-generation mismatch is rejected, never silently rebased onto the current grant',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { repositories, reconciliation } = setUp(database)

    seedGrant(repositories, ALLOC_A, { grantedQuantityMilli: 10_000, rightsGeneration: 1 })

    const wrongGeneration = {
      allocationUuid: ALLOC_A,
      rightsGeneration: 2,
      acceptedConsumptionSequence: 0,
      acceptedConsumedQuantityMilli: 0,
      acceptedChainHash: allocationJournalInitialHash(ALLOC_A, 2)
    }
    const outcome = reconciliation.applyCoverage(wrongGeneration, owner, 'bootstrap', 'now')
    equal(outcome.kind, 'rejected')
    equal((outcome as { reason: string }).reason, 'generation-mismatch')

    closeDatabase(database)
  }
)

databaseTest(
  'unsafe numeric values and a malformed hash fail closed as out-of-bounds/malformed-hash',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { repositories, reconciliation } = setUp(database)

    seedGrant(repositories, ALLOC_A, { grantedQuantityMilli: 10_000 })

    const negativeSequence = {
      allocationUuid: ALLOC_A,
      rightsGeneration: 1,
      acceptedConsumptionSequence: -1,
      acceptedConsumedQuantityMilli: 0,
      acceptedChainHash: allocationJournalInitialHash(ALLOC_A, 1)
    }
    const exceedsGrant = {
      allocationUuid: ALLOC_A,
      rightsGeneration: 1,
      acceptedConsumptionSequence: 1,
      acceptedConsumedQuantityMilli: 999_999_999,
      acceptedChainHash: allocationJournalInitialHash(ALLOC_A, 1)
    }
    const unsafeInteger = {
      allocationUuid: ALLOC_A,
      rightsGeneration: 1,
      acceptedConsumptionSequence: Number.MAX_SAFE_INTEGER + 10,
      acceptedConsumedQuantityMilli: 0,
      acceptedChainHash: allocationJournalInitialHash(ALLOC_A, 1)
    }
    const malformedHash = {
      allocationUuid: ALLOC_A,
      rightsGeneration: 1,
      acceptedConsumptionSequence: 0,
      acceptedConsumedQuantityMilli: 0,
      acceptedChainHash: 'not-a-hash'
    }

    for (const [incoming, reason] of [
      [negativeSequence, 'out-of-bounds'],
      [exceedsGrant, 'out-of-bounds'],
      [unsafeInteger, 'out-of-bounds'],
      [malformedHash, 'malformed-hash']
    ] as const) {
      const outcome = reconciliation.applyCoverage(incoming, owner, 'bootstrap', 'now')
      equal(outcome.kind, 'rejected', JSON.stringify(incoming))
      equal((outcome as { reason: string }).reason, reason)
    }

    closeDatabase(database)
  }
)

databaseTest(
  'an impossible spendable amount (uncovered local evidence exceeding the grant) fails closed, never clamped',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { repositories, reconciliation } = setUp(database)

    // A boundary at s=1/q=3000 is otherwise perfectly valid...
    const validBoundary = seedGrantWithJournal(database, repositories, ALLOC_A, 10_000, [3_000])

    // ...but a directly-inserted (bypassing checkout math on purpose) later local row is far larger
    // than what the grant could ever have allowed, simulating corrupted/impossible local evidence.
    seedLocalConsumption(database, ALLOC_A, 1, 2, 50_000)

    const outcome = reconciliation.applyCoverage(validBoundary, owner, 'bootstrap', 'now')
    equal(outcome.kind, 'rejected')
    equal((outcome as { reason: string }).reason, 'impossible-spendable')
    equal(repositories.stockAllocations.spendableMilli(ALLOC_A), 0)

    // Evidence is never destroyed to make the impossible balance disappear.
    equal(
      (
        database
          .prepare(
            'SELECT COUNT(*) AS n FROM local_stock_allocation_consumptions WHERE allocation_uuid = ?'
          )
          .get(ALLOC_A) as { n: number }
      ).n,
      2
    )

    closeDatabase(database)
  }
)

// ---------------------------------------------------------------------------------------------
// Item 11 (partial — the reconciliation-service half): a rejected boundary's hold is durable and is
// never cleared by anything other than a fresh acceptance that actually re-verifies the evidence.
// ---------------------------------------------------------------------------------------------

databaseTest(
  'a hold is cleared only by a subsequent boundary that actually verifies, never by a retry of the same bad one',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { repositories, reconciliation } = setUp(database)

    const boundary = seedGrantWithJournal(database, repositories, ALLOC_A, 10_000, [3_000])
    const bad = { ...boundary, acceptedConsumedQuantityMilli: 4_000 }

    reconciliation.applyCoverage(bad, owner, 'bootstrap', 't1')
    ok(repositories.stockAllocations.findHold(ALLOC_A, 1) !== null)

    // Retrying the exact same bad evidence does not clear the hold.
    reconciliation.applyCoverage(bad, owner, 'bootstrap', 't2')
    ok(repositories.stockAllocations.findHold(ALLOC_A, 1) !== null)
    equal(repositories.stockAllocations.spendableMilli(ALLOC_A), 0)

    // Only genuinely valid evidence clears it.
    const good = reconciliation.applyCoverage(boundary, owner, 'bootstrap', 't3')
    equal(good.kind, 'accepted')
    equal(repositories.stockAllocations.findHold(ALLOC_A, 1), null)
    equal(repositories.stockAllocations.spendableMilli(ALLOC_A), 7_000)

    closeDatabase(database)
  }
)
