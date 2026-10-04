import { deepEqual, equal, ok } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import type { CompanyBrandingBlock } from '../../../src/main/http/desktopResources.contract'
import { desktopBootstrapFixture } from '../../../src/main/testing/fixtures/desktopBootstrap.fixture'
import { databaseTest } from '../support/sandbox'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories } from '../support/realRepositories'

/**
 * Owner UX plan P9 — the company identity applied through the real bootstrap persist, and the
 * company-change fix (Codex R3-5): a device re-registered to another company is detected before any
 * freshness comparison, and the previous company's catalog, images and branding never survive it.
 */

const COMPANY_A = '11111111-1111-4111-8111-111111111111'
const COMPANY_B = '22222222-2222-4222-8222-222222222222'
const LOGO = '7'.repeat(64)

function brand(revision: number, color: string | null, logo = false): CompanyBrandingBlock {
  return {
    primary_color: color,
    logo: logo
      ? { sha256: LOGO, byte_length: 64, width_px: 200, height_px: 80, media_type: 'image/png' }
      : null,
    revision
  }
}

databaseTest(
  'a branding block is applied on the full path and the fast path, only when newer',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { bootstrapSnapshot, companyBranding } = realRepositories(database)

    bootstrapSnapshot.persistSnapshot(
      desktopBootstrapFixture({ company_branding: brand(1, '#0e9f8e', true) }),
      '2026-01-01T00:01:00+00:00'
    )
    equal(companyBranding.current(COMPANY_A)?.primaryColor, '#0e9f8e')
    equal(companyBranding.findPendingLogo(COMPANY_A)?.sha256, LOGO)

    // Same catalog (fast path): a newer brand still applies; logo removed with it.
    bootstrapSnapshot.persistSnapshot(
      desktopBootstrapFixture({ company_branding: brand(2, '#2563eb') }),
      '2026-01-01T00:02:00+00:00'
    )
    equal(companyBranding.current(COMPANY_A)?.primaryColor, '#2563eb')
    equal(companyBranding.current(COMPANY_A)?.logoSha256, null)
    equal(companyBranding.findPendingLogo(COMPANY_A), null)

    // Stale and conflicting blocks never change it; an absent block says nothing.
    equal(
      companyBranding.applyBlock(
        COMPANY_A,
        { primaryColor: '#000000', logo: null, revision: 1 },
        'x'
      ),
      'stale'
    )
    equal(
      companyBranding.applyBlock(
        COMPANY_A,
        { primaryColor: '#000000', logo: null, revision: 2 },
        'x'
      ),
      'conflict'
    )
    bootstrapSnapshot.persistSnapshot(desktopBootstrapFixture(), '2026-01-01T00:03:00+00:00')
    equal(companyBranding.current(COMPANY_A)?.primaryColor, '#2563eb')
    closeDatabase(database)
  }
)

databaseTest(
  'verified logo bytes become part of the identity; a wrong length is never stored',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { bootstrapSnapshot, companyBranding } = realRepositories(database)
    bootstrapSnapshot.persistSnapshot(
      desktopBootstrapFixture({ company_branding: brand(1, null, true) }),
      '2026-01-01T00:01:00+00:00'
    )

    equal(companyBranding.markAvailable(COMPANY_A, LOGO, Buffer.alloc(63), 'x'), false)
    ok(companyBranding.markAvailable(COMPANY_A, LOGO, Buffer.alloc(64, 1), 'x'))
    equal(companyBranding.current(COMPANY_A)?.logo?.length, 64)
    closeDatabase(database)
  }
)

databaseTest(
  're-registered to another company with an older catalog: accepted, and nothing of the first company survives',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { bootstrapSnapshot, companyBranding, productImages } = realRepositories(database)
    const first = desktopBootstrapFixture({ company_branding: brand(3, '#0e9f8e', true) })
    bootstrapSnapshot.persistSnapshot(
      {
        ...first,
        catalog_contract: {
          ...first.catalog_contract,
          revision: 'd'.repeat(64),
          generated_at: '2026-01-02T00:00:00+00:00'
        }
      },
      '2026-01-02T00:01:00+00:00'
    )
    productImages.applyFullBlock(
      COMPANY_A,
      [{ productUuid: '55555555-5555-4555-8555-555555555555', revision: 1, image: null }],
      null,
      'x'
    )
    equal(bootstrapSnapshot.getCompany()?.companyUuid, COMPANY_A)

    // The other company's catalog is OLDER than the first company's: before the fix it was refused as
    // CATALOG_SNAPSHOT_OLDER. Its branding is revision 1, lower than the first company's 3.
    const other = desktopBootstrapFixture({
      company: { id: COMPANY_B, name: 'Other Shop', is_active: true },
      company_branding: brand(1, '#e11d48')
    })
    bootstrapSnapshot.persistSnapshot(other, '2026-01-02T00:02:00+00:00')

    equal(bootstrapSnapshot.getCompany()?.companyUuid, COMPANY_B)
    equal(companyBranding.current(COMPANY_A), null)
    equal(companyBranding.current(COMPANY_B)?.primaryColor, '#e11d48')
    deepEqual(database.prepare('SELECT COUNT(*) AS n FROM catalog_product_images').get(), { n: 0 })
    closeDatabase(database)
  }
)
