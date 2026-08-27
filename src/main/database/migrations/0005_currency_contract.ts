import type { DatabaseMigration } from '../migrator'

export const currencyContractMigration: DatabaseMigration = {
  version: 5,
  name: 'currency_contract',
  up(database) {
    database.exec(`
      ALTER TABLE catalog_metadata ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD'
        CHECK (currency GLOB '[A-Z][A-Z][A-Z]');
      ALTER TABLE catalog_metadata ADD COLUMN currency_exponent INTEGER NOT NULL DEFAULT 2
        CHECK (currency_exponent BETWEEN 0 AND 3);
      DROP TABLE product_prices;
    `)
  }
}
