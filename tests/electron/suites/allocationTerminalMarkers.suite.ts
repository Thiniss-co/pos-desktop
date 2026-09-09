import { equal } from 'node:assert/strict'

import { closeDatabase, type SqliteDatabase } from '../../../src/main/database/connection'
import { AllocationReconciliationService } from '../../../src/main/services/allocationReconciliation.service'
import { databaseTest } from '../support/sandbox'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories, type RealRepositories } from '../support/realRepositories'
import {
  WAREHOUSE_UUID,
  emptyBoundary,
  grant as buildGrant,
  owner,
  writeInvoiceSkeleton,
  writeLocalJournal
} from '../support/allocationScenario'

/**
 * BH-04B-3 §7 items 10 and 12: terminal-marker ingestion, protection against stale state, and
 * `last_observed_revision` interaction across allocations — proven against real repositories over
 * real SQLite.
 */

const ALLOC_A = '00000000-0000-4000-8000-00000000b001'
const ALLOC_B = '00000000-0000-4000-8000-00000000b002'
const UNKNOWN_ALLOC = '00000000-0000-4000-8000-00000000c999'

function setUp(database: SqliteDatabase): {
  readonly repositories: RealRepositories
  readonly reconciliation: AllocationReconciliationService
} {
  const repositories = realRepositories(database)
  return { repositories, reconciliation: repositories.allocationReconciliation }
}

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

function marker(
  allocationUuid: string,
  overrides: Partial<{
    readonly status: 'released' | 'consumed'
    readonly lifecycleGeneration: number
    readonly terminalRevision: number
  }> = {}
): {
  allocationUuid: string
  status: 'released' | 'consumed'
  lifecycleGeneration: number
  terminalRevision: number
} {
  return {
    allocationUuid,
    status: 'released',
    lifecycleGeneration: 2,
    terminalRevision: 500,
    ...overrides
  }
}

// ---------------------------------------------------------------------------------------------
// Item 10: marker ingestion, unknown local allocation, stale active envelope, restart, and later
// upload replay cannot revive terminal rights.
// ---------------------------------------------------------------------------------------------

databaseTest(
  'a terminal marker is persisted and immediately makes the grant unusable',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { repositories, reconciliation } = setUp(database)

    seedGrant(repositories, ALLOC_A, { grantedQuantityMilli: 10_000 })
    reconciliation.applyCoverage(emptyBoundary(ALLOC_A), owner, 'bootstrap', 'now')
    equal(repositories.stockAllocations.spendableMilli(ALLOC_A), 10_000)

    reconciliation.applyTerminalMarker(marker(ALLOC_A), owner, 'now')

    const stored = repositories.stockAllocations.findTerminalMarker(ALLOC_A)
    equal(stored?.status, 'released')
    equal(stored?.lifecycleGeneration, 2)
    equal(stored?.terminalRevision, 500)
    // Terminal state removes the grant from the usable set outright, not merely reduces its balance.
    equal(repositories.stockAllocations.spendableMilli(ALLOC_A), 0)

    const usable = repositories.stockAllocations.usableGrantsForProduct(
      { ...owner, warehouseUuid: WAREHOUSE_UUID },
      buildGrant(ALLOC_A).productUuid,
      '2026-01-01T00:00:00.000Z'
    )
    equal(usable.length, 0)

    closeDatabase(database)
  }
)

databaseTest('a marker for an allocation absent locally is retained anyway', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const { reconciliation, repositories } = setUp(database)

  // No grant for UNKNOWN_ALLOC exists locally at all.
  reconciliation.applyTerminalMarker(marker(UNKNOWN_ALLOC, { terminalRevision: 42 }), owner, 'now')

  const stored = repositories.stockAllocations.findTerminalMarker(UNKNOWN_ALLOC)
  equal(stored?.allocationUuid, UNKNOWN_ALLOC)
  equal(stored?.terminalRevision, 42)

  closeDatabase(database)
})

