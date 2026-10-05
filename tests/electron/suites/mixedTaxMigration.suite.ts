import { deepEqual, equal, ok, throws } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import { databaseMigrations } from '../../../src/main/database/migrations'
import { databaseTest } from '../support/sandbox'
import { readCommitted } from '../support/committedState'
import { openPreMixedTaxTestDatabase, runTestMigrations } from '../support/openTestDatabase'
import { realRepositories } from '../support/realRepositories'
import { setUpAuthorizedContext, validIntent } from '../support/localSaleFixture'

/**
 * POS improvements, Stage 4 — migration 0022 on a POPULATED pre-0022 database.
 *
 * `local_invoices` is rebuilt to admit the `mixed` header. It is referenced by items, payments,
 * movements, consumptions, refunds, receipt context, disposition rows and sale attempts, so the proof
 * is that every committed row survives byte-identical, every reference still resolves, and the new
 * constraints hold — not merely that a fresh database migrates.
 */

const DEPENDENT_TABLES = [
  'local_invoices',
  'local_invoice_items',
  'local_invoice_payments',
  'sale_attempts',
  'sync_queue',
  'catalog_metadata'
] as const

databaseTest(
  'migration 0022 keeps every committed sale row and reference, then admits mixed headers and categories',
  (sandbox) => {
    const database = openPreMixedTaxTestDatabase(sandbox)
    try {
      const repositories = realRepositories(database)
      const { localSale } = setUpAuthorizedContext(database, repositories)
      const first = localSale.complete('f0000000-0000-4000-8000-000000000001', validIntent())
      const second = localSale.complete('f0000000-0000-4000-8000-000000000002', validIntent())
      ok(first.outcome === 'committed' && second.outcome === 'committed')

      const before = Object.fromEntries(
        DEPENDENT_TABLES.map((table) => [
          table,
          readCommitted(sandbox, `SELECT * FROM ${table} ORDER BY 1`)
        ])
      )
      equal((before.local_invoices as unknown[]).length, 2)

      runTestMigrations(database, databaseMigrations)

      for (const table of DEPENDENT_TABLES) {
        const after = readCommitted(sandbox, `SELECT * FROM ${table} ORDER BY 1`).map((row) => {
          // The additive columns are new (0022's categories; 0032's offers); everything that existed
          // is unchanged.
          const {
            tax_category: _category,
            offer_revision_uuid: _offer,
            offer_name: _offerName,
            ...rest
          } = row as Record<string, unknown>
          void _category
          void _offer
          void _offerName
          return rest
        })
        deepEqual(after, before[table], `${table} changed across migration 0022`)
      }
      deepEqual(database.pragma('foreign_key_check'), [])
      deepEqual(
        (
          database
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'local_invoices' AND name LIKE 'idx_%' ORDER BY name"
            )
            .all() as Array<{ name: string }>
        ).map((row) => row.name),
        ['idx_local_invoices_owner', 'idx_local_invoices_sold_at', 'idx_local_invoices_sync_status']
      )

      // The widened constraints: a header may now be `mixed`; a LINE never may; categories are closed.
      database.prepare("UPDATE catalog_metadata SET mixed_tax_mode_policy = 'per_line'").run()
      throws(() =>
        database.prepare("UPDATE catalog_metadata SET mixed_tax_mode_policy = 'bogus'").run()
      )
      database.prepare("UPDATE local_invoices SET tax_mode = 'mixed' WHERE rowid = 1").run()
      throws(() => database.prepare("UPDATE local_invoices SET tax_mode = 'bogus'").run())
      throws(() => database.prepare("UPDATE local_invoice_items SET tax_mode = 'mixed'").run())
      database.prepare("UPDATE local_invoice_items SET tax_category = 'zero_rated'").run()
      throws(() => database.prepare("UPDATE local_invoice_items SET tax_category = 'bogus'").run())
      throws(() => database.prepare("UPDATE catalog_products SET tax_category = 'bogus'").run())
    } finally {
      closeDatabase(database)
    }
  }
)
