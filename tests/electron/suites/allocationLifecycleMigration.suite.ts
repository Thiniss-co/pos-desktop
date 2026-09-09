import { deepEqual, equal, notEqual, ok, throws } from 'node:assert/strict'

import { closeDatabase, type SqliteDatabase } from '../../../src/main/database/connection'
import type { DatabaseMigration } from '../../../src/main/database/migrator'
import { databaseMigrations } from '../../../src/main/database/migrations'
import { realRepositories } from '../support/realRepositories'
import { databaseTest } from '../support/sandbox'
import { readCommitted } from '../support/committedState'
import {
  openExistingTestDatabase,
  openPreAllocationReconciliationTestDatabase,
  runTestMigrations
} from '../support/openTestDatabase'
import {
  COMPANY_UUID,
  DEVICE_UUID,
  FAR_FUTURE,
  HASH_64,
  NOW,
  PRODUCT_UUID,
  WAREHOUSE_UUID,
  goldenCase,
  insertRow,
  writeInvoiceSkeleton
} from '../support/allocationScenario'
import { allocationItemLineUuid } from '../../../src/main/services/allocationJournal'

/**
 * BH-04B-3 migration 0009, exercised against the *actual* pre-0009 schema with representative
 * pre-existing rows — a partially consumed grant, a pending sale, and its frozen upload payload —
 * rather than only proving that a fresh database migrates.
 */

const ACTIVE_GRANT = '00000000-0000-4000-8000-000000000011'
const SEALED_GRANT = '00000000-0000-4000-8000-000000000012'
const INVOICE_UUID = '00000000-0000-4000-8000-0000000000b1'
const ITEM_UUID = '00000000-0000-4000-8000-000000000e11'
const CONSUMPTION_UUID = '00000000-0000-4000-8000-000000000f11'

/** Writes a grant in the exact pre-0009 column shape, hardcoding the legacy `status` as 0007 did. */
function insertLegacyGrant(
  database: SqliteDatabase,
  allocationUuid: string,
  overrides: Record<string, unknown> = {}
): void {
  insertRow(database, 'stock_allocation_grants', {
    allocation_uuid: allocationUuid,
    contract_version: 1,
    company_uuid: COMPANY_UUID,
    device_uuid: DEVICE_UUID,
    warehouse_uuid: WAREHOUSE_UUID,
    product_uuid: PRODUCT_UUID,
    server_sequence: 1,
    lifecycle_generation: 1,
    granted_quantity_milli: 10_000,
    consume_until: FAR_FUTURE,
    status: 'active',
    envelope_hash: HASH_64,
    received_at: NOW,
    updated_at: NOW,
    rights_generation: 1,
    server_consumed_quantity_milli: 0,
    server_remaining_quantity_milli: 10_000,
    server_status: 'active',
    last_observed_revision: 7,
    ...overrides
  })
}

function tableSql(database: SqliteDatabase, name: string): string {
  return (
    database.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name) as {
      sql: string
    }
  ).sql
}

databaseTest(
  'BH-04B-3 the pre-0009 schema genuinely rejects a sealed envelope, which is the defect being fixed',
  (sandbox) => {
    const database = openPreAllocationReconciliationTestDatabase(sandbox)

    // Reproduced against the real legacy schema: migration 0007's CHECK plus the upsert's hardcoded
    // legacy `status = 'active'` alongside a non-null `sealed_at`.
    throws(
      () => insertLegacyGrant(database, SEALED_GRANT, { sealed_at: NOW }),
      /CHECK constraint failed/
    )
    throws(
      () =>
        insertLegacyGrant(database, SEALED_GRANT, {
          final_consumption_sequence: 2,
          final_consumption_hash: 'b'.repeat(64)
        }),
      /CHECK constraint failed/
    )

    closeDatabase(database)
  }
)

