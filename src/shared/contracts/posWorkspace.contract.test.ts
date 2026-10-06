import { describe, expect, it } from 'vitest'
import {
  POS_WORKSPACE_PRESETS,
  clonePreset,
  defaultWorkspaceLayout,
  isSupportedCartOrder,
  isSupportedCatalogOrder,
  normalizeWorkspaceLayout,
  parseStoredWorkspaceLayout,
  posWorkspaceLayoutSchema,
  setPosWorkspaceInputSchema
} from './posWorkspace.contract'

describe('POS workspace layout contract', () => {
  it('ships three valid presets with Cart first as the default', () => {
    for (const preset of Object.values(POS_WORKSPACE_PRESETS)) {
      expect(posWorkspaceLayoutSchema.safeParse(preset).success).toBe(true)
    }
    expect(defaultWorkspaceLayout()).toEqual(POS_WORKSPACE_PRESETS.cartFirst)
    expect(POS_WORKSPACE_PRESETS.scanner.catalogCollapsed).toBe(true)
    expect(POS_WORKSPACE_PRESETS.cartFirst.cartShare).toBeGreaterThan(
      POS_WORKSPACE_PRESETS.balanced.cartShare
    )
  })

  it('returns independent copies of presets', () => {
    const copy = clonePreset('cartFirst')
    copy.sections.cart.reverse()
    expect(POS_WORKSPACE_PRESETS.cartFirst.sections.cart[0]).toBe('actions')
  })

  it('accepts only supported section orders', () => {
    expect(isSupportedCartOrder(['actions', 'scan', 'lines', 'totals'])).toBe(true)
    expect(isSupportedCartOrder(['scan', 'actions', 'lines', 'totals'])).toBe(true)
    expect(isSupportedCartOrder(['scan', 'lines', 'actions', 'totals'])).toBe(true)
    // Totals (with Pay) must stay last; the scan entry must come before the lines.
    expect(isSupportedCartOrder(['actions', 'scan', 'totals', 'lines'])).toBe(false)
    expect(isSupportedCartOrder(['lines', 'scan', 'actions', 'totals'])).toBe(false)
    expect(isSupportedCartOrder(['actions', 'actions', 'lines', 'totals'])).toBe(false)
    expect(isSupportedCartOrder(['actions', 'scan', 'lines'])).toBe(false)
    expect(isSupportedCatalogOrder(['search', 'categories', 'products'])).toBe(true)
    expect(isSupportedCatalogOrder(['products', 'search', 'categories'])).toBe(false)
  })

  it('rejects unknown keys, ids, bounds and versions on write', () => {
    const base = defaultWorkspaceLayout()
    const invalid = [
      { ...base, cart: [] },
      { ...base, cartShare: 34 },
      { ...base, cartShare: 86 },
      { ...base, cartShare: 50.5 },
      { ...base, density: 'tiny' },
      { ...base, version: 2 },
      { ...base, sections: { ...base.sections, cart: ['actions', 'scan', 'lines', 'payment'] } },
      { ...base, sections: { ...base.sections, extra: [] } }
    ]
    for (const value of invalid) {
      expect(posWorkspaceLayoutSchema.safeParse(value).success).toBe(false)
    }
    expect(
      setPosWorkspaceInputSchema.safeParse({ layout: base, contextToken: 't', userUuid: 'u' })
        .success
    ).toBe(false)
    expect(setPosWorkspaceInputSchema.safeParse({ layout: null, contextToken: 't' }).success).toBe(
      true
    )
    expect(setPosWorkspaceInputSchema.safeParse({ layout: base, contextToken: '' }).success).toBe(
      false
    )
  })

  it('salvages valid version-1 fields and defaults the rest', () => {
    const salvaged = normalizeWorkspaceLayout({
      version: 1,
      preset: 'balanced',
      cartSide: 'sideways',
      cartShare: 999,
      density: 'comfortable',
      catalogView: 'cards',
      catalogCollapsed: 'yes',
      sections: {
        cart: ['totals', 'scan', 'lines', 'actions'],
        catalog: ['search', 'categories', 'products']
      },
      cartLines: [{ sku: 'X' }]
    })
    expect(salvaged).toEqual({
      ...defaultWorkspaceLayout(),
      preset: 'balanced',
      density: 'comfortable',
      catalogView: 'cards',
      sections: {
        cart: ['actions', 'scan', 'lines', 'totals'],
        catalog: ['search', 'categories', 'products']
      }
    })
    expect(salvaged).not.toHaveProperty('cartLines')
  })

  it('uses the default for malformed JSON, unknown and future versions', () => {
    expect(parseStoredWorkspaceLayout('{not json')).toEqual(defaultWorkspaceLayout())
    expect(parseStoredWorkspaceLayout(null)).toEqual(defaultWorkspaceLayout())
    expect(normalizeWorkspaceLayout({ ...POS_WORKSPACE_PRESETS.balanced, version: 2 })).toEqual(
      defaultWorkspaceLayout()
    )
    expect(normalizeWorkspaceLayout([1, 2])).toEqual(defaultWorkspaceLayout())
    expect(normalizeWorkspaceLayout('cartFirst')).toEqual(defaultWorkspaceLayout())
    expect(parseStoredWorkspaceLayout(JSON.stringify(POS_WORKSPACE_PRESETS.scanner))).toEqual(
      POS_WORKSPACE_PRESETS.scanner
    )
  })
})
