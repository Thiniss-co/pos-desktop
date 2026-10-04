import type { SqliteDatabase } from '../database/connection'
import { ASSET_RETRY_MAX_ATTEMPTS, isAssetRetryDue } from '../sync/assetRetryPolicy'

/**
 * Owner UX plan P8 — the register's product image references and their verified bytes.
 *
 * The server is authoritative; this repository records what a negotiated bootstrap delivered:
 * - a reference is replaced only by a strictly newer `revision` (a stale or reordered response never
 *   restores an older image); the same revision with different hashes is a protocol error, rejected
 *   and left for the next bootstrap;
 * - a full-scope block also removes references of products that are no longer in the persisted
 *   catalog;
 * - the register holds one company at a time: applying a block for a company drops every other
 *   company's references and cached bytes;
 * - bytes are stored only after the caller verified them, and are dropped once no reference uses them.
 */

export interface ProductImageAssetMetadata {
  readonly sha256: string
  readonly byteLength: number
  readonly widthPx: number
  readonly heightPx: number
  readonly mediaType: string
}

export interface IncomingProductImageEntry {
  readonly productUuid: string
  readonly revision: number
  readonly image: {
    readonly thumb: ProductImageAssetMetadata
    readonly display: ProductImageAssetMetadata
  } | null
}

export interface ProductImageApplyOutcome {
  readonly applied: number
  readonly stale: number
  readonly conflicts: readonly string[]
  readonly removed: number
}

export interface PendingProductImageAsset {
  readonly sha256: string
  readonly byteLength: number
  readonly widthPx: number
  readonly heightPx: number
}

/**
 * A failed asset is retried on later bootstraps only, once its delay has passed (`assetRetryPolicy`), and
 * skipped after this many failures until a newer reference names it.
 */
export const MAX_PRODUCT_IMAGE_ATTEMPTS = ASSET_RETRY_MAX_ATTEMPTS

interface StoredReference {
  readonly revision: number
  readonly thumb_sha256: string | null
  readonly display_sha256: string | null
}

export class ProductImageRepository {
  constructor(private readonly database: SqliteDatabase) {}

  /**
   * Applies a block for the responding company (`persistedProductUuids` null for a delta block: no removals). Must run inside the bootstrap persist
   * transaction (both the full persist and the same-`generated_at` fast path), so references follow
   * exactly the catalog that was persisted.
   */
  applyFullBlock(
    companyUuid: string,
    entries: readonly IncomingProductImageEntry[],
    persistedProductUuids: readonly string[] | null,
    receivedAt: string
  ): ProductImageApplyOutcome {
    this.database
      .prepare('DELETE FROM catalog_product_images WHERE company_uuid <> ?')
      .run(companyUuid)
    this.database
      .prepare('DELETE FROM product_image_assets WHERE company_uuid <> ?')
      .run(companyUuid)

    const select = this.database.prepare(
      'SELECT revision, thumb_sha256, display_sha256 FROM catalog_product_images WHERE company_uuid = ? AND product_uuid = ?'
    )
    const upsert = this.database.prepare(
      `INSERT INTO catalog_product_images (company_uuid, product_uuid, revision, thumb_sha256, display_sha256, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (company_uuid, product_uuid) DO UPDATE SET
         revision = excluded.revision, thumb_sha256 = excluded.thumb_sha256,
         display_sha256 = excluded.display_sha256, updated_at = excluded.updated_at`
    )
    const registerAsset = this.database.prepare(
      `INSERT INTO product_image_assets (company_uuid, sha256, media_type, width_px, height_px, byte_length, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')
       ON CONFLICT (company_uuid, sha256) DO UPDATE SET attempts = CASE WHEN status = 'pending' THEN 0 ELSE attempts END`
    )

    let applied = 0
    let stale = 0
    const conflicts: string[] = []

    for (const entry of entries) {
      const stored = select.get(companyUuid, entry.productUuid) as StoredReference | undefined
      const thumb = entry.image?.thumb.sha256 ?? null
      const display = entry.image?.display.sha256 ?? null

      if (stored !== undefined && entry.revision <= stored.revision) {
        if (
          entry.revision === stored.revision &&
          (stored.thumb_sha256 !== thumb || stored.display_sha256 !== display)
        ) {
          conflicts.push(entry.productUuid)
        } else {
          stale += 1
        }
        continue
      }

      upsert.run(companyUuid, entry.productUuid, entry.revision, thumb, display, receivedAt)
      for (const asset of entry.image ? [entry.image.thumb, entry.image.display] : []) {
        registerAsset.run(
          companyUuid,
          asset.sha256,
          asset.mediaType,
          asset.widthPx,
          asset.heightPx,
          asset.byteLength
        )
      }
      applied += 1
    }

    if (conflicts.length > 0) {
      // A protocol error from the server: the stored references are kept until a newer revision.
      console.warn(
        `[pos-images] ${conflicts.length} product image entr${conflicts.length === 1 ? 'y' : 'ies'} rejected: same revision, different content`
      )
    }

    if (persistedProductUuids === null) {
      this.dropUnreferencedAssets(companyUuid)

      return { applied, stale, conflicts, removed: 0 }
    }

    const keep = new Set(persistedProductUuids)
    const referenced = this.database
      .prepare('SELECT product_uuid FROM catalog_product_images WHERE company_uuid = ?')
      .all(companyUuid) as { product_uuid: string }[]
    const remove = this.database.prepare(
      'DELETE FROM catalog_product_images WHERE company_uuid = ? AND product_uuid = ?'
    )
    let removed = 0
    for (const { product_uuid } of referenced) {
      if (!keep.has(product_uuid)) {
        remove.run(companyUuid, product_uuid)
        removed += 1
      }
    }

    this.dropUnreferencedAssets(companyUuid)

    return { applied, stale, conflicts, removed }
  }

