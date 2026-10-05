import type { DatabaseMigration } from '../migrator'

/**
 * Owner expansion Phase E — register offers. Additive only.
 *
 * - `catalog_offers` / `catalog_offer_products`: the offer revisions the active catalog contract
 *   carries (`offers_version=1`), replaced with every applied catalog. They have no foreign key to
 *   `catalog_products`, so replacing the catalogue never has to order its deletes around them; an
 *   offer only ever applies to a product that is in the same contract.
 * - `local_invoice_items.offer_revision_uuid` / `offer_name`: the offer a committed line was sold
 *   under. NULL on every existing row and on every line without an offer, so their upload bytes are
 *   unchanged.
 */
export const catalogOffersMigration: DatabaseMigration = {
  version: 32,
  name: 'catalog_offers',
  up(database) {
    database.exec(`
      CREATE TABLE catalog_offers (
        revision_uuid  TEXT PRIMARY KEY CHECK (length(revision_uuid) = 36),
        name           TEXT NOT NULL,
        type           TEXT NOT NULL CHECK (type IN ('percentage', 'amount_off', 'fixed_price')),
        value          INTEGER NOT NULL CHECK (value >= 0),
        priority       INTEGER NOT NULL,
        ordinal        INTEGER NOT NULL,
        starts_at      TEXT NOT NULL,
        ends_at        TEXT
      ) STRICT;

      CREATE TABLE catalog_offer_products (
        revision_uuid  TEXT NOT NULL REFERENCES catalog_offers(revision_uuid) ON DELETE CASCADE,
        product_uuid   TEXT NOT NULL,
        PRIMARY KEY (revision_uuid, product_uuid)
      ) STRICT;

      CREATE INDEX idx_catalog_offer_products_product ON catalog_offer_products(product_uuid);

      ALTER TABLE local_invoice_items ADD COLUMN offer_revision_uuid TEXT
        CHECK (offer_revision_uuid IS NULL OR length(offer_revision_uuid) = 36);
      ALTER TABLE local_invoice_items ADD COLUMN offer_name TEXT;
    `)
  }
}
