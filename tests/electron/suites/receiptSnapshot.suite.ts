import { deepEqual, equal, ok, throws } from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { closeDatabase } from '../../../src/main/database/connection'
import { ReceiptContextCaptureService } from '../../../src/main/receipt/receiptContextCapture.service'
import { RECEIPT_TEMPLATE_VERSION } from '../../../src/main/receipt/receiptDocument.service'
import {
  RECEIPT_SNAPSHOT_MAX_ATTEMPTS,
  type ReceiptSnapshotRepository
} from '../../../src/main/repositories/receiptSnapshot.repository'
import { decodeTransactionReferenceQr } from '../../../src/shared/receipt/transactionQr'
import type { SqliteDatabase } from '../../../src/main/database/connection'
import { databaseTest } from '../support/sandbox'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories, type RealRepositories } from '../support/realRepositories'
import {
  bootstrapResource,
  companyUuid,
  setUpAuthorizedContext,
  validIntent
} from '../support/localSaleFixture'

/**
 * Owner receipt copies — the receipt snapshot (migration 0030) against a real temp SQLite database
 * and the real sale-commit path (`LocalSaleService.complete` with the real `ReceiptContextCaptureService`).
 */

const ATTEMPT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const NOW = new Date('2026-01-01T03:00:00.000Z')

const AGREED_CAPABILITIES_DDL = `CREATE TABLE bootstrap_capabilities (
        capability  TEXT PRIMARY KEY CHECK (length(capability) BETWEEN 1 AND 64),
        version     INTEGER NOT NULL CHECK (version >= 1),
        updated_at  TEXT NOT NULL
      ) STRICT`

function captureFor(
  repositories: RealRepositories,
  receiptSnapshots: Pick<ReceiptSnapshotRepository, 'captureForSale'>
): ReceiptContextCaptureService {
  return new ReceiptContextCaptureService({
    receiptContext: repositories.receiptContext,
    bootstrapSnapshot: repositories.bootstrapSnapshot,
    sessionMetadata: repositories.sessionMetadata,
    customers: { findNameAndTaxNumber: () => null },
    receiptSnapshots,
    now: () => new Date('2026-01-01T02:00:00.000Z')
  })
}

function commitSale(
  database: SqliteDatabase,
  repositories: RealRepositories,
  receiptSnapshots: Pick<ReceiptSnapshotRepository, 'captureForSale'>
): string {
  const { localSale } = setUpAuthorizedContext(database, repositories, undefined, 'online', true, {
    receiptContext: captureFor(repositories, receiptSnapshots)
  })
  const outcome = localSale.complete(ATTEMPT, validIntent())
  ok(outcome.outcome === 'committed', `sale not committed: ${JSON.stringify(outcome)}`)
  return outcome.invoice.localUuid
}

function markSynced(database: SqliteDatabase, invoiceLocalUuid: string): void {
  database
    .prepare(
      "UPDATE local_invoices SET sync_status = 'synced', synced_at = '2026-01-01T02:30:00Z' WHERE local_uuid = ?"
    )
    .run(invoiceLocalUuid)
}

databaseTest(
  'migration 0030 creates the agreed capability table and immutable snapshots',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const ddl = (
      database
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'bootstrap_capabilities'"
        )
        .get() as { sql: string }
    ).sql
    equal(ddl.replace(/\s+/g, ' '), AGREED_CAPABILITIES_DDL.replace(/\s+/g, ' '))
    const triggers = (
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%receipt_snapshot%' ORDER BY name"
        )
        .all() as { name: string }[]
    ).map((row) => row.name)
    deepEqual(triggers, [
      'trg_local_invoice_receipt_snapshot_no_delete',
      'trg_local_invoice_receipt_snapshot_no_update',
      'trg_receipt_snapshot_uploads_settled_final'
    ])
    closeDatabase(database)
  }
)

databaseTest(
  'a committed sale freezes its snapshot in the same transaction: the context row, the template and the invoice QR',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const snapshots = repositories.receiptSnapshots
    const invoiceLocalUuid = commitSale(database, repositories, snapshots)

    const stored = snapshots.find(invoiceLocalUuid)
    ok(stored)
    const content = JSON.parse(stored.canonicalContent) as {
      snapshot_version: number
      template_version: number
      context: Record<string, unknown>
      qr: { type: string; payload: string }
    }
    const context = database
      .prepare('SELECT * FROM local_invoice_receipt_context WHERE invoice_local_uuid = ?')
      .get(invoiceLocalUuid) as Record<string, unknown>
    const invoice = database
      .prepare(
        'SELECT sold_at, grand_total_amount, currency, currency_exponent FROM local_invoices WHERE local_uuid = ?'
      )
      .get(invoiceLocalUuid) as {
      sold_at: string
      grand_total_amount: number
      currency: string
      currency_exponent: number
    }

    equal(content.snapshot_version, 1)
    equal(content.template_version, RECEIPT_TEMPLATE_VERSION)
    deepEqual(content.context, context)
    equal(content.qr.type, 'txn-ref-v1')
    equal(
      stored.contentSha256,
      createHash('sha256').update(stored.canonicalContent, 'utf8').digest('hex')
    )
    const fields = decodeTransactionReferenceQr(content.qr.payload)
    ok(fields)
    equal(fields.co, companyUuid)
    equal(fields.id, invoiceLocalUuid)
    equal(fields.doc, 'sale')
    equal(fields.ts, `${new Date(invoice.sold_at).toISOString().slice(0, 19)}Z`)
    equal(fields.cur, invoice.currency)
    equal(
      fields.amt,
      (invoice.grand_total_amount / 10 ** invoice.currency_exponent).toFixed(
        invoice.currency_exponent
      )
    )

    // The invoice upload payload is unchanged: it carries nothing of the snapshot.
    const payloads = database.prepare('SELECT payload_json FROM sync_queue').all() as {
      payload_json: string
    }[]
    ok(payloads.length > 0)
    for (const { payload_json } of payloads) {
      ok(!payload_json.includes('THINIS-TXN') && !payload_json.includes('receipt_snapshot'))
    }

    // Pending, and offered for upload only once the server accepted the sale.
    equal(snapshots.uploadState(invoiceLocalUuid)?.state, 'pending')
    equal(snapshots.findDueUploads(companyUuid, NOW, 50).length, 0)
    markSynced(database, invoiceLocalUuid)
    deepEqual(
      snapshots.findDueUploads(companyUuid, NOW, 50).map((row) => row.invoiceLocalUuid),
      [invoiceLocalUuid]
    )
    throws(
      () => database.prepare("UPDATE local_invoice_receipt_snapshot SET qr_payload = 'x'").run(),
      /immutable/
    )
    throws(() => database.prepare('DELETE FROM local_invoice_receipt_snapshot').run(), /immutable/)
    closeDatabase(database)
  }
)

