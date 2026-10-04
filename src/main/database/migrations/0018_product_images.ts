import type { DatabaseMigration } from '../migrator'

/**
 * Owner UX plan P8 — product images on the register.
 *
 * Additive only.
 *
 * - `catalog_product_images` — the image reference the server delivered for a product (negotiated
 *   bootstrap block), keyed by company and product, with the server's image `revision`. A reference is
 *   only ever replaced by a strictly newer revision, so a stale or reordered bootstrap can never bring
 *   back an older image. Both hashes NULL is a removal the server announced.
 * - `product_image_assets` — the bytes of a referenced image, keyed by company and content hash, fetched
 *   in the background and stored only after the hash, WebP signature, length and decoded size agree with
 *   what the server declared. Until then (`pending`) the register shows the product's monogram.
 */
export const productImagesMigration: DatabaseMigration = {
  version: 18,
  name: 'product_images',
  up(database) {
    database.exec(`
      CREATE TABLE catalog_product_images (
        company_uuid   TEXT NOT NULL CHECK (length(company_uuid) = 36),
        product_uuid   TEXT NOT NULL CHECK (length(product_uuid) = 36),
        revision       INTEGER NOT NULL CHECK (revision >= 0),
        thumb_sha256   TEXT CHECK (thumb_sha256 IS NULL OR length(thumb_sha256) = 64),
        display_sha256 TEXT CHECK (display_sha256 IS NULL OR length(display_sha256) = 64),
        updated_at     TEXT NOT NULL,
        PRIMARY KEY (company_uuid, product_uuid),
        CHECK ((thumb_sha256 IS NULL) = (display_sha256 IS NULL))
      ) STRICT;

      CREATE TABLE product_image_assets (
        company_uuid    TEXT NOT NULL CHECK (length(company_uuid) = 36),
        sha256          TEXT NOT NULL CHECK (length(sha256) = 64),
        media_type      TEXT NOT NULL CHECK (media_type = 'image/webp'),
        width_px        INTEGER NOT NULL CHECK (width_px BETWEEN 1 AND 640),
        height_px       INTEGER NOT NULL CHECK (height_px BETWEEN 1 AND 640),
        byte_length     INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 262144),
        status          TEXT NOT NULL CHECK (status IN ('pending','available')),
        content         BLOB CHECK (content IS NULL OR length(content) = byte_length),
        attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        last_attempt_at TEXT,
        PRIMARY KEY (company_uuid, sha256),
        CHECK ((status = 'available') = (content IS NOT NULL))
      ) STRICT;

      CREATE INDEX idx_product_image_assets_pending
        ON product_image_assets(company_uuid, status, attempts);
    `)
  }
}
