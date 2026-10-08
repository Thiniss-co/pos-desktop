import { createHash } from 'node:crypto'
import { deepEqual, equal, notEqual, ok, throws } from 'node:assert/strict'
import { closeDatabase, type SqliteDatabase } from '../../../src/main/database/connection'
import { databaseMigrations } from '../../../src/main/database/migrations'
import { QuickCreateService } from '../../../src/main/services/quickCreate.service'
import type { QuickCreateAccess } from '../../../src/shared/contracts/quickCreate.contract'
import { readCommitted } from '../support/committedState'
import { databaseTest, type DatabaseSandbox } from '../support/sandbox'
import { openExistingTestDatabase, runTestMigrations } from '../support/openTestDatabase'
import { realRepositories, type RealRepositories } from '../support/realRepositories'
import { insertRow } from '../support/allocationScenario'
import {
  companyUuid,
  deviceUuid,
  setUpAuthorizedContext,
  userUuid,
  validIntent
} from '../support/localSaleFixture'

/**
 * V1 production readiness — upgrading a register that already holds unsynced work.
 *
 * A device in the field is at schema 0033 with work it has not yet delivered: a queued sale upload,
 * refunds in every resumable state, a pending quick-create request and recorded disposition proofs.
 * These cases apply the real migration list (the real runner, the real migration objects) to that
 * real on-disk database and prove what the upgrade does to the data — no table is mocked and every
 * row is seeded through the production repository/service where one exists.
 *
 * Migration 0034 is the only one after 0033: it rebuilds `invoice_disposition_proof_results`
 * (create `_v34`, `INSERT ... SELECT *`, drop, rename) to relax the accepted-proof CHECK. It is NOT
 * flagged `rebuildsForeignKeyReferencedTable`, so it runs with `foreign_keys = ON` inside the
 * runner's per-migration transaction.
 */

const PRE_0034 = databaseMigrations.filter((migration) => migration.version < 34)
const LATEST_VERSION = Math.max(...databaseMigrations.map((migration) => migration.version))
const ALL_VERSIONS = databaseMigrations.map((migration) => migration.version).sort((a, b) => a - b)
const PRE_0034_VERSIONS = PRE_0034.map((migration) => migration.version).sort((a, b) => a - b)

const SALE_ATTEMPT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DISPOSITION_INVOICE = id('1d1')
const DISPOSITION_UUID = id('d2')
const ALLOCATION_UUID = id('d3')
const ACCEPTED_SERVER_CONSUMPTION = id('d4')
const REFUND_NOW = '2026-01-03T09:00:00.000Z'
const NOW = '2026-01-02T10:00:00.000Z'
const HASH_64 = 'a'.repeat(64)

const ALLOW: QuickCreateAccess = { available: true, customer: true, supplier: true, product: true }

