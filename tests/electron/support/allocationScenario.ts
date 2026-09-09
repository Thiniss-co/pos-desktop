import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { SqliteDatabase } from '../../../src/main/database/connection'
import type {
  BootstrapStockAllocationGrant,
  IncomingCoverageBoundary
} from '../../../src/main/repositories/stockAllocation.repository'
import {
  allocationItemLineUuid,
  allocationJournalAppend,
  allocationJournalInitialHash
} from '../../../src/main/services/allocationJournal'

/**
 * BH-04B-3 scenario builders.
 *
 * Rows are written with plain SQL rather than through the repositories on purpose: several suites
 * need to construct the *pre-migration* shape, or evidence a repository would refuse to write, and
 * a helper that could only produce valid state could not exercise the fail-closed paths at all.
 */

export const COMPANY_UUID = '00000000-0000-4000-8000-000000000c01'
export const DEVICE_UUID = '00000000-0000-4000-8000-000000000d01'
export const OTHER_COMPANY_UUID = '00000000-0000-4000-8000-000000000c02'
export const OTHER_DEVICE_UUID = '00000000-0000-4000-8000-000000000d02'
export const WAREHOUSE_UUID = '00000000-0000-4000-8000-000000000a01'
export const PRODUCT_UUID = '00000000-0000-4000-8000-000000000b01'
export const HASH_64 = 'a'.repeat(64)
export const NOW = '2026-09-06T00:00:00.000Z'
export const FAR_FUTURE = '2099-01-01T00:00:00.000Z'

export const owner = { companyUuid: COMPANY_UUID, deviceUuid: DEVICE_UUID }

/** The committed cross-language request-hash vector, shared byte-for-byte with pos-backend. */
export interface RequestHashGolden {
  readonly cases: readonly {
    readonly name: string
    readonly payload: Record<string, unknown>
    readonly requestHash: string
  }[]
}

export function requestHashGolden(): RequestHashGolden {
  return JSON.parse(
    readFileSync(
      resolve(process.cwd(), 'tests/fixtures/desktop-invoice-request-hash-golden.json'),
      'utf8'
    )
  ) as RequestHashGolden
}

export function goldenCase(name: string): RequestHashGolden['cases'][number] {
  const found = requestHashGolden().cases.find((entry) => entry.name === name)

  if (!found) {
    throw new Error(`No request-hash golden case named ${name}`)
  }

  return found
}

export function grant(
  allocationUuid: string,
  overrides: Partial<BootstrapStockAllocationGrant> = {}
): BootstrapStockAllocationGrant {
  return {
    allocationUuid,
    contractVersion: 1,
    companyUuid: COMPANY_UUID,
    deviceUuid: DEVICE_UUID,
    warehouseUuid: WAREHOUSE_UUID,
    productUuid: PRODUCT_UUID,
    serverSequence: 1,
    rightsGeneration: 1,
    lifecycleGeneration: 1,
    grantedQuantityMilli: 10_000,
    consumedQuantityMilli: 0,
    remainingQuantityMilli: 10_000,
    consumeUntil: FAR_FUTURE,
    status: 'active',
    envelopeHash: HASH_64,
    sealNonce: null,
    finalConsumptionSequence: null,
    finalConsumptionHash: null,
    receivedAt: NOW,
    sealedAt: null,
    acknowledgedAt: null,
    releasedAt: null,
    ...overrides
  }
}

/** The empty-journal boundary: sequence 0, quantity 0, and the exact journal-v1 initial hash. */
export function emptyBoundary(
  allocationUuid: string,
  rightsGeneration = 1
): IncomingCoverageBoundary {
  return {
    allocationUuid,
    rightsGeneration,
    acceptedConsumptionSequence: 0,
    acceptedConsumedQuantityMilli: 0,
    acceptedChainHash: allocationJournalInitialHash(allocationUuid, rightsGeneration)
  }
}

export interface LocalConsumptionSpec {
  readonly localUuid: string
  readonly sequence: number
  readonly quantityMilli: number
  readonly invoiceLocalUuid: string
  readonly itemLocalUuid: string
  readonly lineIndex: number
  readonly requestHash: string
}