databaseTest(
  'a snapshot that cannot be frozen never fails the sale, and leaves no half-written rows',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    // The upload table is unavailable: the snapshot insert succeeds, the upload-row insert throws, and
    // the savepoint takes the snapshot row back with it. The sale itself commits.
    database.exec('ALTER TABLE receipt_snapshot_uploads RENAME TO receipt_snapshot_uploads_away')
    const invoiceLocalUuid = commitSale(database, repositories, repositories.receiptSnapshots)

    equal(
      (database.prepare('SELECT COUNT(*) AS n FROM local_invoices').get() as { n: number }).n,
      1
    )
    equal(
      (
        database
          .prepare(
            'SELECT COUNT(*) AS n FROM local_invoice_receipt_context WHERE invoice_local_uuid = ?'
          )
          .get(invoiceLocalUuid) as { n: number }
      ).n,
      1
    )
    equal(
      (
        database.prepare('SELECT COUNT(*) AS n FROM local_invoice_receipt_snapshot').get() as {
          n: number
        }
      ).n,
      0
    )
    database.exec('ALTER TABLE receipt_snapshot_uploads_away RENAME TO receipt_snapshot_uploads')
    closeDatabase(database)
  }
)

databaseTest('the capability follows the latest persisted bootstrap', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  const capabilities = repositories.bootstrapCapabilities

  repositories.bootstrapSnapshot.persistSnapshot(
    { ...bootstrapResource(), receipt_snapshot: { version: 1 } },
    '2026-01-01T00:01:00+00:00'
  )
  equal(capabilities.getCapabilityVersion('receipt_snapshot'), 1)
  repositories.bootstrapSnapshot.persistSnapshot(bootstrapResource(), '2026-01-01T00:02:00+00:00')
  equal(capabilities.getCapabilityVersion('receipt_snapshot'), null)
  closeDatabase(database)
})

databaseTest(
  'upload state survives a restart; counted retries are spaced and bounded; a settled upload is final',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const invoiceLocalUuid = commitSale(database, repositories, repositories.receiptSnapshots)
    markSynced(database, invoiceLocalUuid)
    repositories.receiptSnapshots.recordUnsettledAttempt(
      invoiceLocalUuid,
      'INVOICE_NOT_UPLOADED',
      true,
      '2026-01-01T03:00:00.000Z'
    )
    closeDatabase(database)

    const restarted = openTestDatabase(sandbox)
    const snapshots = realRepositories(restarted).receiptSnapshots
    const due = (at: string): number =>
      snapshots.findDueUploads(companyUuid, new Date(at), 50).length
    equal(snapshots.uploadState(invoiceLocalUuid)?.attempts, 1)
    equal(due('2026-01-01T03:00:59.999Z'), 0)
    equal(due('2026-01-01T03:01:00.000Z'), 1)
    // A try that never reached the server spaces the next one but is not counted.
    snapshots.recordUnsettledAttempt(
      invoiceLocalUuid,
      'no_answer',
      false,
      '2026-01-01T03:01:00.000Z'
    )
    equal(snapshots.uploadState(invoiceLocalUuid)?.attempts, 1)
    for (let attempt = 2; attempt <= RECEIPT_SNAPSHOT_MAX_ATTEMPTS; attempt += 1) {
      snapshots.recordUnsettledAttempt(
        invoiceLocalUuid,
        'SERVER_ERROR',
        true,
        '2026-01-02T00:00:00.000Z'
      )
    }
    deepEqual(snapshots.uploadState(invoiceLocalUuid), {
      state: 'rejected',
      attempts: RECEIPT_SNAPSHOT_MAX_ATTEMPTS,
      lastErrorCode: 'retries_exhausted'
    })
    equal(due('2027-01-01T00:00:00.000Z'), 0)
    throws(
      () =>
        restarted
          .prepare("UPDATE receipt_snapshot_uploads SET state = 'pending', settled_at = NULL")
          .run(),
      /final/
    )
    closeDatabase(restarted)
  }
)
