import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

// Source-text check, following the repo's existing convention for proving a security/scope
// boundary without needing a full production build inside the unit-test suite (see
// posApiSurface.test.ts). The actual production-exclusion PROOF — that the gallery, its fixtures,
// and every shared/components/pos/* component contribute zero bytes to the built bundle — was
// verified by running `npm run build` and grepping out/renderer/assets/*.{js,css} for
// gallery-only strings in the same session that added this route; see the final report.
const source = readFileSync(new URL('./routes.ts', import.meta.url), 'utf8')

describe('dev gallery route stays out of production', () => {
  it('gates the dev-gallery route behind import.meta.env.DEV', () => {
    const galleryLineIndex = source.indexOf("path: '/__dev/gallery'")
    expect(galleryLineIndex).toBeGreaterThan(-1)

    const guardIndex = source.indexOf('import.meta.env.DEV')
    expect(guardIndex).toBeGreaterThan(-1)
    expect(guardIndex).toBeLessThan(galleryLineIndex)
  })

  it('lazy-loads the gallery page via a dynamic import, not a static one', () => {
    expect(source).not.toContain("import DevGalleryPage from '@renderer/modules/devGallery")
    expect(source).toContain(
      "() => import('@renderer/modules/devGallery/pages/DevGalleryPage.vue')"
    )
  })

  it('marks the route devOnly so startupGuard bypasses it explicitly rather than by omission', () => {
    const galleryBlock = source.slice(source.indexOf("path: '/__dev/gallery'"))
    expect(galleryBlock.slice(0, 300)).toContain('devOnly: true')
  })
})