/**
 * Writes local committed consumption rows for one grant with correct journal-v1 evidence, exactly as
 * a real checkout would, and returns the boundary a server would publish after accepting all of
 * them. Suites use the returned boundary directly, or perturb it to build the fail-closed cases.
 */
export function writeLocalJournal(
  database: SqliteDatabase,
  allocationUuid: string,
  rightsGeneration: number,
  specs: readonly LocalConsumptionSpec[]
): IncomingCoverageBoundary {
  // Continue from whatever this grant identity's local journal already holds, rather than always
  // restarting from the initial hash — a test that seeds sequence 2 in a later call after an
  // earlier call already committed sequence 1 needs the real chain, not one that treats sequence 2
  // as if it were the first entry ever written.
  const existing = database
    .prepare(
      `SELECT quantity_milli, chain_hash FROM local_stock_allocation_consumptions
        WHERE allocation_uuid = ? AND COALESCE(rights_generation, ?) = ?
        ORDER BY consumption_sequence DESC LIMIT 1`
    )
    .get(allocationUuid, rightsGeneration, rightsGeneration) as
    { readonly quantity_milli: number; readonly chain_hash: string | null } | undefined
  const priorTotal = (
    database
      .prepare(
        `SELECT COALESCE(SUM(quantity_milli), 0) AS total FROM local_stock_allocation_consumptions
          WHERE allocation_uuid = ? AND COALESCE(rights_generation, ?) = ?`
      )
      .get(allocationUuid, rightsGeneration, rightsGeneration) as { total: number }
  ).total

  let chainHash =
    existing?.chain_hash ?? allocationJournalInitialHash(allocationUuid, rightsGeneration)
  let total = priorTotal

  const insert = database.prepare(
    `INSERT INTO local_stock_allocation_consumptions (
       local_uuid, allocation_uuid, consumption_sequence, invoice_local_uuid, item_local_uuid,
       quantity_milli, server_status, created_at, rights_generation, invoice_idempotency_key,
       item_line_uuid, request_hash, entry_hash, chain_hash
     ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`
  )

  for (const spec of specs) {
    const itemLineUuid = allocationItemLineUuid(spec.invoiceLocalUuid, spec.lineIndex)
    const hashes = allocationJournalAppend(chainHash, {
      allocationUuid,
      rightsGeneration,
      consumptionSequence: spec.sequence,
      localConsumptionUuid: spec.localUuid,
      invoiceIdempotencyKey: spec.invoiceLocalUuid,
      itemLineUuid,
      quantityMilli: spec.quantityMilli,
      requestHash: spec.requestHash
    })

    insert.run(
      spec.localUuid,
      allocationUuid,
      spec.sequence,
      spec.invoiceLocalUuid,
      spec.itemLocalUuid,
      spec.quantityMilli,
      NOW,
      rightsGeneration,
      spec.invoiceLocalUuid,
      itemLineUuid,
      spec.requestHash,
      hashes.entryHash,
      hashes.chainHash
    )

    chainHash = hashes.chainHash
    total += spec.quantityMilli
  }

  const priorSequence = (
    database
      .prepare(
        `SELECT COALESCE(MAX(consumption_sequence), 0) AS maxSequence
           FROM local_stock_allocation_consumptions
          WHERE allocation_uuid = ? AND COALESCE(rights_generation, ?) = ?`
      )
      .get(allocationUuid, rightsGeneration, rightsGeneration) as { maxSequence: number }
  ).maxSequence

  return {
    allocationUuid,
    rightsGeneration,
    acceptedConsumptionSequence:
      specs.length === 0 ? priorSequence : specs[specs.length - 1].sequence,
    acceptedConsumedQuantityMilli: total,
    acceptedChainHash: chainHash
  }
}

