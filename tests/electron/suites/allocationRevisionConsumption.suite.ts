import { equal, throws } from 'node:assert/strict'
import { closeDatabase, type SqliteDatabase } from '../../../src/main/database/connection'
import type { StockAllocationRepository } from '../../../src/main/repositories/stockAllocation.repository'
import { readCommitted } from '../support/committedState'
import { realRepositories } from '../support/realRepositories'
import { databaseTest, type DatabaseSandbox } from '../support/sandbox'
import { openExistingTestDatabase, openTestDatabase } from '../support/openTestDatabase'
import { grant } from '../support/allocationScenario'

/**
 * Reproduced live on 2026-09-29 (disposable backend, allocation mode): after a partial sale from a
 * prepared grant uploaded, "Refresh workstation data" failed in main with "The allocation revision
 * conflicts with the active local allocation snapshot". Two mechanisms, both at an EQUAL
 * `stock_allocation_revision`:
 *
 *  1. the server advanced the grant's `consumed_quantity_milli` (non-final consumption writes no
 *     lifecycle audit, so `revision()` = max(audit.id) does not move — documented: "The
 *     device-wide lifecycle revision is not a coverage signal", bh-04a §232);
 *  2. a preparation grant ingested incrementally (joined to the current local revision) was newer
 *     than the bootstrap's own allocation read, so the equal-revision snapshot did not name it.
 *
 * Lifecycle-bound fields stay strictly equal at an equal revision; consumption is validated as a
 * monotonic, self-consistent advance against a persisted high-water mark.
 */

const A = '00000000-0000-4000-8000-00000000e001'
const B = '00000000-0000-4000-8000-00000000e002'
const OBSERVED = '2026-09-29T12:00:00.000Z'

function consumed(milli: number): {
  consumedQuantityMilli: number
  remainingQuantityMilli: number
} {
  return { consumedQuantityMilli: milli, remainingQuantityMilli: 10_000 - milli }
}

function install(
  database: SqliteDatabase,
  repository: StockAllocationRepository,
  revision: number,
  grants: ReturnType<typeof grant>[]
): void {
  // persistSnapshot runs the allocation ingest inside its install transaction; mirror that here so
  // a refusal is shown to roll back every write, including the validation mark.
  database.transaction(() =>
    repository.ingestBootstrapSnapshot(revision, grants, OBSERVED, 'reconciliation_v2')
  )()
}

function mark(sandbox: DatabaseSandbox, allocationUuid: string): number | null {
  // Read through an independent connection: only committed state counts as accepted evidence.
  const rows: Array<{ m: number }> = readCommitted(
    sandbox,
    'SELECT consumed_high_water_milli AS m FROM stock_allocation_validation_marks WHERE allocation_uuid = ?',
    [allocationUuid]
  )
  return rows[0]?.m ?? null
}

databaseTest('equal revision: an advanced consumed quantity is accepted (0 → 2)', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repository = realRepositories(database).stockAllocations
  install(database, repository, 4, [grant(A)])
  const spendableBefore = repository.spendableMilli(A)

  install(database, repository, 4, [grant(A, consumed(2_000))])

  equal(mark(sandbox, A), 2_000)
  equal(repository.getCapability()?.revision, 4)
  // The mark is validation evidence only: spendability is computed exactly as before.
  equal(repository.spendableMilli(A), spendableBefore)
  closeDatabase(database)
})

databaseTest(
  'equal revision: a consumed regression below the accepted high-water is refused and rolls back',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repository = realRepositories(database).stockAllocations
    install(database, repository, 4, [grant(A)])
    install(database, repository, 4, [grant(A, consumed(2_000))])

    throws(() => install(database, repository, 4, [grant(A, consumed(1_000))]), /regress/i)
    equal(mark(sandbox, A), 2_000)
    closeDatabase(database)
  }
)

databaseTest('the high-water mark survives a restart between responses', (sandbox) => {
  const first = openTestDatabase(sandbox)
  const firstRepository = realRepositories(first).stockAllocations
  install(first, firstRepository, 4, [grant(A)])
  install(first, firstRepository, 4, [grant(A, consumed(2_000))])
  closeDatabase(first)

  const reopened = openExistingTestDatabase(sandbox)
  const repository = realRepositories(reopened).stockAllocations
  throws(() => install(reopened, repository, 4, [grant(A, consumed(1_000))]), /regress/i)
  equal(mark(sandbox, A), 2_000)
  closeDatabase(reopened)
})

databaseTest('bootstrap then top-up replay share one validation mark', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repository = realRepositories(database).stockAllocations
  install(database, repository, 4, [grant(A)])
  install(database, repository, 4, [grant(A, consumed(2_000))])

  // A late top-up replay of the same grant that shows less consumption than already accepted.
  throws(
    () =>
      database.transaction(() =>
        repository.ingestTopUpGrants([grant(A, consumed(1_000))], OBSERVED)
      )(),
    /regress/i
  )
  // A replay that shows more is accepted exactly once and is not rewritten over the envelope.
  database.transaction(() => repository.ingestTopUpGrants([grant(A, consumed(3_000))], OBSERVED))()
  equal(mark(sandbox, A), 3_000)
  equal(repository.findGrantByUuid(A)?.serverConsumedQuantityMilli, 0)
  closeDatabase(database)
})

databaseTest('top-up replay then bootstrap share one validation mark', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repository = realRepositories(database).stockAllocations
  install(database, repository, 4, [grant(A)])
  database.transaction(() => repository.ingestTopUpGrants([grant(A, consumed(3_000))], OBSERVED))()

  throws(() => install(database, repository, 4, [grant(A, consumed(2_000))]), /regress/i)
  install(database, repository, 4, [grant(A, consumed(3_000))])
  equal(mark(sandbox, A), 3_000)
  closeDatabase(database)
})

databaseTest(
  'equal revision: an incremental grant newer than the snapshot read is not a conflict',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repository = realRepositories(database).stockAllocations
    install(database, repository, 4, [grant(A)])
    // A preparation/top-up grant created after the bootstrap's own allocation read.
    database.transaction(() =>
      repository.ingestTopUpGrants([grant(B, { serverSequence: 2 })], OBSERVED)
    )()

    install(database, repository, 4, [grant(A, consumed(1_000))])

    equal(repository.getCapability()?.revision, 4)
    equal(repository.findGrantByUuid(B)?.lastObservedRevision, 4)
    closeDatabase(database)
  }
)

databaseTest(
  'equal revision: a bootstrap-sourced grant missing from the snapshot is still a conflict',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repository = realRepositories(database).stockAllocations
    install(database, repository, 4, [grant(A), grant(B, { serverSequence: 2 })])

    throws(() => install(database, repository, 4, [grant(A)]), /conflicts/i)
    closeDatabase(database)
  }
)

databaseTest(
  'equal revision: an unknown grant or a lifecycle change is still a conflict',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repository = realRepositories(database).stockAllocations
    install(database, repository, 4, [grant(A)])

    throws(
      () => install(database, repository, 4, [grant(A), grant(B, { serverSequence: 2 })]),
      /conflicts/i
    )
    throws(
      () =>
        install(database, repository, 4, [grant(A, { consumeUntil: '2098-01-01T00:00:00.000Z' })]),
      /conflicts/i
    )
    throws(
      () =>
        install(database, repository, 4, [
          grant(A, { consumedQuantityMilli: 2_000, remainingQuantityMilli: 9_000 })
        ]),
      /conflicts|inconsistent/i
    )
    closeDatabase(database)
  }
)
