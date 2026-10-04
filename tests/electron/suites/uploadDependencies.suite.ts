import { deepEqual, equal } from 'node:assert/strict'

import { closeDatabase, type SqliteDatabase } from '../../../src/main/database/connection'
import { databaseTest } from '../support/sandbox'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories, type RealRepositories } from '../support/realRepositories'
import {
  COMPANY_UUID,
  DEVICE_UUID,
  HASH_64,
  NOW,
  grant as buildGrant,
  insertRow,
  owner,
  writeInvoiceSkeleton,
  writeLocalJournal
} from '../support/allocationScenario'

/**
 * Rev 4 §10.3 / §10.3a on real SQLite: an invoice whose consumption on chain
 * `(allocation_uuid, rights_generation)` is `s` is sent only after verified server evidence for its
 * EXTERNAL predecessor `s − 1`; several consumptions of one chain inside one invoice only need the
 * external predecessor; unrelated invoices are never blocked; a skipped candidate is untouched.
 */

const ALLOC = '00000000-0000-4000-8000-00000000e001'
const INV1 = '00000000-0000-4000-8000-e10000000e01'
const INV2 = '00000000-0000-4000-8000-e20000000e02'
const INV3 = '00000000-0000-4000-8000-e30000000e03'
const UNRELATED = '00000000-0000-4000-8000-e90000000e09'

function item(invoice: string, index: number): string {
  return `${invoice.slice(0, 30)}a0000${index}`
}

function seedGrant(repositories: RealRepositories, allocationUuid: string, generation = 1): void {
  repositories.stockAllocations.ingestBootstrapSnapshot(
    1,
    [buildGrant(allocationUuid, { rightsGeneration: generation })],
    NOW,
    'reconciliation_v2'
  )
}

let queueSequence = 0

/** One invoice, its upload row (in commit order), and `sequences` consumptions of `ALLOC`. */
function invoiceWith(
  database: SqliteDatabase,
  invoice: string,
  sequences: readonly number[],
  allocationUuid = ALLOC,
  generation = 1
): void {
  writeInvoiceSkeleton(database, invoice, item(invoice, 0), { payloadJson: '{}' })
  queueSequence += 1
  database
    .prepare('UPDATE sync_queue SET queue_sequence = ? WHERE local_aggregate_uuid = ?')
    .run(queueSequence, invoice)
  sequences.forEach((sequence, index) => {
    if (index > 0) {
      insertRow(database, 'local_invoice_items', {
        local_uuid: item(invoice, index),
        invoice_local_uuid: invoice,
        line_index: index,
        product_uuid: '00000000-0000-4000-8000-000000000b01',
        product_name: 'Widget',
        track_stock: 1,
        quantity_milli: 1000,
        unit_price_amount: 1000,
        currency: 'USD',
        price_revision: HASH_64,
        tax_mode: 'none',
        tax_rate_basis_points: 0,
        tax_revision: HASH_64,
        discount_value: 0,
        subtotal_amount: 1000,
        discount_amount: 0,
        tax_amount: 0,
        total_amount: 1000,
        allocation_covered_milli: 1000,
        uncovered_milli: 0,
        created_at: NOW
      })
    }
    writeLocalJournal(database, allocationUuid, generation, [
      {
        localUuid: `${invoice.slice(0, 30)}c0${String(sequence).padStart(2, '0')}${index}`,
        sequence,
        quantityMilli: 1000,
        invoiceLocalUuid: invoice,
        itemLocalUuid: item(invoice, index),
        lineIndex: index,
        requestHash: HASH_64
      }
    ])
  })
}

function setState(database: SqliteDatabase, invoice: string, state: string): void {
  database
    .prepare('UPDATE sync_queue SET state = ? WHERE local_aggregate_uuid = ?')
    .run(state, invoice)
}

