import { describe, expect, it } from 'vitest'
import vectors from './brand-contrast-vectors.json'
import {
  brandDeclarations,
  contrast,
  deriveDesktopBrandTokens,
  luminance,
  onColor,
  THEME_DEFAULTS,
  THEME_SURFACES
} from './brandTokens'

describe('desktop brand tokens (P9)', () => {
  it('match the owner portal and backend luminance and readable-text choice (shared vectors)', () => {
    for (const vector of vectors) {
      expect(Math.round(luminance(vector.color) * 10_000) / 10_000).toBe(vector.luminance)
      expect(onColor(vector.color)).toBe(vector.on)
    }
  })

  it('keep every token readable where it is drawn, in both themes, for any colour', () => {
    for (const color of [
      '#6a58f2',
      '#0e9f8e',
      '#ffff00',
      '#000080',
      '#777777',
      '#e11d48',
      '#111111',
      '#fafafa'
    ]) {
      for (const theme of ['light', 'dark'] as const) {
        const tokens = deriveDesktopBrandTokens(color, theme)
        const { surf, page } = THEME_SURFACES[theme]
        expect(contrast(tokens.onPri, tokens.pri)).toBeGreaterThanOrEqual(4.5)
        // Selected outlines and indicators are drawn with `pri` on the surface.
        expect(contrast(tokens.pri, surf)).toBeGreaterThanOrEqual(3)
        expect(contrast(tokens.onPri, tokens.priHover)).toBeGreaterThanOrEqual(4.5)
        expect(contrast(tokens.onPri, tokens.priPress)).toBeGreaterThanOrEqual(4.5)
        for (const background of [surf, page, tokens.priSoft]) {
          expect(contrast(tokens.priText, background)).toBeGreaterThanOrEqual(4.5)
        }
        expect(contrast(tokens.focus, surf)).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('falls back to the theme default only when no lightness reaches the threshold, and emits light-dark pairs', () => {
    expect(deriveDesktopBrandTokens('#0e9f8e', 'light').fallbacks).toEqual([])
    for (const theme of ['light', 'dark'] as const) {
      expect(
        contrast(THEME_DEFAULTS[theme].priText, THEME_SURFACES[theme].surf)
      ).toBeGreaterThanOrEqual(4.5)
    }
    expect(brandDeclarations('#0e9f8e')['--color-pri']).toBe('light-dark(#0e9f8e, #0e9f8e)')
    // A near-white brand keeps its hue but is darkened on the light surface; the dark theme keeps it.
    const yellow = brandDeclarations('#ffff00')['--color-pri']
    expect(yellow).toMatch(/^light-dark\(#[0-9a-f]{6}, #ffff00\)$/)
    expect(yellow).not.toBe('light-dark(#ffff00, #ffff00)')
  })
})
