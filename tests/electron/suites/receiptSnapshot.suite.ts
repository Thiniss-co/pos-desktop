import { deepEqual, equal, ok, throws } from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { closeDatabase } from '../../../src/main/database/connection'
import { databaseMigrations } from '../../../src/main/database/migrations'
import { FiscalContextService } from '../../../src/main/receipt/fiscalContext.service'
import { ReceiptContextCaptureService } from '../../../src/main/receipt/receiptContextCapture.service'
import { ReceiptSnapshotCaptureService } from '../../../src/main/receipt/receiptSnapshotCapture.service'
import { RECEIPT_TEMPLATE_VERSION } from '../../../src/main/receipt/receiptDocument.service'
import {
  RECEIPT_SNAPSHOT_MAX_ATTEMPTS,
  type ReceiptSnapshotRepository
} from '../../../src/main/repositories/receiptSnapshot.repository'
import { decodeTransactionReferenceQr } from '../../../src/shared/receipt/transactionQr'
import { decodeZatcaPhase1Qr } from '../../../src/shared/receipt/fiscalQr'
import type { SqliteDatabase } from '../../../src/main/database/connection'
import { databaseTest } from '../support/sandbox'
import {
  openExistingTestDatabase,
  openTestDatabase,
  runTestMigrations
} from '../support/openTestDatabase'
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

const ZATCA_IDENTITY = {
  regime: 'sa_zatca_phase1' as const,
  seller_name: 'Harbour Coffee Trading LLC',
  vat_number: '310122393500003',
  seller_address: {
    street: '1 Corniche Road',
    city: 'Jeddah',
    postal_code: '23511',
    country: 'Saudi Arabia'
  },
  revision: 3
}

type FiscalSetup = 'none' | 'zatca' | null

/**
 * Commits one sale through the real `LocalSaleService` with the real receipt-context, fiscal-context
 * (when `fiscal` is set; 'zatca' mirrors a ZATCA identity) and receipt-snapshot capture services.
 */
function commitSale(
  database: SqliteDatabase,
  repositories: RealRepositories,
  receiptSnapshots: Pick<
    ReceiptSnapshotRepository,
    'captureForSale'
  > = repositories.receiptSnapshots,
  fiscal: FiscalSetup = null,
  attempt = ATTEMPT
): string {
  const { localSale } = setUpAuthorizedContext(database, repositories, undefined, 'online', true, {
    receiptContext: new ReceiptContextCaptureService({
      receiptContext: repositories.receiptContext,
      bootstrapSnapshot: repositories.bootstrapSnapshot,
      sessionMetadata: repositories.sessionMetadata,
      customers: { findNameAndTaxNumber: () => null },
      now: () => new Date('2026-01-01T02:00:00.000Z')
    }),
    receiptSnapshot: new ReceiptSnapshotCaptureService({ repository: receiptSnapshots }),
    ...(fiscal === null
      ? {}
      : { fiscalContext: new FiscalContextService(repositories.fiscalContexts) })
  })
  if (fiscal === 'zatca') {
    repositories.fiscalContexts.replaceIdentity(companyUuid, ZATCA_IDENTITY, '2026-01-01T00:02:00Z')
  }
  const outcome = localSale.complete(attempt, validIntent())
  ok(outcome.outcome === 'committed', `sale not committed: ${JSON.stringify(outcome)}`)
  return outcome.invoice.localUuid
}