databaseTest(
  'BH-04B-3 migration 0009 preserves grants, pending invoices, journal rows, indexes and foreign keys',
  (sandbox) => {
    const legacy = openPreAllocationReconciliationTestDatabase(sandbox)
    const minimal = goldenCase('minimal-tracked-line')

    insertLegacyGrant(legacy, ACTIVE_GRANT, {
      server_consumed_quantity_milli: 1_000,
      server_remaining_quantity_milli: 9_000
    })
    writeInvoiceSkeleton(legacy, INVOICE_UUID, ITEM_UUID, {
      payloadJson: JSON.stringify(minimal.payload)
    })
    insertRow(legacy, 'local_stock_allocation_consumptions', {
      local_uuid: CONSUMPTION_UUID,
      allocation_uuid: ACTIVE_GRANT,
      consumption_sequence: 1,
      invoice_local_uuid: INVOICE_UUID,
      item_local_uuid: ITEM_UUID,
      quantity_milli: 3_000,
      server_status: 'pending',
      created_at: NOW
    })

    const grantsBefore = legacy
      .prepare('SELECT * FROM stock_allocation_grants ORDER BY allocation_uuid')
      .all()
    const invoicesBefore = legacy.prepare('SELECT * FROM local_invoices').all()
    const queueBefore = legacy.prepare('SELECT * FROM sync_queue').all()
    const indexesBefore = legacy
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='stock_allocation_grants' AND name LIKE 'idx_%' ORDER BY name"
      )
      .all()

    closeDatabase(legacy)

    const database = openExistingTestDatabase(sandbox)
    runTestMigrations(database, databaseMigrations)

    // Nothing about the pre-existing evidence changed except the legacy status mirror, which is now
    // derived from the authoritative value it already had.
    equal(
      (database.prepare('SELECT COUNT(*) AS n FROM stock_allocation_grants').get() as { n: number })
        .n,
      1
    )
    deepEqual(database.prepare('SELECT * FROM local_invoices').all(), invoicesBefore)
    deepEqual(database.prepare('SELECT * FROM sync_queue').all(), queueBefore)
    deepEqual(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='stock_allocation_grants' AND name LIKE 'idx_%' ORDER BY name"
        )
        .all(),
      indexesBefore
    )

    const grantAfter = database
      .prepare('SELECT * FROM stock_allocation_grants WHERE allocation_uuid = ?')
      .get(ACTIVE_GRANT) as Record<string, unknown>
    const grantBefore = grantsBefore[0] as Record<string, unknown>

    for (const column of [
      'allocation_uuid',
      'contract_version',
      'company_uuid',
      'device_uuid',
      'warehouse_uuid',
      'product_uuid',
      'server_sequence',
      'rights_generation',
      'lifecycle_generation',
      'granted_quantity_milli',
      'server_consumed_quantity_milli',
      'server_remaining_quantity_milli',
      'consume_until',
      'status',
      'server_status',
      'envelope_hash',
      'received_at',
      'last_observed_revision',
      'updated_at'
    ]) {
      equal(grantAfter[column], grantBefore[column], `column ${column} changed`)
    }

    // The child's foreign key still resolves to the rebuilt parent.
    ok(
      tableSql(database, 'local_stock_allocation_consumptions').includes(
        'REFERENCES stock_allocation_grants(allocation_uuid)'
      )
    )
    deepEqual(database.pragma('foreign_key_check'), [])

    // BH-04B-3-R1 §4: `foreign_keys` was disabled only for the duration of migration 0009's own
    // transaction (the migrator's `rebuildsForeignKeyReferencedTable` toggle, which happens strictly
    // before/after that transaction — `PRAGMA foreign_keys` is a documented no-op once a transaction
    // is already open). Confirmed restored on the actual connection after successful completion,
    // not merely assumed from the absence of an error.
    equal(database.pragma('foreign_keys', { simple: true }), 1)
    throws(() =>
      insertRow(database, 'local_stock_allocation_consumptions', {
        local_uuid: '00000000-0000-4000-8000-000000000f99',
        allocation_uuid: '00000000-0000-4000-8000-000000000fff',
        consumption_sequence: 9,
        invoice_local_uuid: INVOICE_UUID,
        item_local_uuid: ITEM_UUID,
        quantity_milli: 1,
        server_status: 'pending',
        created_at: NOW
      })
    )

    closeDatabase(database)
  }
)