function build(sandbox: Parameters<Parameters<typeof databaseTest>[1]>[0]): {
  database: SqliteDatabase
  repositories: RealRepositories
  deps: RealRepositories['uploadDependencies']
} {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  queueSequence = 0
  seedGrant(repositories, ALLOC)
  // INV1: seq 1. INV2: seq 2 AND 3 (several consumptions of one chain, §10.3a). INV3: seq 4.
  invoiceWith(database, INV1, [1])
  invoiceWith(database, INV2, [2, 3])
  invoiceWith(database, INV3, [4])
  invoiceWith(database, UNRELATED, [])
  return { database, repositories, deps: repositories.uploadDependencies }
}

function blockOf(repositories: RealRepositories, invoice: string): string {
  const decision = repositories.uploadDependencies.evaluate(invoice)
  return decision.eligible ? 'eligible' : decision.block
}

databaseTest('the chain head and unrelated invoices are eligible; dependents wait', (sandbox) => {
  const { database, repositories } = build(sandbox)
  equal(blockOf(repositories, INV1), 'eligible')
  equal(blockOf(repositories, INV2), 'predecessor-pending', 'only the EXTERNAL predecessor (1)')
  equal(blockOf(repositories, INV3), 'predecessor-pending')
  equal(blockOf(repositories, UNRELATED), 'eligible')
  closeDatabase(database)
})

databaseTest(
  'a held candidate is skipped unchanged and an unrelated invoice is claimed',
  (sandbox) => {
    const { database, repositories } = build(sandbox)
    const accept = (candidate: { invoiceLocalUuid: string }): boolean =>
      repositories.uploadDependencies.evaluate(candidate.invoiceLocalUuid).eligible
    const before = database
      .prepare(
        'SELECT local_aggregate_uuid, state, attempt_count, next_attempt_at, payload_hash, idempotency_key FROM sync_queue ORDER BY queue_sequence'
      )
      .all()

    const first = repositories.syncQueue.claimNextInvoiceUpload(owner, NOW, accept)
    equal(first?.invoiceLocalUuid, INV1, 'queue_sequence order')
    const second = repositories.syncQueue.claimNextInvoiceUpload(owner, NOW, accept)
    equal(second?.invoiceLocalUuid, UNRELATED, 'INV2/INV3 are held; the unrelated one proceeds')
    equal(repositories.syncQueue.claimNextInvoiceUpload(owner, NOW, accept), null)

    const after = database
      .prepare(
        'SELECT local_aggregate_uuid, state, attempt_count, next_attempt_at, payload_hash, idempotency_key FROM sync_queue WHERE local_aggregate_uuid IN (?, ?) ORDER BY queue_sequence'
      )
      .all(INV2, INV3)
    deepEqual(
      after,
      (before as Array<{ local_aggregate_uuid: string }>).filter((row) =>
        [INV2, INV3].includes(row.local_aggregate_uuid)
      ),
      'held rows are byte-identical'
    )
    closeDatabase(database)
  }
)

databaseTest('a synced predecessor releases the next invoice only', (sandbox) => {
  const { database, repositories } = build(sandbox)
  setState(database, INV1, 'synced')
  equal(blockOf(repositories, INV2), 'eligible')
  equal(blockOf(repositories, INV3), 'predecessor-pending', 'INV2 has not been accepted yet')
  closeDatabase(database)
})

databaseTest('coverage releases only with a matching chain hash', (sandbox) => {
  const { database, repositories } = build(sandbox)
  const localHash = (
    database
      .prepare(
        'SELECT chain_hash FROM local_stock_allocation_consumptions WHERE allocation_uuid = ? AND consumption_sequence = 3'
      )
      .get(ALLOC) as { chain_hash: string }
  ).chain_hash
  const boundary = {
    allocationUuid: ALLOC,
    rightsGeneration: 1,
    companyUuid: COMPANY_UUID,
    deviceUuid: DEVICE_UUID,
    acceptedConsumptionSequence: 3,
    acceptedConsumedQuantityMilli: 3000,
    source: 'top_up' as const,
    observedAt: NOW
  }

  repositories.stockAllocations.writeCoverageBoundary({
    ...boundary,
    acceptedChainHash: 'f'.repeat(64)
  })
  equal(blockOf(repositories, INV3), 'predecessor-pending', 'a hash mismatch is not progress')

  database.prepare('DELETE FROM stock_allocation_coverage_boundaries').run()
  repositories.stockAllocations.writeCoverageBoundary({ ...boundary, acceptedChainHash: localHash })
  equal(blockOf(repositories, INV3), 'eligible', 'verified coverage of 1..3')
  closeDatabase(database)
})

