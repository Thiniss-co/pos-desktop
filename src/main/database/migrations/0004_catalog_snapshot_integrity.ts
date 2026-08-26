import { normalizeCatalogSearch } from '@shared/catalog/normalization'
import type { DatabaseMigration } from '../migrator'

export const catalogSnapshotIntegrityMigration: DatabaseMigration = {
  version: 4,
  name: 'catalog_snapshot_integrity',
  up(database) {
    database.exec(`
      ALTER TABLE catalog_metadata ADD COLUMN expected_counts_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE catalog_metadata ADD COLUMN is_complete INTEGER NOT NULL DEFAULT 0 CHECK (is_complete IN (0, 1));

      ALTER TABLE customers ADD COLUMN search_name TEXT NOT NULL DEFAULT '';
      ALTER TABLE customers ADD COLUMN search_phone TEXT NOT NULL DEFAULT '';

      ALTER TABLE auth_session_metadata ADD COLUMN user_uuid TEXT;
      ALTER TABLE auth_session_metadata ADD COLUMN user_is_active INTEGER NOT NULL DEFAULT 0 CHECK (user_is_active IN (0, 1));
      ALTER TABLE auth_session_metadata ADD COLUMN company_uuid TEXT;
      ALTER TABLE auth_session_metadata ADD COLUMN device_uuid TEXT;
      ALTER TABLE auth_session_metadata ADD COLUMN server_device_id TEXT;

      CREATE INDEX idx_catalog_customers_search_name ON customers(search_name, id);
      CREATE INDEX idx_catalog_customers_search_phone ON customers(search_phone, id);
      CREATE INDEX idx_catalog_customers_active_name ON customers(is_active, search_name, id);
    `)

    const updateCategory = database.prepare(
      'UPDATE catalog_categories SET search_name = ? WHERE uuid = ?'
    )
    const categories = database
      .prepare('SELECT uuid, name FROM catalog_categories')
      .all() as Array<{ readonly uuid: string; readonly name: string }>
    for (const row of categories) {
      updateCategory.run(normalizeCatalogSearch(row.name), row.uuid)
    }

    const updateProduct = database.prepare(
      'UPDATE catalog_products SET search_name = ?, search_sku = ? WHERE uuid = ?'
    )
    const products = database
      .prepare('SELECT uuid, name, sku FROM catalog_products')
      .all() as Array<{ readonly uuid: string; readonly name: string; readonly sku: string | null }>
    for (const row of products) {
      updateProduct.run(
        normalizeCatalogSearch(row.name),
        row.sku === null ? null : normalizeCatalogSearch(row.sku),
        row.uuid
      )
    }

    const updateCustomer = database.prepare(
      'UPDATE customers SET search_name = ?, search_phone = ? WHERE id = ?'
    )
    const customers = database.prepare('SELECT id, name, phone FROM customers').all() as Array<{
      readonly id: string
      readonly name: string
      readonly phone: string | null
    }>
    for (const row of customers) {
      updateCustomer.run(
        normalizeCatalogSearch(row.name),
        row.phone === null ? '' : normalizeCatalogSearch(row.phone),
        row.id
      )
    }
  }
}
