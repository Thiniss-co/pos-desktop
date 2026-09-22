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
 * Plan §3b (r5) -- cancellation and dispatch race through the SAME conditional UPDATE
 * (`WHERE submission_state = 'prepared' AND dispatch_count = 0`), never through application-level
 * locking alone. Exactly one of `claimForDispatch`/`cancelIfPrepared` may ever succeed on a given
 * `prepared` row, and no row may ever end up both cancelled and dispatched.
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

function insertInvoice(database: SqliteDatabase): void {
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
      UUID_A,
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

function newRefund(): NewLocalRefund {
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
    requestJson: JSON.stringify({ idempotency_key: UUID_C }),
    requestSha256: HASH_64,
    previewId: UUID_A,
    createdAt: NOW
  }
}

function newItem(): NewLocalRefundItem {
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
    createdAt: NOW
  }
}

function newPayment(): NewLocalRefundPayment {
  return {
    localUuid: UUID_A,
    refundLocalUuid: UUID_C,
    paymentIndex: 0,
    paymentMethodUuid: null,
    type: 'cash',
    amount: 1000,
    reference: null,
    createdAt: NOW
  }
}

databaseTest('claimForDispatch wins when it runs first: cancel then fails', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  insertAttempt(database)
  insertInvoice(database)
  repositories.localRefunds.insert(newRefund(), [newItem()], [newPayment()])

  const claimed = repositories.localRefunds.claimForDispatch(UUID_C, NOW)
  const cancelled = repositories.localRefunds.cancelIfPrepared(UUID_C, 'race loser', NOW)

  equal(claimed, true)
  equal(cancelled, false)

  const row = repositories.localRefunds.findByLocalUuid(UUID_C)
  equal(row?.submissionState, 'dispatched')
  equal(row?.dispatchCount, 1)
  closeDatabase(database)
})

databaseTest('cancelIfPrepared wins when it runs first: dispatch then fails', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  insertAttempt(database)
  insertInvoice(database)
  repositories.localRefunds.insert(newRefund(), [newItem()], [newPayment()])

  const cancelled = repositories.localRefunds.cancelIfPrepared(UUID_C, 'operator', NOW)
  const claimed = repositories.localRefunds.claimForDispatch(UUID_C, NOW)

  equal(cancelled, true)
  equal(claimed, false)

  const row = repositories.localRefunds.findByLocalUuid(UUID_C)
  equal(row?.submissionState, 'cancelled')
  equal(row?.dispatchCount, 0)
  ok(row?.cancelledAt !== null)
  closeDatabase(database)
})

databaseTest(
  'repeated cancel/dispatch attempts on an already-settled row never flip its state',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    insertAttempt(database)
    insertInvoice(database)
    repositories.localRefunds.insert(newRefund(), [newItem()], [newPayment()])

    ok(repositories.localRefunds.claimForDispatch(UUID_C, NOW))

    // Neither can succeed again -- the row is 'dispatched', not 'prepared'/'unresolved'.
    equal(repositories.localRefunds.cancelIfPrepared(UUID_C, 'late', NOW), false)
    equal(repositories.localRefunds.claimForDispatch(UUID_C, NOW), false)

    const row = repositories.localRefunds.findByLocalUuid(UUID_C)
    equal(row?.submissionState, 'dispatched')
    equal(row?.dispatchCount, 1)
    // Never both cancelled and dispatched.
    ok(row?.cancelledAt === null)
    closeDatabase(database)
  }
)

ok(true, 'refundCancelRace.suite loaded')