databaseTest(
  'a terminal predecessor holds the dependent with a support state; unrelated stay free',
  (sandbox) => {
    const { database, repositories } = build(sandbox)
    setState(database, INV1, 'rejected')
    equal(blockOf(repositories, INV2), 'predecessor-terminal')
    const held = repositories.uploadDependencies.listHeld(owner, 10)
    equal(held.length, 1, 'INV3 waits on a PENDING predecessor, so it is not a support item')
    equal(held[0].invoiceLocalUuid, INV2)
    equal(held[0].predecessor?.invoiceLocalUuid, INV1)
    equal(held[0].predecessor?.queueState, 'rejected')
    equal(blockOf(repositories, UNRELATED), 'eligible')

    setState(database, INV1, 'conflict')
    equal(blockOf(repositories, INV2), 'predecessor-terminal', '409 with an unknown outcome')
    closeDatabase(database)
  }
)

databaseTest('a disposition chain-break hold releases the dependent (PS6b)', (sandbox) => {
  const { database, repositories } = build(sandbox)
  setState(database, INV1, 'rejected')
  insertRow(database, 'invoice_disposition_applications', {
    invoice_local_uuid: INV1,
    disposition_uuid: '00000000-0000-4000-8000-0000000d1590',
    decision: 'reject_permanently',
    result_version: 1,
    result_json: '{}',
    result_hash: HASH_64,
    queue_failure_json: '{}',
    queue_failure_hash: HASH_64,
    request_hash: HASH_64,
    remote_invoice_uuid: null,
    applied_at: NOW
  })
  insertRow(database, 'stock_allocation_disposition_holds', {
    allocation_uuid: ALLOC,
    rights_generation: 1,
    invoice_local_uuid: INV1,
    first_overridden_sequence: 1,
    reason: 'invoice_disposition_chain_break',
    created_at: NOW
  })
  equal(blockOf(repositories, INV2), 'eligible')
  closeDatabase(database)
})

databaseTest('a different rights generation is an independent chain', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  queueSequence = 0
  const other = '00000000-0000-4000-8000-00000000e002'
  seedGrant(repositories, ALLOC)
  repositories.stockAllocations.ingestTopUpGrants([buildGrant(other, { rightsGeneration: 2 })], NOW)
  invoiceWith(database, INV1, [1])
  invoiceWith(database, INV2, [1], other, 2)
  equal(blockOf(repositories, INV2), 'eligible')
  closeDatabase(database)
})

databaseTest('restart recomputes the same decisions from persisted rows', (sandbox) => {
  const { database, repositories } = build(sandbox)
  setState(database, INV1, 'rejected')
  const before = [INV1, INV2, INV3, UNRELATED].map((invoice) => blockOf(repositories, invoice))
  const restarted = realRepositories(database)
  deepEqual(
    [INV1, INV2, INV3, UNRELATED].map((invoice) => blockOf(restarted, invoice)),
    before
  )
  closeDatabase(database)
})

databaseTest('the split numbers one invoice’s consumptions contiguously (§10.3a)', (sandbox) => {
  const { database, repositories } = build(sandbox)
  // Proven on the fixture above (INV2 = 2,3). A gap inside one invoice is reported, never guessed.
  database
    .prepare(
      'UPDATE local_stock_allocation_consumptions SET consumption_sequence = 7 WHERE invoice_local_uuid = ? AND consumption_sequence = 3'
    )
    .run(INV2)
  equal(blockOf(repositories, INV2), 'non-contiguous')
  closeDatabase(database)
})