  private dropUnreferencedAssets(companyUuid: string): void {
    this.database
      .prepare(
        `DELETE FROM product_image_assets WHERE company_uuid = ? AND sha256 NOT IN (
           SELECT thumb_sha256 FROM catalog_product_images WHERE company_uuid = ? AND thumb_sha256 IS NOT NULL
           UNION SELECT display_sha256 FROM catalog_product_images WHERE company_uuid = ? AND display_sha256 IS NOT NULL)`
      )
      .run(companyUuid, companyUuid, companyUuid)
  }

  /**
   * Assets due for a fetch at `now`, in a stable order: never tried, or failed fewer than the allowed
   * times and past their retry delay.
   */
  findPendingAssets(
    companyUuid: string,
    limit: number,
    now: Date
  ): readonly PendingProductImageAsset[] {
    const rows = this.database
      .prepare(
        `SELECT sha256, byte_length AS byteLength, width_px AS widthPx, height_px AS heightPx,
                attempts, last_attempt_at AS lastAttemptAt
         FROM product_image_assets
         WHERE company_uuid = ? AND status = 'pending' AND attempts < ?
         ORDER BY sha256`
      )
      .all(companyUuid, MAX_PRODUCT_IMAGE_ATTEMPTS) as (PendingProductImageAsset & {
      attempts: number
      lastAttemptAt: string | null
    })[]

    return rows
      .filter((row) => isAssetRetryDue(row.attempts, row.lastAttemptAt, now))
      .slice(0, limit)
      .map(({ sha256, byteLength, widthPx, heightPx }) => ({
        sha256,
        byteLength,
        widthPx,
        heightPx
      }))
  }

  /** Stores verified bytes; false when the asset is no longer pending for this company (dropped meanwhile). */
  markAvailable(companyUuid: string, sha256: string, content: Buffer, fetchedAt: string): boolean {
    return (
      this.database
        .prepare(
          `UPDATE product_image_assets SET status = 'available', content = ?, last_attempt_at = ?
           WHERE company_uuid = ? AND sha256 = ? AND status = 'pending' AND byte_length = ?`
        )
        .run(content, fetchedAt, companyUuid, sha256, content.length).changes > 0
    )
  }

  markFailed(companyUuid: string, sha256: string, attemptedAt: string): void {
    this.database
      .prepare(
        `UPDATE product_image_assets SET attempts = attempts + 1, last_attempt_at = ?
         WHERE company_uuid = ? AND sha256 = ? AND status = 'pending'`
      )
      .run(attemptedAt, companyUuid, sha256)
  }

  /** The verified thumbnail bytes of the given products (only those available), for catalog listings. */
  thumbnailsFor(companyUuid: string, productUuids: readonly string[]): Map<string, Buffer> {
    const result = new Map<string, Buffer>()
    if (productUuids.length === 0) {
      return result
    }
    const placeholders = productUuids.map(() => '?').join(', ')
    const rows = this.database
      .prepare(
        `SELECT image.product_uuid AS productUuid, asset.content AS content
         FROM catalog_product_images image
         JOIN product_image_assets asset ON asset.company_uuid = image.company_uuid AND asset.sha256 = image.thumb_sha256
         WHERE image.company_uuid = ? AND asset.status = 'available' AND image.product_uuid IN (${placeholders})`
      )
      .all(companyUuid, ...productUuids) as { productUuid: string; content: Buffer }[]
    for (const row of rows) {
      result.set(row.productUuid, row.content)
    }
    return result
  }

  /** Every cached reference and byte (a sign-out of the company or a re-registration elsewhere). */
  clearAll(): void {
    this.database.prepare('DELETE FROM catalog_product_images').run()
    this.database.prepare('DELETE FROM product_image_assets').run()
  }
}
