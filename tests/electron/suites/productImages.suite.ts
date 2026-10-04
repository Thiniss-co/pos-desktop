import { deepEqual, equal, ok } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import type { ProductImagesBlock } from '../../../src/main/http/desktopResources.contract'
import { desktopBootstrapFixture } from '../../../src/main/testing/fixtures/desktopBootstrap.fixture'
import { databaseTest } from '../support/sandbox'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories } from '../support/realRepositories'

/**
 * Owner UX plan P8 — product image references applied through the real bootstrap persist (full
 * path and same-`generated_at` fast path) and the real repository, against a temp SQLite database.
 */

const COMPANY = '11111111-1111-4111-8111-111111111111'
const OTHER_COMPANY = '22222222-2222-4222-8222-222222222222'
const PRODUCT = '55555555-5555-4555-8555-555555555555'
const GONE = '66666666-6666-4666-8666-666666666666'
/** A clock reading after every bootstrap below, for assets never tried. */
const NOW = new Date('2026-01-01T00:05:00.000Z')

function asset(
  seed: string,
  size = 160
): {
  sha256: string
  byte_length: number
  width_px: number
  height_px: number
  media_type: 'image/webp'
} {
  return {
    sha256: seed.repeat(64).slice(0, 64),
    byte_length: 100,
    width_px: size,
    height_px: size,
    media_type: 'image/webp'
  }
}

function block(
  revision: number,
  image: 'a' | 'b' | null,
  scope: 'full' | 'delta' = 'full'
): ProductImagesBlock {
  return {
    scope,
    since: scope === 'delta' ? '2026-01-01T00:00:00+00:00' : null,
    last_changed_at: null,
    entries: [
      {
        product_uuid: PRODUCT,
        revision,
        image:
          image === null
            ? null
            : {
                thumb: asset(image === 'a' ? '1' : '3'),
                display: asset(image === 'a' ? '2' : '4', 640)
              }
      }
    ]
  }
}

function reference(
  database: ReturnType<typeof openTestDatabase>
): { revision: number; thumb_sha256: string | null } | undefined {
  return database
    .prepare(
      'SELECT revision, thumb_sha256 FROM catalog_product_images WHERE company_uuid = ? AND product_uuid = ?'
    )
    .get(COMPANY, PRODUCT) as { revision: number; thumb_sha256: string | null } | undefined
}

databaseTest(
  'a full block is applied with the catalog, and again on the same-second fast path',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)

    repositories.bootstrapSnapshot.persistSnapshot(
      desktopBootstrapFixture({ product_images: block(1, 'a') }),
      '2026-01-01T00:01:00+00:00'
    )
    equal(reference(database)?.revision, 1)
    equal(repositories.productImages.findPendingAssets(COMPANY, 200, NOW).length, 2)

    // Same catalog contract (fast path): only the image changed, and it is still applied.
    repositories.bootstrapSnapshot.persistSnapshot(
      desktopBootstrapFixture({ product_images: block(2, 'b') }),
      '2026-01-01T00:02:00+00:00'
    )
    equal(reference(database)?.revision, 2)
    equal(reference(database)?.thumb_sha256, '3'.repeat(64))
    // The old image's bytes are no longer referenced and were dropped.
    deepEqual(
      repositories.productImages
        .findPendingAssets(COMPANY, 200, NOW)
        .map((row) => row.sha256)
        .sort(),
      ['3'.repeat(64), '4'.repeat(64)]
    )
    closeDatabase(database)
  }
)

databaseTest(
  'a stale or reordered block never restores an older image; equal revision with other content is a conflict',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    repositories.bootstrapSnapshot.persistSnapshot(
      desktopBootstrapFixture({ product_images: block(2, 'b') }),
      '2026-01-01T00:01:00+00:00'
    )

    const stale = repositories.productImages.applyFullBlock(
      COMPANY,
      [{ productUuid: PRODUCT, revision: 1, image: null }],
      [PRODUCT],
      '2026-01-01T00:02:00Z'
    )
    equal(stale.stale, 1)
    const conflict = repositories.productImages.applyFullBlock(
      COMPANY,
      [
        {
          productUuid: PRODUCT,
          revision: 2,
          image: {
            thumb: {
              sha256: '9'.repeat(64),
              byteLength: 100,
              widthPx: 160,
              heightPx: 160,
              mediaType: 'image/webp'
            },
            display: {
              sha256: '8'.repeat(64),
              byteLength: 100,
              widthPx: 640,
              heightPx: 640,
              mediaType: 'image/webp'
            }
          }
        }
      ],
      [PRODUCT],
      '2026-01-01T00:03:00Z'
    )
    deepEqual(conflict.conflicts, [PRODUCT])
    equal(reference(database)?.revision, 2)
    equal(reference(database)?.thumb_sha256, '3'.repeat(64))

    // An absent block says nothing: the reference is kept.
    repositories.bootstrapSnapshot.persistSnapshot(
      desktopBootstrapFixture(),
      '2026-01-01T00:04:00+00:00'
    )
    equal(reference(database)?.revision, 2)
    closeDatabase(database)
  }
)