databaseTest(
  'BH-04B-3 journal evidence is backfilled from the frozen payload and matches the backend vector',
  (sandbox) => {
    const legacy = openPreAllocationReconciliationTestDatabase(sandbox)
    const minimal = goldenCase('minimal-tracked-line')

    insertLegacyGrant(legacy, ACTIVE_GRANT)
    writeInvoiceSkeleton(legacy, INVOICE_UUID, ITEM_UUID, {
      payloadJson: JSON.stringify(minimal.payload)
    })
    insertRow(legacy, 'local_stock_allocation_consumptions', {
      local_uuid: CONSUMPTION_UUID,
      allocation_uuid: ACTIVE_GRANT,
      consumption_sequence: 1,
      invoice_local_uuid: INVOICE_UUID,
      item_local_uuid: ITEM_UUID,
      quantity_milli: 3_000,
      server_status: 'pending',
      created_at: NOW
    })
    closeDatabase(legacy)

    const database = openExistingTestDatabase(sandbox)
    runTestMigrations(database, databaseMigrations)

    const row = database
      .prepare('SELECT * FROM local_stock_allocation_consumptions WHERE local_uuid = ?')
      .get(CONSUMPTION_UUID) as Record<string, unknown>

    // The backfilled request hash is recomputed from the committed request payload — the exact value
    // the backend derives for those same bytes, proven against the shared cross-language vector.
    equal(row.request_hash, minimal.requestHash)
    equal(row.invoice_idempotency_key, INVOICE_UUID)
    equal(row.item_line_uuid, allocationItemLineUuid(INVOICE_UUID, 0))
    equal(row.rights_generation, 1)
    ok(typeof row.chain_hash === 'string' && row.chain_hash.length === 64)
    equal(
      (database.prepare('SELECT COUNT(*) AS n FROM stock_allocation_holds').get() as { n: number })
        .n,
      0
    )

    closeDatabase(database)
  }
)

databaseTest(
  'BH-04B-3 a consumption whose payload is gone is retained and holds its grant instead of being invented',
  (sandbox) => {
    const legacy = openPreAllocationReconciliationTestDatabase(sandbox)

    insertLegacyGrant(legacy, ACTIVE_GRANT)
    // No `payloadJson`: the frozen request body this consumption was committed with is not on disk,
    // so its journal entry cannot be reconstructed from immutable evidence.
    writeInvoiceSkeleton(legacy, INVOICE_UUID, ITEM_UUID)
    insertRow(legacy, 'local_stock_allocation_consumptions', {
      local_uuid: CONSUMPTION_UUID,
      allocation_uuid: ACTIVE_GRANT,
      consumption_sequence: 1,
      invoice_local_uuid: INVOICE_UUID,
      item_local_uuid: ITEM_UUID,
      quantity_milli: 3_000,
      server_status: 'pending',
      created_at: NOW
    })
    closeDatabase(legacy)

    const database = openExistingTestDatabase(sandbox)
    runTestMigrations(database, databaseMigrations)

    const row = database
      .prepare('SELECT * FROM local_stock_allocation_consumptions WHERE local_uuid = ?')
      .get(CONSUMPTION_UUID) as Record<string, unknown>
    const hold = database
      .prepare('SELECT * FROM stock_allocation_holds WHERE allocation_uuid = ?')
      .get(ACTIVE_GRANT) as Record<string, unknown>

    // The row survives untouched — evidence is never deleted to make validation pass.
    equal(row.quantity_milli, 3_000)
    equal(row.consumption_sequence, 1)
    equal(row.request_hash, null)
    equal(row.chain_hash, null)

    // And the grant is held, so it authorizes nothing until reconciliation establishes its prefix.
    equal(hold.reason, 'unreconstructable_prefix')
    equal(realRepositories(database).stockAllocations.spendableMilli(ACTIVE_GRANT), 0)

    closeDatabase(database)
  }
)

