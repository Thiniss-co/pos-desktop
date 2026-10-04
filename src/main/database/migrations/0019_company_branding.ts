import type { DatabaseMigration } from '../migrator'

/**
 * Owner UX plan P9 — the company's identity on the register.
 *
 * Additive only.
 *
 * - `company_branding` — the brand the server delivered (negotiated bootstrap block) for the company:
 *   primary colour, logo reference and the brand `revision`. Replaced only by a strictly newer revision;
 *   the same revision with different content is rejected.
 * - `company_brand_assets` — the logo bytes, fetched in the background and stored only after the hash,
 *   PNG signature, length and decoded size agree with the declaration.
 */
export const companyBrandingMigration: DatabaseMigration = {
  version: 19,
  name: 'company_branding',
  up(database) {
    database.exec(`
      CREATE TABLE company_branding (
        company_uuid   TEXT PRIMARY KEY CHECK (length(company_uuid) = 36),
        primary_color  TEXT CHECK (primary_color IS NULL OR (length(primary_color) = 7 AND primary_color LIKE '#%')),
        logo_sha256    TEXT CHECK (logo_sha256 IS NULL OR length(logo_sha256) = 64),
        revision       INTEGER NOT NULL CHECK (revision >= 0),
        updated_at     TEXT NOT NULL
      ) STRICT;

      CREATE TABLE company_brand_assets (
        company_uuid    TEXT NOT NULL CHECK (length(company_uuid) = 36),
        sha256          TEXT NOT NULL CHECK (length(sha256) = 64),
        width_px        INTEGER NOT NULL CHECK (width_px BETWEEN 1 AND 512),
        height_px       INTEGER NOT NULL CHECK (height_px BETWEEN 1 AND 512),
        byte_length     INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 131072),
        status          TEXT NOT NULL CHECK (status IN ('pending','available')),
        content         BLOB CHECK (content IS NULL OR length(content) = byte_length),
        attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        last_attempt_at TEXT,
        PRIMARY KEY (company_uuid, sha256),
        CHECK ((status = 'available') = (content IS NOT NULL))
      ) STRICT;
    `)
  }
}
