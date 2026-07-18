import type { DatabaseMigration } from '../migrator'

export const activationAuthBootstrapMigration: DatabaseMigration = {
  version: 2,
  name: 'activation_auth_bootstrap',
  up(database) {
    database.exec(`
      ALTER TABLE license_state_metadata ADD COLUMN details_json TEXT;
      ALTER TABLE bootstrap_state ADD COLUMN snapshot_version TEXT;
      ALTER TABLE bootstrap_state ADD COLUMN server_time TEXT;
      ALTER TABLE bootstrap_state ADD COLUMN counts_json TEXT;

      CREATE TABLE device_registration (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        server_device_id TEXT NOT NULL,
        status TEXT NOT NULL,
        last_seen_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE bootstrap_company (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        company_uuid TEXT NOT NULL,
        name TEXT NOT NULL,
        is_active INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE bootstrap_branch (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        branch_uuid TEXT NOT NULL,
        name TEXT NOT NULL,
        is_active INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE bootstrap_warehouse (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        warehouse_uuid TEXT NOT NULL,
        name TEXT NOT NULL,
        is_active INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE bootstrap_subscription (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        plan_code TEXT,
        plan_name TEXT,
        status TEXT NOT NULL,
        billing_cycle TEXT NOT NULL,
        starts_at TEXT,
        renews_at TEXT,
        expires_at TEXT,
        grace_ends_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE bootstrap_features (
        feature_code TEXT PRIMARY KEY,
        is_enabled INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE bootstrap_limits (
        limit_key TEXT PRIMARY KEY,
        limit_value INTEGER,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE bootstrap_permissions (
        permission_name TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE bootstrap_role (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        name TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE categories (
        uuid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        is_active INTEGER NOT NULL,
        updated_at TEXT
      );

      CREATE TABLE products (
        uuid TEXT PRIMARY KEY,
        server_id INTEGER NOT NULL UNIQUE,
        company_id INTEGER NOT NULL,
        category_id INTEGER,
        name TEXT NOT NULL,
        sku TEXT,
        barcode TEXT,
        description TEXT,
        status TEXT,
        is_active INTEGER NOT NULL,
        track_stock INTEGER NOT NULL,
        unit TEXT,
        tax_mode TEXT,
        updated_at TEXT
      );

      CREATE TABLE product_barcodes (
        id TEXT PRIMARY KEY,
        product_id INTEGER NOT NULL REFERENCES products(server_id),
        barcode TEXT NOT NULL,
        type TEXT,
        is_primary INTEGER NOT NULL,
        is_active INTEGER NOT NULL,
        updated_at TEXT
      );
      CREATE INDEX idx_product_barcodes_product_id ON product_barcodes(product_id);
      CREATE INDEX idx_product_barcodes_barcode ON product_barcodes(barcode);

      CREATE TABLE product_prices (
        id TEXT PRIMARY KEY,
        product_id INTEGER NOT NULL REFERENCES products(server_id),
        label TEXT,
        amount INTEGER NOT NULL,
        currency TEXT NOT NULL,
        price_type TEXT,
        is_active INTEGER NOT NULL,
        starts_at TEXT,
        ends_at TEXT,
        updated_at TEXT
      );
      CREATE INDEX idx_product_prices_product_id ON product_prices(product_id);

      CREATE TABLE stock_items (
        id TEXT PRIMARY KEY,
        product_id INTEGER NOT NULL REFERENCES products(server_id),
        warehouse_id INTEGER NOT NULL,
        quantity TEXT NOT NULL,
        reserved_quantity TEXT NOT NULL,
        available_quantity TEXT NOT NULL,
        minimum_quantity TEXT,
        maximum_quantity TEXT,
        is_active INTEGER NOT NULL,
        updated_at TEXT
      );
      CREATE INDEX idx_stock_items_product_id ON stock_items(product_id);
      CREATE INDEX idx_stock_items_warehouse_id ON stock_items(warehouse_id);

      CREATE TABLE taxes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        code TEXT,
        rate REAL NOT NULL,
        type TEXT,
        is_default INTEGER NOT NULL,
        is_active INTEGER NOT NULL,
        updated_at TEXT
      );

      CREATE TABLE payment_methods (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        code TEXT,
        type TEXT,
        is_active INTEGER NOT NULL,
        allows_change INTEGER NOT NULL,
        requires_reference INTEGER NOT NULL,
        sort_order INTEGER NOT NULL,
        updated_at TEXT
      );

      CREATE TABLE customers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        tax_number TEXT,
        address TEXT,
        notes TEXT,
        is_active INTEGER NOT NULL,
        updated_at TEXT
      );
    `)
  }
}
