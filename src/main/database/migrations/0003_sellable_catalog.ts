import type { DatabaseMigration } from '../migrator'

export const sellableCatalogMigration: DatabaseMigration = {
  version: 3,
  name: 'sellable_catalog',
  up(database) {
    database.exec(`
      CREATE TABLE catalog_metadata (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision TEXT NOT NULL UNIQUE,
        generated_at TEXT NOT NULL,
        valid_until TEXT NOT NULL,
        quantity_scale INTEGER NOT NULL CHECK (quantity_scale = 3),
        minimum_quantity TEXT NOT NULL,
        maximum_quantity TEXT NOT NULL,
        maximum_unit_price INTEGER NOT NULL CHECK (maximum_unit_price > 0),
        maximum_line_total INTEGER NOT NULL CHECK (maximum_line_total > 0),
        maximum_invoice_total INTEGER NOT NULL CHECK (maximum_invoice_total > 0),
        mixed_tax_mode_policy TEXT NOT NULL CHECK (mixed_tax_mode_policy = 'single_invoice_mode'),
        fetched_at TEXT NOT NULL
      );

      CREATE TABLE catalog_categories (
        uuid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        search_name TEXT NOT NULL,
        is_active INTEGER NOT NULL CHECK (is_active IN (0, 1)),
        updated_at TEXT
      );
      CREATE INDEX idx_catalog_categories_active_name
        ON catalog_categories(is_active, search_name, uuid);

      CREATE TABLE catalog_products (
        uuid TEXT PRIMARY KEY,
        category_uuid TEXT REFERENCES catalog_categories(uuid),
        name TEXT NOT NULL,
        search_name TEXT NOT NULL,
        sku TEXT,
        search_sku TEXT,
        barcode TEXT,
        description TEXT,
        status TEXT NOT NULL,
        is_active INTEGER NOT NULL CHECK (is_active IN (0, 1)),
        track_stock INTEGER NOT NULL CHECK (track_stock IN (0, 1)),
        unit TEXT,
        price_amount INTEGER,
        price_currency TEXT,
        price_source TEXT,
        price_revision TEXT,
        price_valid_from TEXT,
        price_valid_until TEXT,
        tax_uuid TEXT,
        tax_mode TEXT CHECK (tax_mode IN ('none', 'inclusive', 'exclusive')),
        tax_rate_basis_points INTEGER CHECK (
          tax_rate_basis_points IS NULL OR tax_rate_basis_points BETWEEN 0 AND 10000
        ),
        tax_revision TEXT,
        updated_at TEXT,
        CHECK (price_amount IS NULL OR price_amount BETWEEN 0 AND 1000000000)
      );
      CREATE INDEX idx_catalog_products_browse
        ON catalog_products(is_active, status, category_uuid, search_name, uuid);
      CREATE INDEX idx_catalog_products_search_name
        ON catalog_products(search_name, uuid);
      CREATE INDEX idx_catalog_products_search_sku
        ON catalog_products(search_sku, uuid);
      CREATE INDEX idx_catalog_products_barcode
        ON catalog_products(barcode);

      CREATE TABLE catalog_product_barcodes (
        uuid TEXT PRIMARY KEY,
        product_uuid TEXT NOT NULL REFERENCES catalog_products(uuid),
        barcode TEXT NOT NULL,
        type TEXT,
        is_primary INTEGER NOT NULL CHECK (is_primary IN (0, 1)),
        is_active INTEGER NOT NULL CHECK (is_active IN (0, 1)),
        updated_at TEXT
      );
      CREATE INDEX idx_catalog_product_barcodes_lookup
        ON catalog_product_barcodes(barcode, is_active, product_uuid);

      CREATE TABLE catalog_stock_items (
        uuid TEXT PRIMARY KEY,
        product_uuid TEXT NOT NULL REFERENCES catalog_products(uuid),
        warehouse_uuid TEXT NOT NULL,
        quantity TEXT NOT NULL,
        reserved_quantity TEXT NOT NULL,
        available_quantity TEXT NOT NULL,
        minimum_quantity TEXT,
        maximum_quantity TEXT,
        is_active INTEGER NOT NULL CHECK (is_active IN (0, 1)),
        updated_at TEXT
      );
      CREATE INDEX idx_catalog_stock_items_product
        ON catalog_stock_items(product_uuid, is_active);
      CREATE INDEX idx_catalog_stock_items_warehouse
        ON catalog_stock_items(warehouse_uuid, is_active);
    `)
  }
}