databaseTest(
  'BH-04B-3 a failing migration 0009 rolls back to the exact pre-0009 schema and rows',
  (sandbox) => {
    const legacy = openPreAllocationReconciliationTestDatabase(sandbox)

    insertLegacyGrant(legacy, ACTIVE_GRANT)
    const grantsBefore = legacy.prepare('SELECT * FROM stock_allocation_grants').all()
    const schemaBefore = tableSql(legacy, 'stock_allocation_grants')
    closeDatabase(legacy)

    const database = openExistingTestDatabase(sandbox)
    const failing = databaseMigrations.map((migration) =>
      migration.version === 9
        ? {
            ...migration,
            up(target: SqliteDatabase): void {
              migration.up(target)
              throw new Error('injected failure after migration 0009 finished its work')
            }
          }
        : migration
    )

    throws(() => runTestMigrations(database, failing), /injected failure/)

    // BH-04B-3-R1 §3: this is a same-process thrown-exception/transaction-rollback proof — the
    // migrator's `database.transaction(fn)()` wrapper catches the thrown `Error` and issues
    // `ROLLBACK` normally. It is not a killed process, not an abrupt termination, and says nothing
    // about host/power-loss durability; none of those are exercised here or anywhere else in this
    // slice's own suites.
    //
    // This project has no database backup, no `integrity_check` and no down migrations; the
    // migrator's per-migration transaction is the entire recovery mechanism, so it has to hold.
    equal(schemaBefore, tableSql(database, 'stock_allocation_grants'))
    deepEqual(database.prepare('SELECT * FROM stock_allocation_grants').all(), grantsBefore)
    equal(
      (
        database.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 9').get() as {
          n: number
        }
      ).n,
      0
    )
    equal(
      (
        database
          .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'stock_allocation_holds'")
          .get() as { n: number }
      ).n,
      0
    )

    // FK enforcement is restored on the actual connection even though the migration threw — the
    // migrator's `finally` runs regardless of how the transaction call exits. Proven, not assumed:
    // an orphan insert into the (unchanged, pre-0009) schema still fails.
    equal(database.pragma('foreign_keys', { simple: true }), 1)
    throws(() =>
      insertRow(database, 'local_stock_allocation_consumptions', {
        local_uuid: '00000000-0000-4000-8000-000000000f98',
        allocation_uuid: '00000000-0000-4000-8000-000000000ffe',
        consumption_sequence: 1,
        invoice_local_uuid: '00000000-0000-4000-8000-000000000f97',
        item_local_uuid: '00000000-0000-4000-8000-000000000f96',
        quantity_milli: 1,
        server_status: 'pending',
        created_at: NOW
      })
    )

    // The same proof again, but through a genuinely separate read-only connection opened on the
    // sandbox file — not the in-process handle that ran the failing attempt. This is what actually
    // establishes the rollback reached disk rather than only this handle's own view of it.
    deepEqual(
      readCommitted(sandbox, 'SELECT * FROM stock_allocation_grants') as Record<string, unknown>[],
      grantsBefore
    )
    equal(
      readCommitted<{ sql: string }>(
        sandbox,
        "SELECT sql FROM sqlite_master WHERE name = 'stock_allocation_grants'"
      )[0]?.sql,
      schemaBefore
    )
    equal(
      readCommitted<{ n: number }>(
        sandbox,
        'SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 9'
      )[0]?.n,
      0
    )

    // And the real migration still applies cleanly afterwards — proven the same way, from disk.
    runTestMigrations(database, databaseMigrations)
    notEqual(schemaBefore, tableSql(database, 'stock_allocation_grants'))
    deepEqual(database.pragma('foreign_key_check'), [])
    notEqual(
      readCommitted<{ sql: string }>(
        sandbox,
        "SELECT sql FROM sqlite_master WHERE name = 'stock_allocation_grants'"
      )[0]?.sql,
      schemaBefore
    )
    equal(
      readCommitted<{ n: number }>(
        sandbox,
        'SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 9'
      )[0]?.n,
      1
    )

    closeDatabase(database)
  }
)