function id(suffix: string): string {
  return `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------------------------
// Committed-state snapshots (read through a separate read-only connection)
// ---------------------------------------------------------------------------------------------

interface TableSnapshot {
  readonly rows: readonly string[]
  readonly sha256: string
}

function normalized(row: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        Buffer.isBuffer(value) ? { blob: value.toString('base64') } : value
      ])
    )
  )
}

/**
 * Every row of every user table, as exact JSON (BLOBs base64), sorted so that a rebuild that only
 * reassigns rowids still compares equal while any changed byte, lost row or added row does not.
 */
function snapshotAllTables(
  sandbox: DatabaseSandbox,
  exclude: readonly string[] = []
): Record<string, TableSnapshot> {
  const tables = readCommitted<{ name: string }>(
    sandbox,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  )
    .map((row) => row.name)
    .filter((name) => !exclude.includes(name))

  return Object.fromEntries(
    tables.map((table) => {
      ok(/^[a-z0-9_]+$/.test(table), `unexpected table name ${table}`)
      const rows = readCommitted<Record<string, unknown>>(sandbox, `SELECT * FROM ${table}`)
        .map(normalized)
        .sort()
      return [table, { rows, sha256: sha256(JSON.stringify(rows)) }]
    })
  )
}

function committedVersions(sandbox: DatabaseSandbox): number[] {
  return readCommitted<{ version: number }>(
    sandbox,
    'SELECT version FROM schema_migrations ORDER BY version'
  ).map((row) => row.version)
}

function tableSql(sandbox: DatabaseSandbox, name: string): string | null {
  const rows = readCommitted<{ sql: string }>(
    sandbox,
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    [name]
  )
  return rows[0]?.sql ?? null
}

// ---------------------------------------------------------------------------------------------
// Seeding — the unsynced work a register at 0033 realistically holds
// ---------------------------------------------------------------------------------------------

/** A committed sale row (attempt + invoice) through the real repositories, as Phase 3F writes it. */
function seedInvoice(repositories: RealRepositories, n: string): string {
  const invoiceUuid = id(`1${n}`)
  const attemptKey = id(`3${n}`)
  repositories.saleAttempts.claim({
    attemptKey,
    companyUuid,
    deviceUuid,
    userUuid,
    claimSessionEpoch: 1,
    originShiftUuid: id('9'),
    originShiftObservedAt: NOW,
    originBranchUuid: id('8'),
    originWarehouseUuid: id('7'),
    originContextFingerprint: HASH_64,
    intentFingerprint: HASH_64,
    intentVersion: 1,
    intentJson: '{"v":1}'
  })
  repositories.localSale.insertInvoice({
    localUuid: invoiceUuid,
    attemptKey,
    offlineNumber: `POS-000001-20260102-00000${n}`,
    companyUuid,
    branchUuid: id('8'),
    warehouseUuid: id('7'),
    deviceUuid,
    userUuid,
    shiftUuid: id('9'),
    commitSessionEpoch: 1,
    catalogRevision: HASH_64,
    intentFingerprint: HASH_64,
    customerUuid: null,
    currency: 'USD',
    currencyExponent: 2,
    taxMode: 'none',
    invoiceDiscountType: null,
    invoiceDiscountValue: 0,
    subtotalAmount: 1000,
    discountTotalAmount: 0,
    taxTotalAmount: 0,
    grandTotalAmount: 1000,
    paidTotalAmount: 1000,
    changeDueAmount: 0,
    soldAt: NOW,
    connectivityStateAtSale: 'offline',
    soldWhileOffline: true,
    notes: null,
    commercialSnapshotJson: '{}',
    createdAt: NOW
  })
  repositories.saleAttempts.markCommitted(attemptKey, invoiceUuid, NOW)
  return invoiceUuid
}

function markInvoiceSynced(database: SqliteDatabase, invoiceUuid: string, n: string): string {
  const remoteUuid = id(`5${n}`)
  database
    .prepare(
      `UPDATE local_invoices
          SET sync_status = 'synced', remote_uuid = ?, server_number = ?, synced_at = ?
        WHERE local_uuid = ?`
    )
    .run(remoteUuid, `INV-000${n}`, NOW, invoiceUuid)
  return remoteUuid
}

/** One refund per invoice (the one-open-refund index), frozen bytes hashed exactly as sent. */
function seedRefund(
  database: SqliteDatabase,
  repositories: RealRepositories,
  n: string,
  state: 'prepared' | 'dispatched' | 'unresolved'
): string {
  const invoiceUuid = seedInvoice(repositories, n)
  const remoteInvoiceUuid = markInvoiceSynced(database, invoiceUuid, n)
  const refundUuid = id(`6${n}`)
  const requestJson = JSON.stringify({
    idempotency_key: refundUuid,
    invoice_uuid: remoteInvoiceUuid,
    refunded_at: REFUND_NOW,
    stock_returned: true,
    items: [{ invoice_item_uuid: id(`7${n}`), quantity: '1.000' }],
    payments: [{ type: 'cash', amount: 1000 }],
    reason: `state ${state}`
  })
  repositories.localRefunds.insert(
    {
      localUuid: refundUuid,
      invoiceLocalUuid: invoiceUuid,
      invoiceRemoteUuid: remoteInvoiceUuid,
      companyUuid,
      deviceUuid,
      userUuid,
      shiftUuid: id('9'),
      currency: 'USD',
      currencyExponent: 2,
      subtotalAmount: 1000,
      discountTotalAmount: 0,
      taxTotalAmount: 0,
      grandTotalAmount: 1000,
      refundedAt: REFUND_NOW,
      stockReturned: true,
      reason: `state ${state}`,
      notes: null,
      requestJson,
      requestSha256: sha256(requestJson),
      previewId: id(`8${n}`),
      createdAt: REFUND_NOW
    },
    [
      {
        localUuid: id(`9${n}`),
        refundLocalUuid: refundUuid,
        lineIndex: 0,
        invoiceItemRemoteUuid: id(`7${n}`),
        productUuid: id('b1'),
        productName: 'Product',
        quantityMilli: 1000,
        priorRefundedQuantityMilli: 0,
        subtotalAmount: 1000,
        discountAmount: 0,
        taxAmount: 0,
        totalAmount: 1000,
        taxMode: 'exclusive',
        createdAt: REFUND_NOW
      }
    ],
    [
      {
        localUuid: id(`a${n}`),
        refundLocalUuid: refundUuid,
        paymentIndex: 0,
        paymentMethodUuid: null,
        type: 'cash',
        amount: 1000,
        reference: null,
        createdAt: REFUND_NOW
      }
    ]
  )
  if (state !== 'prepared') {
    ok(repositories.localRefunds.claimForDispatch(refundUuid, REFUND_NOW))
  }
  if (state === 'unresolved') {
    repositories.localRefunds.markUnresolved(refundUuid, 'transport', 'timeout', REFUND_NOW)
  }
  equal(repositories.localRefunds.findByLocalUuid(refundUuid)?.submissionState, state)
  return refundUuid
}

function insertProof(
  database: SqliteDatabase,
  proof: {
    readonly invoice?: string
    readonly lineIndex: number
    readonly proofIndex: number
    readonly outcome: 'accepted' | 'overridden'
    readonly server: string | null
    readonly reason: string | null
    readonly sequence?: number
  }
): void {
  insertRow(database, 'invoice_disposition_proof_results', {
    invoice_local_uuid: proof.invoice ?? DISPOSITION_INVOICE,
    line_index: proof.lineIndex,
    proof_index: proof.proofIndex,
    allocation_uuid: ALLOCATION_UUID,
    rights_generation: 1,
    consumption_sequence: proof.sequence ?? 4 + proof.proofIndex,
    local_consumption_uuid: id(`e${proof.lineIndex}${proof.proofIndex}`),
    quantity_milli: 5000,
    outcome: proof.outcome,
    server_consumption_uuid: proof.server,
    override_reason: proof.reason,
    created_at: NOW
  })
}

interface SeededWork {
  readonly saleInvoice: string
  readonly saleQueue: { payload_json: string; payload_hash: string; idempotency_key: string }
  readonly refunds: readonly string[]
  readonly quickCreateRequestKey: string
}

/** Builds a register at schema 0033 holding every kind of undelivered work. */
function seedRegisterAt0033(sandbox: DatabaseSandbox): {
  database: SqliteDatabase
  seeded: SeededWork
} {
  const database = openExistingTestDatabase(sandbox)
  runTestMigrations(database, PRE_0034)
  deepEqual(committedVersions(sandbox), PRE_0034_VERSIONS)
  const repositories = realRepositories(database)

  // 1. A sale committed through the real LocalSaleService: its upload is queued, pending, frozen.
  const { localSale } = setUpAuthorizedContext(database, repositories)
  const outcome = localSale.complete(SALE_ATTEMPT, validIntent())
  ok(outcome.outcome === 'committed', `sale not committed: ${JSON.stringify(outcome)}`)
  const saleInvoice = outcome.invoice.localUuid
  const saleQueue = database
    .prepare(
      `SELECT payload_json, payload_hash, idempotency_key, state FROM sync_queue
        WHERE aggregate_type = 'invoice' AND local_aggregate_uuid = ?`
    )
    .get(saleInvoice) as SeededWork['saleQueue'] & { state: string }
  equal(saleQueue.state, 'pending')
  equal(JSON.parse(saleQueue.payload_json).idempotency_key, saleQueue.idempotency_key)

  // 2. Refunds in each resumable state (prepared, dispatched mid-flight, unresolved after timeout).
  const refunds = [
    seedRefund(database, repositories, '21', 'prepared'),
    seedRefund(database, repositories, '22', 'dispatched'),
    seedRefund(database, repositories, '23', 'unresolved')
  ]

  // 3. A pending quick-create request through the real service (frozen canonical bytes).
  const quickCreate = new QuickCreateService({
    database,
    repository: repositories.quickCreate,
    access: {
      access: () => ALLOW,
      assertCanCreate: () => undefined
    },
    session: {
      getContext: () => ({ isAuthenticated: true, userUuid, companyUuid, deviceUuid })
    },
    requestSync: () => undefined
  })
  const customer = quickCreate.createCustomer({
    name: 'Walk-in Ahmed',
    phone: '0500000001',
    email: ''
  })
  equal(repositories.quickCreate.find(customer.requestKey)?.state, 'pending')

  // 4. A rejected sale with an applied disposition and its proof results, valid under 0013:
  //    an accepted proof WITH a server consumption UUID and an overridden proof without one.
  const dispositionInvoice = seedInvoice(repositories, 'd1')
  equal(dispositionInvoice, DISPOSITION_INVOICE)
  database
    .prepare("UPDATE local_invoices SET sync_status = 'rejected' WHERE local_uuid = ?")
    .run(dispositionInvoice)
  insertRow(database, 'invoice_disposition_applications', {
    invoice_local_uuid: dispositionInvoice,
    disposition_uuid: DISPOSITION_UUID,
    decision: 'accept_without_proof',
    result_version: 1,
    result_json: '{"version":1,"decision":"accept_without_proof"}',
    result_hash: sha256('{"version":1,"decision":"accept_without_proof"}'),
    queue_failure_json: '{"backendCode":"DESKTOP_INVOICE_QUARANTINED"}',
    queue_failure_hash: sha256('{"backendCode":"DESKTOP_INVOICE_QUARANTINED"}'),
    request_hash: HASH_64,
    remote_invoice_uuid: id('d5'),
    applied_at: NOW
  })
  insertProof(database, {
    invoice: dispositionInvoice,
    lineIndex: 0,
    proofIndex: 0,
    outcome: 'accepted',
    server: ACCEPTED_SERVER_CONSUMPTION,
    reason: null
  })
  insertProof(database, {
    invoice: dispositionInvoice,
    lineIndex: 0,
    proofIndex: 1,
    outcome: 'overridden',
    server: null,
    reason: 'allocation_sequence_gap'
  })
  insertRow(database, 'stock_allocation_disposition_holds', {
    allocation_uuid: ALLOCATION_UUID,
    rights_generation: 1,
    invoice_local_uuid: dispositionInvoice,
    first_overridden_sequence: 5,
    reason: 'invoice_disposition_chain_break',
    release_allowed: 0,
    created_at: NOW
  })

  // Under 0013 an accepted proof without a server consumption is refused — the reason 0034 exists.
  throws(
    () =>
      insertProof(database, {
        invoice: dispositionInvoice,
        lineIndex: 1,
        proofIndex: 0,
        outcome: 'accepted',
        server: null,
        reason: null
      }),
    /CHECK constraint failed/
  )

  return {
    database,
    seeded: {
      saleInvoice,
      saleQueue: {
        payload_json: saleQueue.payload_json,
        payload_hash: saleQueue.payload_hash,
        idempotency_key: saleQueue.idempotency_key
      },
      refunds,
      quickCreateRequestKey: customer.requestKey
    }
  }
}

function assertHealthy(database: SqliteDatabase): void {
  deepEqual(database.pragma('foreign_key_check'), [])
  equal(database.pragma('integrity_check', { simple: true }), 'ok')
  equal(Number(database.pragma('foreign_keys', { simple: true })), 1)
}

function v34Leftovers(sandbox: DatabaseSandbox): string[] {
  return readCommitted<{ name: string }>(
    sandbox,
    "SELECT name FROM sqlite_master WHERE name LIKE '%\\_v34%' ESCAPE '\\'"
  ).map((row) => row.name)
}

// ---------------------------------------------------------------------------------------------
// 1. Upgrade with pending data
// ---------------------------------------------------------------------------------------------

databaseTest(
  'V1 upgrade 0033 -> latest keeps every pending sale, refund, quick-create and disposition row byte-identical and applies the 0034 CHECK',
  (sandbox) => {
    const { database, seeded } = seedRegisterAt0033(sandbox)
    assertHealthy(database)
    const before = snapshotAllTables(sandbox, ['schema_migrations'])
    const migrationsBefore = readCommitted(
      sandbox,
      'SELECT version, name, applied_at FROM schema_migrations ORDER BY version'
    )

    // Every kind of seeded work is actually present before the upgrade.
    equal(before.sync_queue?.rows.length, 1)
    equal(before.local_refunds?.rows.length, 3)
    equal(before.entity_create_outbox?.rows.length, 1)
    equal(before.invoice_disposition_applications?.rows.length, 1)
    equal(before.invoice_disposition_proof_results?.rows.length, 2)

    runTestMigrations(database, databaseMigrations)

    // Schema is now the latest, and the earlier migration records are untouched.
    deepEqual(committedVersions(sandbox), ALL_VERSIONS)
    equal(Math.max(...committedVersions(sandbox)), LATEST_VERSION)
    deepEqual(
      readCommitted(
        sandbox,
        'SELECT version, name, applied_at FROM schema_migrations WHERE version < 34 ORDER BY version'
      ),
      migrationsBefore
    )
    assertHealthy(database)
    deepEqual(v34Leftovers(sandbox), [])

    // Every row of every table, byte for byte (full JSON and digest per table).
    const after = snapshotAllTables(sandbox, ['schema_migrations'])
    deepEqual(Object.keys(after), Object.keys(before))
    for (const table of Object.keys(before)) {
      deepEqual(after[table]?.rows, before[table]?.rows, `rows of ${table} changed`)
      equal(after[table]?.sha256, before[table]?.sha256, `digest of ${table} changed`)
    }

    // And the specific frozen bytes the backend will receive, read back explicitly.
    deepEqual(
      readCommitted(
        sandbox,
        `SELECT payload_json, payload_hash, idempotency_key FROM sync_queue
          WHERE aggregate_type = 'invoice' AND local_aggregate_uuid = ?`,
        [seeded.saleInvoice]
      ),
      [seeded.saleQueue]
    )
    const refunds = readCommitted<{
      local_uuid: string
      submission_state: string
      request_json: string
      request_sha256: string
    }>(
      sandbox,
      'SELECT local_uuid, submission_state, request_json, request_sha256 FROM local_refunds ORDER BY local_uuid'
    )
    deepEqual(
      refunds.map((row) => [row.local_uuid, row.submission_state]),
      [
        [seeded.refunds[0], 'prepared'],
        [seeded.refunds[1], 'dispatched'],
        [seeded.refunds[2], 'unresolved']
      ]
    )
    for (const row of refunds) {
      equal(row.request_sha256, sha256(row.request_json))
      equal(JSON.parse(row.request_json).idempotency_key, row.local_uuid)
    }
    const outbox = realRepositories(database).quickCreate.find(seeded.quickCreateRequestKey)
    equal(outbox?.state, 'pending')
    deepEqual(JSON.parse(outbox?.canonicalPayloadJson ?? '{}'), {
      address: null,
      email: null,
      name: 'Walk-in Ahmed',
      notes: null,
      phone: '0500000001',
      tax_number: null
    })

    // The rebuilt table carries the 0034 CHECK, not the 0013 one.
    const proofSql = tableSql(sandbox, 'invoice_disposition_proof_results') ?? ''
    ok(proofSql.includes("CHECK (outcome = 'accepted' OR server_consumption_uuid IS NULL)"))
    ok(!proofSql.includes("CHECK ((outcome = 'accepted') = (server_consumption_uuid IS NOT NULL))"))

    // 0034 now ALLOWS an accepted proof without a server consumption UUID (today's backend) ...
    insertProof(database, {
      lineIndex: 1,
      proofIndex: 0,
      outcome: 'accepted',
      server: null,
      reason: null
    })
    // ... still allows one with a UUID ...
    insertProof(database, {
      lineIndex: 1,
      proofIndex: 1,
      outcome: 'accepted',
      server: id('d6'),
      reason: null
    })
    // ... and still FORBIDS a server consumption on an overridden proof.
    throws(
      () =>
        insertProof(database, {
          lineIndex: 1,
          proofIndex: 2,
          outcome: 'overridden',
          server: id('d7'),
          reason: 'allocation_sequence_gap'
        }),
      /CHECK constraint failed/
    )
    // The FK to the applied disposition is still enforced on the rebuilt table.
    throws(
      () =>
        insertProof(database, {
          invoice: id('ff'),
          lineIndex: 0,
          proofIndex: 0,
          outcome: 'accepted',
          server: null,
          reason: null
        }),
      /FOREIGN KEY constraint failed/
    )
    equal(
      readCommitted(sandbox, 'SELECT * FROM invoice_disposition_proof_results').length,
      4,
      'two seeded proofs plus the two accepted inserts; the refused ones left nothing'
    )
    assertHealthy(database)
    closeDatabase(database)
  }
)

// ---------------------------------------------------------------------------------------------
// 2. Unexpected existing rows (a damaged/legacy database)
// ---------------------------------------------------------------------------------------------

/**
 * Asserts the observable result of a failed 0034 against committed state read through a separate
 * connection: the runner's per-migration transaction is rolled back as a whole, so the database is
 * left exactly at 0033 — the original table and its DDL, every row of every table, no `_v34` table.
 */
function assertFailedUpgradeLeftDatabaseAt0033(
  sandbox: DatabaseSandbox,
  database: SqliteDatabase,
  before: Record<string, TableSnapshot>,
  proofSqlBefore: string | null,
  integrityBefore: unknown
): void {
  equal(database.inTransaction, false, 'the runner must not leave a transaction open')
  deepEqual(committedVersions(sandbox), PRE_0034_VERSIONS)
  equal(Math.max(...committedVersions(sandbox)), 33)
  deepEqual(v34Leftovers(sandbox), [])
  equal(tableSql(sandbox, 'invoice_disposition_proof_results'), proofSqlBefore)
  deepEqual(snapshotAllTables(sandbox), before)
  // The connection's own FK enforcement is untouched (0034 is not a foreign_keys = OFF rebuild).
  equal(Number(database.pragma('foreign_keys', { simple: true })), 1)
  // integrity_check reports exactly what it reported before the attempt (the damaged row, if it
  // is a CHECK violation) — the failed migration added no damage of its own.
  deepEqual(database.pragma('integrity_check'), integrityBefore)
}

databaseTest(
  'V1 upgrade with a legacy orphan proof row: 0034 throws FOREIGN KEY constraint failed, is atomic (stays at 0033, all rows intact, no _v34 table) and fails again on every retry',
  (sandbox) => {
    const { database } = seedRegisterAt0033(sandbox)

    // A damaged/legacy database: a proof row whose applied disposition does not exist, written
    // while FK enforcement was off. 0013's CHECKs are satisfied; only the FK is violated.
    database.pragma('foreign_keys = OFF')
    equal(Number(database.pragma('foreign_keys', { simple: true })), 0)
    insertProof(database, {
      invoice: id('ff'),
      lineIndex: 0,
      proofIndex: 0,
      outcome: 'overridden',
      server: null,
      reason: 'allocation_sequence_gap'
    })
    database.pragma('foreign_keys = ON')
    equal(
      (database.pragma('foreign_key_check') as { table: string }[])
        .map((row) => row.table)
        .join(','),
      'invoice_disposition_proof_results'
    )

    const before = snapshotAllTables(sandbox)
    equal(before.invoice_disposition_proof_results?.rows.length, 3)
    const proofSqlBefore = tableSql(sandbox, 'invoice_disposition_proof_results')
    const integrityBefore = database.pragma('integrity_check')
    deepEqual(integrityBefore, [{ integrity_check: 'ok' }])

    // Observed behaviour: 0034 copies rows with `INSERT ... SELECT *` while foreign_keys = ON,
    // so the orphan aborts the copy and the runner's transaction rolls back.
    throws(() => runTestMigrations(database, databaseMigrations), /FOREIGN KEY constraint failed/)
    assertFailedUpgradeLeftDatabaseAt0033(
      sandbox,
      database,
      before,
      proofSqlBefore,
      integrityBefore
    )

    // Not self-healing: the next startup fails identically and still changes nothing.
    throws(() => runTestMigrations(database, databaseMigrations), /FOREIGN KEY constraint failed/)
    assertFailedUpgradeLeftDatabaseAt0033(
      sandbox,
      database,
      before,
      proofSqlBefore,
      integrityBefore
    )
    closeDatabase(database)
  }
)

databaseTest(
  'V1 upgrade with a legacy CHECK-violating proof row (overridden + server consumption): 0034 throws CHECK constraint failed and is atomic at 0033',
  (sandbox) => {
    const { database } = seedRegisterAt0033(sandbox)

    // A row no constraint-respecting writer could produce under 0013 OR 0034: an overridden proof
    // with a server consumption UUID, written with CHECK enforcement disabled.
    database.pragma('ignore_check_constraints = ON')
    insertProof(database, {
      lineIndex: 2,
      proofIndex: 0,
      outcome: 'overridden',
      server: id('d8'),
      reason: 'allocation_sequence_gap'
    })
    database.pragma('ignore_check_constraints = OFF')
    deepEqual(database.pragma('foreign_key_check'), [])

    const before = snapshotAllTables(sandbox)
    equal(before.invoice_disposition_proof_results?.rows.length, 3)
    const proofSqlBefore = tableSql(sandbox, 'invoice_disposition_proof_results')
    notEqual(proofSqlBefore, null)
    // SQLite's own integrity_check already flags the damaged row at 0033.
    const integrityBefore = database.pragma('integrity_check')
    deepEqual(integrityBefore, [
      { integrity_check: 'CHECK constraint failed in invoice_disposition_proof_results' }
    ])

    throws(() => runTestMigrations(database, databaseMigrations), /CHECK constraint failed/)
    assertFailedUpgradeLeftDatabaseAt0033(
      sandbox,
      database,
      before,
      proofSqlBefore,
      integrityBefore
    )
    closeDatabase(database)
  }
)

// ---------------------------------------------------------------------------------------------
// 3. Re-running the runner on an already-latest database
// ---------------------------------------------------------------------------------------------

databaseTest(
  'V1 upgrade re-running the migration runner on an already-latest database is a no-op (every table, including schema_migrations, unchanged)',
  (sandbox) => {
    const { database } = seedRegisterAt0033(sandbox)
    runTestMigrations(database, databaseMigrations)
    deepEqual(committedVersions(sandbox), ALL_VERSIONS)
    const before = snapshotAllTables(sandbox)
    const schemaBefore = readCommitted(
      sandbox,
      'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name'
    )

    runTestMigrations(database, databaseMigrations)
    runTestMigrations(database, databaseMigrations)
    closeDatabase(database)

    // A fresh connection (the next app start) runs it once more.
    const reopened = openExistingTestDatabase(sandbox)
    runTestMigrations(reopened, databaseMigrations)
    assertHealthy(reopened)
    closeDatabase(reopened)

    deepEqual(snapshotAllTables(sandbox), before)
    deepEqual(
      readCommitted(
        sandbox,
        'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name'
      ),
      schemaBefore
    )
    deepEqual(committedVersions(sandbox), ALL_VERSIONS)
  }
)
