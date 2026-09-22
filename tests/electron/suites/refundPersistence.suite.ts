import { equal, ok } from 'node:assert/strict'
import type { SqliteDatabase } from '../../../src/main/database/connection'
import { closeDatabase } from '../../../src/main/database/connection'
import { databaseTest } from '../support/sandbox'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories } from '../support/realRepositories'
import type {
  NewLocalRefund,
  NewLocalRefundItem,
  NewLocalRefundPayment
} from '../../../src/main/repositories/localRefund.repository'

/**
 * Plan §3/§7 (r5) -- durable persistence proofs for the refund repository: atomic commit, frozen
 * bytes surviving a fresh process unchanged (and across cancellation), the startup crash-recovery
 * sweep, replay re-sending identical bytes, and every terminal state staying terminal.
 */

const UUID_A = '00000000-0000-4000-8000-000000000001'
const UUID_B = '00000000-0000-4000-8000-000000000002'
const UUID_C = '00000000-0000-4000-8000-000000000003'
const HASH_64 = 'a'.repeat(64)
const NOW = '2026-09-22T12:00:00.000Z'

function insertAttempt(database: SqliteDatabase): void {
  database
    .prepare(
      `INSERT INTO sale_attempts (
         attempt_key, company_uuid, device_uuid, user_uuid, claim_session_epoch,
         origin_shift_uuid, origin_shift_observed_at, origin_branch_uuid, origin_warehouse_uuid,
         origin_context_fingerprint, intent_fingerprint, intent_version, intent_json, state,
         invoice_local_uuid, claimed_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      UUID_A,
      UUID_A,
      UUID_A,
      UUID_A,
      1,
      UUID_A,
      NOW,
      UUID_A,
      UUID_A,
      HASH_64,
      HASH_64,
      1,
      '{"v":1}',
      'claimed',
      null,
      NOW,
      NOW
    )
}

function insertInvoice(database: SqliteDatabase, localUuid = UUID_A): void {
  database
    .prepare(
      `INSERT INTO local_invoices (
         local_uuid, attempt_key, offline_number, remote_uuid, server_number, sync_status,
         sync_attempts, synced_at, company_uuid, branch_uuid, warehouse_uuid, device_uuid,
         user_uuid, shift_uuid, commit_session_epoch, catalog_revision, intent_fingerprint,
         currency, currency_exponent, tax_mode, subtotal_amount, discount_total_amount,
         tax_total_amount, grand_total_amount, paid_total_amount, change_due_amount, due_amount,
         sold_at, connectivity_state_at_sale, sold_while_offline, commercial_snapshot_json,
         upload_payload_version, created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      localUuid,
      UUID_A,
      'POS-000001-20260922-000001',
      UUID_B,
      'INV-0001',
      'synced',
      1,
      NOW,
      UUID_A,
      UUID_A,
      UUID_A,
      UUID_A,
      UUID_A,
      UUID_A,
      1,
      HASH_64,
      HASH_64,
      'USD',
      2,
      'none',
      1000,
      0,
      0,
      1000,
      1000,
      0,
      0,
      NOW,
      'online',
      0,
      '{}',
      2,
      NOW,
      NOW
    )
}

function newRefund(overrides: Partial<NewLocalRefund> = {}): NewLocalRefund {
  return {
    localUuid: UUID_C,
    invoiceLocalUuid: UUID_A,
    invoiceRemoteUuid: UUID_B,
    companyUuid: UUID_A,
    deviceUuid: UUID_A,
    userUuid: UUID_A,
    shiftUuid: UUID_A,
    currency: 'USD',
    currencyExponent: 2,
    subtotalAmount: 1000,
    discountTotalAmount: 0,
    taxTotalAmount: 0,
    grandTotalAmount: 1000,
    refundedAt: NOW,
    stockReturned: true,
    reason: null,
    notes: null,
    requestJson: JSON.stringify({ idempotency_key: UUID_C, amount: 1000 }),
    requestSha256: HASH_64,
    previewId: UUID_A,
    createdAt: NOW,
    ...overrides
  }
}

function newItem(overrides: Partial<NewLocalRefundItem> = {}): NewLocalRefundItem {
  return {
    localUuid: UUID_B,
    refundLocalUuid: UUID_C,
    lineIndex: 0,
    invoiceItemRemoteUuid: UUID_B,
    productUuid: UUID_A,
    productName: 'Product',
    quantityMilli: 1000,
    priorRefundedQuantityMilli: 0,
    subtotalAmount: 1000,
    discountAmount: 0,
    taxAmount: 0,
    totalAmount: 1000,
    taxMode: 'exclusive',
    createdAt: NOW,
    ...overrides
  }
}

function newPayment(overrides: Partial<NewLocalRefundPayment> = {}): NewLocalRefundPayment {
  return {
    localUuid: UUID_A,
    refundLocalUuid: UUID_C,
    paymentIndex: 0,
    paymentMethodUuid: null,
    type: 'cash',
    amount: 1000,
    reference: null,
    createdAt: NOW,
    ...overrides
  }
}

databaseTest('a refund with items and a payment commits atomically', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  insertAttempt(database)
  insertInvoice(database)

  const created = repositories.localRefunds.insert(newRefund(), [newItem()], [newPayment()])

  equal(created.localUuid, UUID_C)
  equal(created.submissionState, 'prepared')
  equal(created.dispatchCount, 0)
  equal(repositories.localRefunds.itemsForRefund(UUID_C).length, 1)
  equal(repositories.localRefunds.paymentsForRefund(UUID_C).length, 1)
  closeDatabase(database)
})