/**
 * BH-04B-3-R1 §4. The tests above only ever exercise migration 0009's real, correct rebuild — its
 * own `PRAGMA foreign_key_check` has never actually found anything, so a positive empty result
 * alone does not prove the gate would refuse a genuine orphan. This test builds a minimal,
 * throwaway two-table schema (never touching the real `stock_allocation_grants`/production data)
 * through a migration deliberately written to lose one row during its rebuild — creating a real
 * orphan — and proves the same mechanism migration 0009 relies on actually refuses it: the
 * migrator's opt-in `rebuildsForeignKeyReferencedTable` flag, and the migration's own
 * `PRAGMA foreign_key_check` gate immediately before it would otherwise return successfully.
 *
 * SQLite's official recipe for this exact category of change (sqlite.org/lang_altertable.html §8,
 * "Making Other Kinds Of Table Schema Changes") is: disable `foreign_keys` *before* starting the
 * transaction, rebuild, run `PRAGMA foreign_key_check` *before* commit, commit, then re-enable
 * `foreign_keys`. That is exactly what `rebuildsForeignKeyReferencedTable` does — confirmed against
 * the actual SQLite documentation, not assumed. A verified, separate finding
 * (`docs/audits/bh-04b-3-desktop-reconciliation.md` §4) is that `PRAGMA defer_foreign_keys` does
 * NOT substitute for this: empirically, `DROP TABLE` of an FK-referenced parent succeeds under
 * `defer_foreign_keys=ON` (the violation is deferred, not refused immediately), but `COMMIT` then
 * still fails even when a table of the same name with fully consistent data has been renamed back
 * into place and `PRAGMA foreign_key_check` reports zero violations mid-transaction — the deferred
 * violation counter is not reconciled by the later rename. Disabling `foreign_keys` outright for the
 * whole transaction, as the migrator does, has no such gap.
 */
databaseTest(
  'BH-04B-3-R1 the FK-rebuild safety gate genuinely refuses a real orphan and restores enforcement',
  (sandbox) => {
    const seedMigration: DatabaseMigration = {
      version: 1,
      name: 'toy_seed',
      up(target: SqliteDatabase): void {
        target.exec(`
          CREATE TABLE toy_parent (id TEXT PRIMARY KEY);
          CREATE TABLE toy_child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES toy_parent(id));
          INSERT INTO toy_parent VALUES ('p1'), ('p2');
          INSERT INTO toy_child VALUES ('c1', 'p1'), ('c2', 'p2');
        `)
      }
    }

    // Deliberately buggy: copies only 'p1' into the rebuilt table, silently losing 'p2' — exactly
    // the class of mistake the safety gate exists to catch. 'c2' now references a parent row that
    // will not exist once the rebuild completes.
    const buggyRebuild: DatabaseMigration = {
      version: 2,
      name: 'toy_buggy_rebuild',
      rebuildsForeignKeyReferencedTable: true,
      up(target: SqliteDatabase): void {
        target.exec(`
          CREATE TABLE toy_parent_new (id TEXT PRIMARY KEY, note TEXT);
          INSERT INTO toy_parent_new (id, note) SELECT id, 'rebuilt' FROM toy_parent WHERE id = 'p1';
          DROP TABLE toy_parent;
        `)
        target.pragma('legacy_alter_table = ON')
        target.exec('ALTER TABLE toy_parent_new RENAME TO toy_parent')
        target.pragma('legacy_alter_table = OFF')

        const violations = target.pragma('foreign_key_check') as unknown[]
        if (violations.length > 0) {
          throw new Error(`toy_buggy_rebuild left ${violations.length} foreign key violation(s)`)
        }
      }
    }

    const database = openExistingTestDatabase(sandbox)
    runTestMigrations(database, [seedMigration])

    equal(database.pragma('foreign_keys', { simple: true }), 1)
    throws(
      () => runTestMigrations(database, [seedMigration, buggyRebuild]),
      /foreign key violation/
    )

    // The gate fired before success was ever recorded, and the rebuild rolled back completely —
    // both toy rows, and the child row that would have been orphaned, are exactly as they were.
    equal(
      (
        database.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 2').get() as {
          n: number
        }
      ).n,
      0
    )
    deepEqual(database.prepare('SELECT * FROM toy_parent ORDER BY id').all(), [
      { id: 'p1' },
      { id: 'p2' }
    ])
    deepEqual(database.prepare('SELECT * FROM toy_child ORDER BY id').all(), [
      { id: 'c1', parent_id: 'p1' },
      { id: 'c2', parent_id: 'p2' }
    ])
    deepEqual(database.pragma('foreign_key_check'), [])

    // Enforcement is restored on the actual connection even though the migration threw — proven,
    // not assumed: a fresh orphan insert against the now-unchanged toy schema still fails.
    equal(database.pragma('foreign_keys', { simple: true }), 1)
    throws(() =>
      database.prepare('INSERT INTO toy_child VALUES (?, ?)').run('c3', 'does-not-exist')
    )

    closeDatabase(database)
  }
)