databaseTest(
  'a later stale active envelope (an older bootstrap re-listing the allocation) cannot undo a terminal marker',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { repositories, reconciliation } = setUp(database)

    seedGrant(repositories, ALLOC_A, { grantedQuantityMilli: 10_000, lifecycleGeneration: 2 })
    reconciliation.applyTerminalMarker(marker(ALLOC_A, { lifecycleGeneration: 2 }), owner, 'now')
    equal(repositories.stockAllocations.spendableMilli(ALLOC_A), 0)

    // A stale envelope still reporting the allocation as active tries to re-ingest it via top-up —
    // its lifecycle_generation must not regress the stored grant, and even if the grant row itself
    // is re-touched, the marker (a separate, permanent table) is untouched and keeps denying spend.
    seedGrant(repositories, ALLOC_A, { grantedQuantityMilli: 10_000, lifecycleGeneration: 2 })

    equal(repositories.stockAllocations.findTerminalMarker(ALLOC_A)?.status, 'released')
    equal(repositories.stockAllocations.spendableMilli(ALLOC_A), 0)

    closeDatabase(database)
  }
)

databaseTest(
  'omission from a bootstrap list, and process restart, cannot revive a terminal marker',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { repositories, reconciliation } = setUp(database)

    seedGrant(repositories, ALLOC_A, { grantedQuantityMilli: 10_000 })
    reconciliation.applyTerminalMarker(marker(ALLOC_A), owner, 'now')
    closeDatabase(database)

    // "Restart": reopen the same on-disk database, exactly like the app reopening its connection.
    const reopened = openTestDatabase(sandbox)
    const { repositories: reopenedRepositories } = setUp(reopened)

    equal(reopenedRepositories.stockAllocations.findTerminalMarker(ALLOC_A)?.status, 'released')
    equal(reopenedRepositories.stockAllocations.spendableMilli(ALLOC_A), 0)

    closeDatabase(reopened)
  }
)

databaseTest(
  'a later invoice-upload replay that reports current coverage cannot revive a terminal allocation',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { repositories, reconciliation } = setUp(database)

    seedGrant(repositories, ALLOC_A, { grantedQuantityMilli: 10_000 })
    reconciliation.applyTerminalMarker(marker(ALLOC_A), owner, 'now')

    // An invoice-upload response replay reports a coverage boundary for the now-terminal
    // allocation (e.g. the server's response to an old, already-uploaded invoice). Coverage
    // application itself is orthogonal to marker state — it may still record a boundary — but that
    // boundary must never make a terminally marked grant spendable again.
    const outcome = reconciliation.applyCoverage(
      emptyBoundary(ALLOC_A),
      owner,
      'invoice_upload',
      'later'
    )
    equal(outcome.kind, 'accepted')
    equal(repositories.stockAllocations.spendableMilli(ALLOC_A), 0)

    closeDatabase(database)
  }
)

databaseTest(
  'terminal state is permanent for the allocation identity; only a fresh grant identity carries new rights',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { repositories, reconciliation } = setUp(database)

    seedGrant(repositories, ALLOC_A, { grantedQuantityMilli: 10_000 })
    reconciliation.applyTerminalMarker(marker(ALLOC_A), owner, 'now')
    equal(repositories.stockAllocations.spendableMilli(ALLOC_A), 0)

    // A brand-new allocation identity is unaffected by ALLOC_A's terminal marker.
    seedGrant(repositories, ALLOC_B, { grantedQuantityMilli: 4_000 })
    reconciliation.applyCoverage(emptyBoundary(ALLOC_B), owner, 'bootstrap', 'now')
    equal(repositories.stockAllocations.spendableMilli(ALLOC_B), 4_000)

    closeDatabase(database)
  }
)