function count(database: SqliteDatabase, sql: string, ...params: unknown[]): number {
  return (database.prepare(sql).get(...params) as { n: number }).n
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
    equal(snapshots.findDueUploads(companyUuid, NOW, 50, 2).length, 0)
    markSynced(database, invoiceLocalUuid)
    deepEqual(
      snapshots.findDueUploads(companyUuid, NOW, 50, 2).map((row) => row.invoiceLocalUuid),
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

databaseTest(
  'one writer: every capability of the latest bootstrap is kept together, and renegotiated with the next',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const capabilities = repositories.bootstrapSnapshot

    repositories.bootstrapSnapshot.persistSnapshot(
      {
        ...bootstrapResource(),
        quick_create: { version: 1 },
        receipt_snapshot: { version: 2 }
      } as never,
      '2026-01-01T00:01:00+00:00'
    )
    equal(capabilities.getCapabilityVersion('receipt_snapshot'), 2)
    equal(capabilities.getCapabilityVersion('quick_create'), 1)
    // A server that no longer offers one: only that one is gone.
    repositories.bootstrapSnapshot.persistSnapshot(
      { ...bootstrapResource(), quick_create: { version: 1 } } as never,
      '2026-01-01T00:02:00+00:00'
    )
    equal(capabilities.getCapabilityVersion('receipt_snapshot'), null)
    equal(capabilities.getCapabilityVersion('quick_create'), 1)
    closeDatabase(database)
  }
)

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
      snapshots.findDueUploads(companyUuid, new Date(at), 50, 2).length
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

databaseTest(
  'a sale with a frozen fiscal context freezes snapshot v2 with that exact QR and fiscal identity (ZATCA)',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const invoiceLocalUuid = commitSale(database, repositories, undefined, 'zatca')
    const fiscal = database
      .prepare('SELECT * FROM local_invoice_fiscal_context WHERE invoice_local_uuid = ?')
      .get(invoiceLocalUuid) as Record<string, unknown>
    const stored = repositories.receiptSnapshots.find(invoiceLocalUuid)
    ok(stored)
    const content = JSON.parse(stored.canonicalContent) as {
      snapshot_version: number
      fiscal: Record<string, unknown>
      qr: { type: string; payload: string }
    }

    equal(content.snapshot_version, 2)
    deepEqual(content.qr, { type: 'zatca-p1', payload: fiscal.qr_payload })
    equal(stored.qrPayload, fiscal.qr_payload)
    deepEqual(content.fiscal, {
      regime: 'sa_zatca_phase1',
      seller_name: ZATCA_IDENTITY.seller_name,
      vat_number: ZATCA_IDENTITY.vat_number,
      seller_address: ZATCA_IDENTITY.seller_address,
      fiscal_revision: ZATCA_IDENTITY.revision
    })
    const decoded = decodeZatcaPhase1Qr(String(fiscal.qr_payload))
    ok(decoded)
    equal(decoded.sellerName, ZATCA_IDENTITY.seller_name)
    equal(decodeTransactionReferenceQr(String(fiscal.qr_payload)), null)

    // A server that stores only v1 is never sent a v2 snapshot; it waits.
    markSynced(database, invoiceLocalUuid)
    equal(repositories.receiptSnapshots.findDueUploads(companyUuid, NOW, 50, 1).length, 0)
    deepEqual(
      repositories.receiptSnapshots
        .findDueUploads(companyUuid, NOW, 50, 2)
        .map((row) => [row.invoiceLocalUuid, row.snapshotVersion]),
      [[invoiceLocalUuid, 2]]
    )
    closeDatabase(database)
  }
)

databaseTest(
  'a non-fiscal register with a fiscal context freezes v2 carrying the reference QR it printed, never relabelled',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const invoiceLocalUuid = commitSale(database, repositories, undefined, 'none')
    const fiscal = database
      .prepare(
        'SELECT regime, qr_type, qr_payload FROM local_invoice_fiscal_context WHERE invoice_local_uuid = ?'
      )
      .get(invoiceLocalUuid) as { regime: string; qr_type: string; qr_payload: string }
    const content = JSON.parse(
      repositories.receiptSnapshots.find(invoiceLocalUuid)?.canonicalContent ?? '{}'
    ) as {
      snapshot_version: number
      fiscal: { regime: string }
      qr: { type: string; payload: string }
    }

    equal(fiscal.qr_type, 'txn-ref-v1')
    equal(content.snapshot_version, 2)
    equal(content.fiscal.regime, 'none')
    deepEqual(content.qr, { type: 'txn-ref-v1', payload: fiscal.qr_payload })
    ok(decodeTransactionReferenceQr(content.qr.payload))
    // The table refuses a reference QR labelled as anything but itself in v1.
    throws(() =>
      database
        .prepare(
          `INSERT INTO local_invoice_receipt_snapshot VALUES ('99999999-9999-4999-8999-999999999999', ?, 1, 'zatca-p1', 'x', '{}', ?, 'x')`
        )
        .run(companyUuid, 'a'.repeat(64))
    )
    closeDatabase(database)
  }
)