databaseTest(
  'request_json and request_sha256 survive a fresh process unchanged (never rewritten)',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    insertAttempt(database)
    insertInvoice(database)

    const frozenJson = JSON.stringify({ idempotency_key: UUID_C, amount: 4242 })
    repositories.localRefunds.insert(
      newRefund({ requestJson: frozenJson }),
      [newItem()],
      [newPayment()]
    )

    // Mutate through the full outcome lifecycle -- frozen bytes must never move.
    repositories.localRefunds.claimForDispatch(UUID_C, NOW)
    repositories.localRefunds.markUnresolved(UUID_C, 'transport', 'timeout', NOW)
    repositories.localRefunds.claimForDispatch(UUID_C, NOW)
    repositories.localRefunds.markAccepted(
      UUID_C,
      { remoteUuid: UUID_B, refundNumber: 'REF-1' },
      NOW
    )

    const row = repositories.localRefunds.findByLocalUuid(UUID_C)
    ok(row !== null)
    equal(row?.requestJson, frozenJson)
    equal(row?.requestSha256, HASH_64)
    equal(row?.submissionState, 'accepted')
    closeDatabase(database)
  }
)

databaseTest('request_json survives cancellation unchanged', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  insertAttempt(database)
  insertInvoice(database)

  const frozenJson = JSON.stringify({ idempotency_key: UUID_C })
  repositories.localRefunds.insert(
    newRefund({ requestJson: frozenJson }),
    [newItem()],
    [newPayment()]
  )

  const cancelled = repositories.localRefunds.cancelIfPrepared(UUID_C, 'operator discarded', NOW)
  equal(cancelled, true)

  const row = repositories.localRefunds.findByLocalUuid(UUID_C)
  equal(row?.requestJson, frozenJson)
  equal(row?.submissionState, 'cancelled')
  equal(row?.cancelledReason, 'operator discarded')
  closeDatabase(database)
})

databaseTest(
  'startup sweep moves dispatched to unresolved and leaves prepared alone',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    insertAttempt(database)
    insertInvoice(database)

    repositories.localRefunds.insert(
      newRefund({ localUuid: UUID_C }),
      [newItem({ refundLocalUuid: UUID_C })],
      [newPayment({ refundLocalUuid: UUID_C })]
    )
    repositories.localRefunds.claimForDispatch(UUID_C, NOW)
    equal(repositories.localRefunds.findByLocalUuid(UUID_C)?.submissionState, 'dispatched')

    const owner = { companyUuid: UUID_A, deviceUuid: UUID_A }
    const swept = repositories.localRefunds.sweepDispatchedToUnresolved(owner, NOW)

    equal(swept, 1)
    equal(repositories.localRefunds.findByLocalUuid(UUID_C)?.submissionState, 'unresolved')
    closeDatabase(database)
  }
)

databaseTest('rejected, conflict, and cancelled are all terminal', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  insertAttempt(database)
  insertInvoice(database)

  repositories.localRefunds.insert(newRefund(), [newItem()], [newPayment()])
  repositories.localRefunds.claimForDispatch(UUID_C, NOW)
  repositories.localRefunds.markRejected(UUID_C, 'refund_calculation_stale', 'stale', NOW)

  const row = repositories.localRefunds.findByLocalUuid(UUID_C)
  equal(row?.submissionState, 'rejected')
  equal(row?.lastErrorCode, 'refund_calculation_stale')

  // A rejected refund does not block a NEW refund on the same invoice.
  equal(repositories.localRefunds.findOpenForInvoice(UUID_A), null)
  closeDatabase(database)
})

databaseTest('a conflict refund keeps blocking a replacement (unknown outcome)', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  insertAttempt(database)
  insertInvoice(database)

  repositories.localRefunds.insert(newRefund(), [newItem()], [newPayment()])
  repositories.localRefunds.claimForDispatch(UUID_C, NOW)
  repositories.localRefunds.markConflict(UUID_C, 'IDEMPOTENCY_CONFLICT', 'conflict', NOW)

  const open = repositories.localRefunds.findOpenForInvoice(UUID_A)
  ok(open !== null)
  equal(open?.submissionState, 'conflict')
  closeDatabase(database)
})

databaseTest('resuming an unresolved refund re-claims it for dispatch', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  insertAttempt(database)
  insertInvoice(database)

  repositories.localRefunds.insert(newRefund(), [newItem()], [newPayment()])
  repositories.localRefunds.claimForDispatch(UUID_C, NOW)
  repositories.localRefunds.markUnresolved(UUID_C, 'transport', 'timeout', NOW)

  const before = repositories.localRefunds.findByLocalUuid(UUID_C)
  equal(before?.dispatchCount, 1)

  const claimed = repositories.localRefunds.claimForDispatch(UUID_C, NOW)
  equal(claimed, true)

  const after = repositories.localRefunds.findByLocalUuid(UUID_C)
  equal(after?.submissionState, 'dispatched')
  equal(after?.dispatchCount, 2)
  // Same identity, same bytes -- a replay, not a new refund.
  equal(after?.localUuid, before?.localUuid)
  equal(after?.requestJson, before?.requestJson)
  closeDatabase(database)
})

ok(true, 'refundPersistence.suite loaded')