databaseTest(
  'inconsistent terminal evidence (uncovered local consumption) holds the grant instead of trusting either side',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { repositories, reconciliation } = setUp(database)

    seedGrant(repositories, ALLOC_A, { grantedQuantityMilli: 10_000 })
    // A local sale committed 3.000, but no coverage boundary has ever been accepted for it.
    writeInvoiceSkeleton(
      database,
      '00000000-0000-4000-8000-100000000001',
      '00000000-0000-4000-8000-100000000002'
    )
    writeLocalJournal(database, ALLOC_A, 1, [
      {
        localUuid: '00000000-0000-4000-8000-100000000003',
        sequence: 1,
        quantityMilli: 3_000,
        invoiceLocalUuid: '00000000-0000-4000-8000-100000000001',
        itemLocalUuid: '00000000-0000-4000-8000-100000000002',
        lineIndex: 0,
        requestHash: 'a'.repeat(64)
      }
    ])

    // A terminal marker now arrives claiming the allocation is fully released — but 3.000 of local
    // evidence is uncovered by any accepted boundary. Pending invoice/consumption evidence must not
    // be deleted, and the inconsistency must not be silently trusted either way.
    reconciliation.applyTerminalMarker(marker(ALLOC_A), owner, 'now')

    equal(repositories.stockAllocations.findTerminalMarker(ALLOC_A)?.status, 'released')
    equal(repositories.stockAllocations.findHold(ALLOC_A, 1)?.reason, 'terminal_conflict')
    equal(repositories.stockAllocations.spendableMilli(ALLOC_A), 0)
    // The local consumption evidence itself is untouched.
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
  }
)

databaseTest(
  'a non-regressing terminal generation/revision updates the marker; a regressing one does not',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { repositories, reconciliation } = setUp(database)

    seedGrant(repositories, ALLOC_A, { grantedQuantityMilli: 10_000 })
    reconciliation.applyTerminalMarker(
      marker(ALLOC_A, { lifecycleGeneration: 2, terminalRevision: 500 }),
      owner,
      'now'
    )

    // A regressing revision/generation is rejected by the write itself (SQL WHERE guard).
    reconciliation.applyTerminalMarker(
      marker(ALLOC_A, { lifecycleGeneration: 1, terminalRevision: 100 }),
      owner,
      'later'
    )
    let stored = repositories.stockAllocations.findTerminalMarker(ALLOC_A)
    equal(stored?.lifecycleGeneration, 2)
    equal(stored?.terminalRevision, 500)

    // A non-regressing (advancing) one updates.
    reconciliation.applyTerminalMarker(
      marker(ALLOC_A, { lifecycleGeneration: 3, terminalRevision: 600 }),
      owner,
      'later2'
    )
    stored = repositories.stockAllocations.findTerminalMarker(ALLOC_A)
    equal(stored?.lifecycleGeneration, 3)
    equal(stored?.terminalRevision, 600)

    closeDatabase(database)
  }
)

databaseTest(
  'consumed allocations remain represented as ordinary status, not invented as a new lifecycle',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { repositories, reconciliation } = setUp(database)

    seedGrant(repositories, ALLOC_A, { grantedQuantityMilli: 10_000, status: 'consumed' })
    reconciliation.applyTerminalMarker(marker(ALLOC_A, { status: 'consumed' }), owner, 'now')

    equal(repositories.stockAllocations.findTerminalMarker(ALLOC_A)?.status, 'consumed')
    // A consumed allocation is still a marker like any other terminal one — no separate lifecycle
    // state was invented for it.
    equal(repositories.stockAllocations.spendableMilli(ALLOC_A), 0)

    closeDatabase(database)
  }
)

// ---------------------------------------------------------------------------------------------
// Item 12: a different allocation's terminal revision does not accidentally invalidate or revive
// rights through `last_observed_revision` handling.
// ---------------------------------------------------------------------------------------------

databaseTest(
  "a different allocation's terminal marker does not affect an unrelated allocation's spendability",
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { repositories, reconciliation } = setUp(database)

    seedGrant(repositories, ALLOC_A, { grantedQuantityMilli: 10_000 })
    seedGrant(repositories, ALLOC_B, { grantedQuantityMilli: 4_000 })
    reconciliation.applyCoverage(emptyBoundary(ALLOC_A), owner, 'bootstrap', 'now')
    reconciliation.applyCoverage(emptyBoundary(ALLOC_B), owner, 'bootstrap', 'now')

    // ALLOC_B terminalizes; ALLOC_A must be completely unaffected.
    reconciliation.applyTerminalMarker(marker(ALLOC_B), owner, 'now')

    equal(repositories.stockAllocations.spendableMilli(ALLOC_A), 10_000)
    equal(repositories.stockAllocations.spendableMilli(ALLOC_B), 0)
    equal(repositories.stockAllocations.findTerminalMarker(ALLOC_A), null)

    closeDatabase(database)
  }
)