databaseTest(
  'a removal is applied; a full block drops references of products no longer in the catalog; another company is cleared',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    repositories.productImages.applyFullBlock(
      COMPANY,
      [{ productUuid: GONE, revision: 1, image: null }],
      null,
      '2026-01-01T00:00:00Z'
    )
    repositories.productImages.applyFullBlock(OTHER_COMPANY, [], [], '2026-01-01T00:00:00Z')
    repositories.productImages.applyFullBlock(
      COMPANY,
      [{ productUuid: GONE, revision: 1, image: null }],
      null,
      '2026-01-01T00:00:00Z'
    )

    repositories.bootstrapSnapshot.persistSnapshot(
      desktopBootstrapFixture({ product_images: block(3, null) }),
      '2026-01-01T00:01:00+00:00'
    )
    equal(reference(database)?.revision, 3)
    equal(reference(database)?.thumb_sha256, null)
    equal(
      (
        database
          .prepare('SELECT COUNT(*) AS n FROM catalog_product_images WHERE product_uuid = ?')
          .get(GONE) as { n: number }
      ).n,
      0
    )
    equal(
      (
        database
          .prepare('SELECT COUNT(*) AS n FROM catalog_product_images WHERE company_uuid <> ?')
          .get(COMPANY) as { n: number }
      ).n,
      0
    )
    closeDatabase(database)
  }
)

databaseTest(
  'verified bytes become thumbnails; a failed asset waits 1 then 5 minutes (across a restart) and stops after three attempts until a newer reference names it',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    repositories.bootstrapSnapshot.persistSnapshot(
      desktopBootstrapFixture({ product_images: block(1, 'a') }),
      '2026-01-01T00:01:00+00:00'
    )
    const images = repositories.productImages

    ok(images.markAvailable(COMPANY, '1'.repeat(64), Buffer.alloc(100, 7), '2026-01-01T00:02:00Z'))
    equal(images.thumbnailsFor(COMPANY, [PRODUCT]).get(PRODUCT)?.length, 100)
    equal(images.thumbnailsFor(OTHER_COMPANY, [PRODUCT]).size, 0)
    // A wrong length is never stored.
    equal(
      images.markAvailable(COMPANY, '2'.repeat(64), Buffer.alloc(99, 7), '2026-01-01T00:02:00Z'),
      false
    )

    const failing = '2'.repeat(64)
    const due = (at: string, db = images): boolean =>
      db.findPendingAssets(COMPANY, 200, new Date(at)).some((row) => row.sha256 === failing)

    // First failure: not again within the minute, then due.
    images.markFailed(COMPANY, failing, '2026-01-01T00:03:00.000Z')
    equal(due('2026-01-01T00:03:59.999Z'), false)
    equal(due('2026-01-01T00:04:00.000Z'), true)
    // Second failure: five minutes, and the wait survives a restart (a fresh connection and repository).
    images.markFailed(COMPANY, failing, '2026-01-01T00:04:00.000Z')
    closeDatabase(database)
    const restarted = openTestDatabase(sandbox)
    const reopened = realRepositories(restarted).productImages
    equal(due('2026-01-01T00:08:59.999Z', reopened), false)
    // A clock moved back an hour keeps waiting rather than retrying at once.
    equal(due('2026-01-01T00:03:00.000Z', reopened), false)
    equal(due('2026-01-01T00:09:00.000Z', reopened), true)
    // Third failure: never again, however late, until a newer reference names it.
    reopened.markFailed(COMPANY, failing, '2026-01-01T00:09:00.000Z')
    equal(due('2027-01-01T00:00:00.000Z', reopened), false)
    closeDatabase(restarted)
  }
)

databaseTest(
  'a retry stamp far ahead of the clock (a clock reset) is not trusted, and the attempt bound still holds',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    repositories.bootstrapSnapshot.persistSnapshot(
      desktopBootstrapFixture({ product_images: block(1, 'a') }),
      '2026-01-01T00:01:00+00:00'
    )
    const images = repositories.productImages
    const failing = '2'.repeat(64)
    images.markFailed(COMPANY, failing, '2026-06-01T00:00:00.000Z')
    const pending = (at: string): string[] =>
      images.findPendingAssets(COMPANY, 200, new Date(at)).map((row) => row.sha256)

    // The clock now reads months earlier than the stamp: waiting for it would hide the image for months.
    ok(pending('2026-01-01T00:02:00.000Z').includes(failing))
    // Within a day ahead, the stamp is respected.
    equal(pending('2026-05-31T12:00:00.000Z').includes(failing), false)
    images.markFailed(COMPANY, failing, '2026-06-01T00:00:00.000Z')
    images.markFailed(COMPANY, failing, '2026-06-01T00:00:00.000Z')
    equal(pending('2026-01-01T00:02:00.000Z').includes(failing), false)
    // The limit is applied after the delay: a not-yet-due asset never takes a due one's place.
    equal(images.findPendingAssets(COMPANY, 1, new Date('2026-01-01T00:02:00.000Z')).length, 1)
    closeDatabase(database)
  }
)

databaseTest('a delta block applies entry by entry and removes nothing', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const images = realRepositories(database).productImages
  images.applyFullBlock(
    COMPANY,
    [{ productUuid: GONE, revision: 1, image: null }],
    null,
    '2026-01-01T00:00:00Z'
  )

  const outcome = images.applyFullBlock(
    COMPANY,
    [{ productUuid: PRODUCT, revision: 1, image: null }],
    null,
    '2026-01-01T00:01:00Z'
  )
  equal(outcome.applied, 1)
  equal(outcome.removed, 0)
  equal(
    (
      database
        .prepare('SELECT COUNT(*) AS n FROM catalog_product_images WHERE company_uuid = ?')
        .get(COMPANY) as { n: number }
    ).n,
    2
  )
  closeDatabase(database)
})