/** The minimum parent rows a consumption's foreign keys require. */
export function writeInvoiceSkeleton(
  database: SqliteDatabase,
  invoiceLocalUuid: string,
  itemLocalUuid: string,
  options: { readonly lineIndex?: number; readonly payloadJson?: string } = {}
): void {
  // Preserve the FULL invoice uuid's varying suffix rather than truncating it away: several
  // test-generated uuids differ only in their last few characters, and slicing at a fixed
  // offset that lands before that suffix would collide every call.
  const attemptKey = `9a${invoiceLocalUuid.slice(2)}`

  // sale_attempts.invoice_local_uuid and local_invoices.attempt_key reference each other, so the
  // row is claimed first with no invoice link, then updated to committed once the invoice exists —
  // exactly the two-step `SaleAttemptRepository.markCommitted()` production uses.
  insertRow(database, 'sale_attempts', {
    attempt_key: attemptKey,
    company_uuid: COMPANY_UUID,
    device_uuid: DEVICE_UUID,
    user_uuid: COMPANY_UUID,
    claim_session_epoch: 1,
    origin_shift_uuid: COMPANY_UUID,
    origin_shift_observed_at: NOW,
    origin_branch_uuid: COMPANY_UUID,
    origin_warehouse_uuid: WAREHOUSE_UUID,
    origin_context_fingerprint: HASH_64,
    intent_fingerprint: HASH_64,
    intent_version: 1,
    intent_json: '{"v":1}',
    state: 'claimed',
    claimed_at: NOW,
    updated_at: NOW
  })

  insertRow(database, 'local_invoices', {
    local_uuid: invoiceLocalUuid,
    attempt_key: attemptKey,
    offline_number: `POS-000001-20260906-${invoiceLocalUuid.slice(-6)}`,
    sync_status: 'pending',
    sync_attempts: 0,
    company_uuid: COMPANY_UUID,
    branch_uuid: COMPANY_UUID,
    warehouse_uuid: WAREHOUSE_UUID,
    device_uuid: DEVICE_UUID,
    user_uuid: COMPANY_UUID,
    shift_uuid: COMPANY_UUID,
    commit_session_epoch: 1,
    catalog_revision: HASH_64,
    intent_fingerprint: HASH_64,
    currency: 'USD',
    currency_exponent: 2,
    tax_mode: 'none',
    invoice_discount_value: 0,
    subtotal_amount: 1000,
    discount_total_amount: 0,
    tax_total_amount: 0,
    grand_total_amount: 1000,
    paid_total_amount: 1000,
    change_due_amount: 0,
    due_amount: 0,
    sold_at: NOW,
    connectivity_state_at_sale: 'online',
    sold_while_offline: 0,
    commercial_snapshot_json: '{}',
    upload_payload_version: 2,
    created_at: NOW,
    updated_at: NOW
  })

  insertRow(database, 'local_invoice_items', {
    local_uuid: itemLocalUuid,
    invoice_local_uuid: invoiceLocalUuid,
    line_index: options.lineIndex ?? 0,
    product_uuid: PRODUCT_UUID,
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
    created_at: NOW
  })

  database
    .prepare(
      `UPDATE sale_attempts
         SET state = 'committed', invoice_local_uuid = ?, committed_at = ?, last_attempted_at = ?,
             updated_at = ?
       WHERE attempt_key = ?`
    )
    .run(invoiceLocalUuid, NOW, NOW, NOW, attemptKey)

  if (options.payloadJson !== undefined) {
    insertRow(database, 'sync_queue', {
      local_queue_uuid: `${invoiceLocalUuid.slice(0, 30)}7b`,
      aggregate_type: 'invoice',
      local_aggregate_uuid: invoiceLocalUuid,
      operation: 'upload',
      payload_json: options.payloadJson,
      payload_hash: HASH_64,
      idempotency_key: invoiceLocalUuid,
      state: 'pending',
      attempt_count: 0,
      created_at: NOW,
      updated_at: NOW
    })
  }
}

export function insertRow(
  database: SqliteDatabase,
  table: string,
  row: Record<string, unknown>
): void {
  const columns = Object.keys(row)

  database
    .prepare(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
    )
    .run(...columns.map((column) => row[column]))
}

/** Marks the local snapshot as established under the reconciliation representation. */
export function markReconciledCapability(
  database: SqliteDatabase,
  revision: number,
  representation: 'legacy' | 'reconciliation_v2' = 'reconciliation_v2'
): void {
  database
    .prepare(
      `INSERT INTO bootstrap_allocation_capability (id, state, revision, observed_at, representation)
       VALUES (1, 'supported', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         state = excluded.state,
         revision = excluded.revision,
         observed_at = excluded.observed_at,
         representation = excluded.representation`
    )
    .run(revision, NOW, representation)
}