databaseTest(
  'a fresh bootstrap after another allocation terminalizes still honours last_observed_revision for the survivor',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { repositories, reconciliation } = setUp(database)

    // Bootstrap 1: both allocations are live at revision 1.
    repositories.stockAllocations.ingestBootstrapSnapshot(
      1,
      [
        buildGrant(ALLOC_A, { grantedQuantityMilli: 10_000 }),
        buildGrant(ALLOC_B, { grantedQuantityMilli: 4_000 })
      ],
      '2026-09-06T00:00:00.000Z',
      'reconciliation_v2'
    )
    reconciliation.applyCoverage(emptyBoundary(ALLOC_A), owner, 'bootstrap', 'now')
    reconciliation.applyCoverage(emptyBoundary(ALLOC_B), owner, 'bootstrap', 'now')
    equal(repositories.stockAllocations.spendableMilli(ALLOC_A), 10_000)

    // Bootstrap 2: ALLOC_B has terminalized and is now omitted from the live list (as the backend
    // contract requires for released allocations); ALLOC_A is re-listed at the new revision.
    repositories.stockAllocations.ingestBootstrapSnapshot(
      2,
      [buildGrant(ALLOC_A, { grantedQuantityMilli: 10_000 })],
      '2026-09-06T01:00:00.000Z',
      'reconciliation_v2'
    )
    reconciliation.applyTerminalMarker(marker(ALLOC_B, { terminalRevision: 2 }), owner, 'now')

    // ALLOC_A's own `last_observed_revision` re-verification is untouched by ALLOC_B's
    // terminalization: it is still usable at the new revision, with its previously accepted
    // boundary intact (coverage is per-allocation, never shared).
    equal(repositories.stockAllocations.findGrantByUuid(ALLOC_A)?.lastObservedRevision, 2)
    equal(repositories.stockAllocations.spendableMilli(ALLOC_A), 10_000)
    equal(repositories.stockAllocations.spendableMilli(ALLOC_B), 0)

    closeDatabase(database)
  }
)

databaseTest(
  'a stale last_observed_revision correctly excludes a grant regardless of another allocation terminalizing',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { repositories, reconciliation } = setUp(database)

    repositories.stockAllocations.ingestBootstrapSnapshot(
      1,
      [buildGrant(ALLOC_A, { grantedQuantityMilli: 10_000 })],
      '2026-09-06T00:00:00.000Z',
      'reconciliation_v2'
    )
    reconciliation.applyCoverage(emptyBoundary(ALLOC_A), owner, 'bootstrap', 'now')

    // A NEW bootstrap at revision 2 omits ALLOC_A entirely (e.g. it expired/rotated out) — its
    // `last_observed_revision` is now stale relative to the new capability revision.
    repositories.stockAllocations.ingestBootstrapSnapshot(
      2,
      [buildGrant(ALLOC_B, { grantedQuantityMilli: 4_000 })],
      '2026-09-06T01:00:00.000Z',
      'reconciliation_v2'
    )
    reconciliation.applyCoverage(emptyBoundary(ALLOC_B), owner, 'bootstrap', 'now')

    // ALLOC_B terminalizing must not resurrect ALLOC_A's now-stale revision eligibility. Revision
    // gating lives in `usableGrantsForProduct()` (the actual eligibility query every real caller
    // goes through), never in `spendableMilli()` — which answers "how much of THIS already-eligible
    // grant is left" and was never the place old code checked `last_observed_revision` either.
    reconciliation.applyTerminalMarker(marker(ALLOC_B), owner, 'now')

    equal(repositories.stockAllocations.findGrantByUuid(ALLOC_A)?.lastObservedRevision, 1)
    const usable = repositories.stockAllocations.usableGrantsForProduct(
      { ...owner, warehouseUuid: WAREHOUSE_UUID },
      buildGrant(ALLOC_A).productUuid,
      '2026-01-01T00:00:00.000Z'
    )
    equal(
      usable.some((row) => row.allocationUuid === ALLOC_A),
      false
    )

    closeDatabase(database)
  }
)