databaseTest(
  'upgrade from the receipt-snapshot branch (0001–0019, 0030): a stored v1 snapshot and its queued sale keep their exact bytes',
  (sandbox) => {
    const before = openExistingTestDatabase(sandbox)
    runTestMigrations(
      before,
      databaseMigrations.filter((migration) => migration.version <= 19 || migration.version === 30)
    )
    // A sale committed on that schema, with its v1 snapshot pending after one counted try.
    const repositories = realRepositories(before)
    const legacyUuid = commitSale(before, repositories)
    const legacy = repositories.receiptSnapshots.find(legacyUuid)
    ok(legacy)
    repositories.receiptSnapshots.recordUnsettledAttempt(
      legacyUuid,
      'INVOICE_NOT_UPLOADED',
      true,
      '2026-01-01T02:10:00.000Z'
    )
    const queued = before.prepare('SELECT payload_json FROM sync_queue ORDER BY rowid').all()
    closeDatabase(before)

    const after = openTestDatabase(sandbox)
    const versions = (
      after.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
        version: number
      }[]
    ).map((row) => row.version)
    deepEqual(
      versions,
      databaseMigrations.map((migration) => migration.version).sort((a, b) => a - b)
    )
    const kept = after
      .prepare(
        'SELECT snapshot_version, qr_type, qr_payload, canonical_content, content_sha256 FROM local_invoice_receipt_snapshot WHERE invoice_local_uuid = ?'
      )
      .get(legacyUuid) as Record<string, unknown>
    deepEqual(kept, {
      snapshot_version: 1,
      qr_type: 'txn-ref-v1',
      qr_payload: legacy.qrPayload,
      canonical_content: legacy.canonicalContent,
      content_sha256: legacy.contentSha256
    })
    deepEqual(realRepositories(after).receiptSnapshots.uploadState(legacyUuid), {
      state: 'pending',
      attempts: 1,
      lastErrorCode: 'INVOICE_NOT_UPLOADED'
    })
    throws(() => after.prepare('DELETE FROM local_invoice_receipt_snapshot').run(), /immutable/)
    deepEqual(after.prepare('SELECT payload_json FROM sync_queue ORDER BY rowid').all(), queued)
    equal(count(after, 'SELECT COUNT(*) AS n FROM pragma_foreign_key_check'), 0)
    closeDatabase(after)
  }
)

databaseTest(
  'upgrade from the POS-improvements branch (0001–0025): an earlier sale gets no snapshot; the next one does',
  (sandbox) => {
    const before = openExistingTestDatabase(sandbox)
    runTestMigrations(
      before,
      databaseMigrations.filter((migration) => migration.version <= 25)
    )
    const repositories = realRepositories(before)
    const earlier = commitSale(before, repositories, repositories.receiptSnapshots, 'zatca')
    equal(count(before, 'SELECT COUNT(*) AS n FROM local_invoice_fiscal_context'), 1)
    closeDatabase(before)

    const after = openTestDatabase(sandbox)
    const afterRepositories = realRepositories(after)
    equal(afterRepositories.receiptSnapshots.find(earlier), null)
    const next = commitSale(
      after,
      afterRepositories,
      afterRepositories.receiptSnapshots,
      'zatca',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    )
    equal(
      JSON.parse(afterRepositories.receiptSnapshots.find(next)?.canonicalContent ?? '{}')
        .snapshot_version,
      2
    )
    equal(count(after, 'SELECT COUNT(*) AS n FROM local_invoices'), 2)
    closeDatabase(after)
  }
)
