import { describe, expect, it } from 'vitest'
import {
  clonePreset,
  defaultWorkspaceLayout,
  isSupportedCartOrder,
  type PosWorkspaceLayout
} from '@shared/contracts/posWorkspace.contract'
import {
  CART_MIN_WIDTH,
  WORKSPACE_GAP,
  WORKSPACE_RAIL,
  canMoveSection,
  moveSection,
  resolveEffectiveLayout
} from './workspaceLayout'

/** Workspace body width for a window: 12px padding each side (the shell's body padding). */
const env = (
  viewportWidth: number,
  height = 900,
  touchMode = false
): { width: number; height: number; viewportWidth: number; touchMode: boolean } => ({
  width: viewportWidth - 24,
  height,
  viewportWidth,
  touchMode
})

describe('resolveEffectiveLayout', () => {
  it('gives Cart first a wide cart and a compact catalog at 1920', () => {
    const effective = resolveEffectiveLayout(defaultWorkspaceLayout(), env(1920))
    expect(effective.catalogMode).toBe('panel')
    expect(effective.cartWidth).toBe(Math.round(1896 * 0.64))
    expect(effective.cartWidth + effective.catalogWidth + WORKSPACE_GAP).toBe(1896)
    expect(effective.density).toBe('compact')
  })

  it('never lets the cart go below its minimum or the catalog below its own', () => {
    const balanced = clonePreset('balanced')
    const at1024 = resolveEffectiveLayout({ ...balanced, cartShare: 35 }, env(1024))
    expect(at1024.cartWidth).toBeGreaterThanOrEqual(CART_MIN_WIDTH.compact)
    expect(at1024.catalogWidth).toBeGreaterThanOrEqual(360)
    const wide = resolveEffectiveLayout({ ...balanced, cartShare: 85 }, env(1024))
    expect(wide.catalogWidth).toBeGreaterThanOrEqual(360)
  })

  it('collapses products to the rail below 900px and when collapsed', () => {
    const narrow = resolveEffectiveLayout(defaultWorkspaceLayout(), env(800, 516))
    expect(narrow.catalogMode).toBe('rail')
    expect(narrow.railReason).toBe('narrow')
    expect(narrow.catalogWidth).toBe(WORKSPACE_RAIL)
    expect(narrow.cartWidth).toBe(776 - WORKSPACE_RAIL - WORKSPACE_GAP)
    expect(narrow.short).toBe(true)
    const scanner = resolveEffectiveLayout(clonePreset('scanner'), env(1920))
    expect(scanner.catalogMode).toBe('rail')
    expect(scanner.railReason).toBe('collapsed')
  })

  it('opens the rail browser beside a minimum-width cart, or stacked when it cannot fit', () => {
    const at800 = resolveEffectiveLayout(defaultWorkspaceLayout(), env(800))
    expect(at800.railBrowserMode).toBe('beside')
    expect(at800.railBrowserWidth).toBe(
      776 - WORKSPACE_RAIL - 2 * WORKSPACE_GAP - CART_MIN_WIDTH.compact
    )
    const touch800 = resolveEffectiveLayout(defaultWorkspaceLayout(), env(800, 516, true))
    expect(touch800.railBrowserMode).toBe('beside')
    expect(touch800.railBrowserWidth).toBeGreaterThanOrEqual(240)
    const tiny = resolveEffectiveLayout(defaultWorkspaceLayout(), env(640))
    expect(tiny.railBrowserMode).toBe('stacked')
  })

  it('forces the comfortable density in touch mode without changing the saved layout', () => {
    const saved = defaultWorkspaceLayout()
    const effective = resolveEffectiveLayout(saved, env(1920, 900, true))
    expect(effective.density).toBe('comfortable')
    expect(effective.densityForced).toBe(true)
    expect(saved.density).toBe('compact')
    expect(effective.cartWidth).toBeGreaterThanOrEqual(CART_MIN_WIDTH.comfortable)
  })

  it('recovers the requested size when the window grows again', () => {
    const saved: PosWorkspaceLayout = { ...clonePreset('balanced'), cartShare: 70 }
    const small = resolveEffectiveLayout(saved, env(1024))
    const large = resolveEffectiveLayout(saved, env(1920))
    expect(small.appliedCartShare).toBeLessThan(70)
    expect(large.appliedCartShare).toBe(70)
    expect(saved.cartShare).toBe(70)
  })

  it('keeps the cart side and section order as requested', () => {
    const layout: PosWorkspaceLayout = {
      ...defaultWorkspaceLayout(),
      cartSide: 'start',
      sections: {
        cart: ['scan', 'lines', 'actions', 'totals'],
        catalog: ['search', 'categories', 'products']
      }
    }
    const effective = resolveEffectiveLayout(layout, env(1366))
    expect(effective.cartSide).toBe('start')
    expect(effective.sections.cart).toEqual(['scan', 'lines', 'actions', 'totals'])
  })
})

describe('moveSection', () => {
  it('moves only into supported orders', () => {
    const order = ['actions', 'scan', 'lines', 'totals'] as const
    expect(moveSection(order, 'actions', 1, isSupportedCartOrder)).toEqual([
      'scan',
      'actions',
      'lines',
      'totals'
    ])
    // Totals can never move, and the scan entry can never go below the lines.
    expect(canMoveSection(order, 'totals', -1, isSupportedCartOrder)).toBe(false)
    expect(
      canMoveSection(['scan', 'actions', 'lines', 'totals'], 'scan', 1, isSupportedCartOrder)
    ).toBe(true)
    expect(
      canMoveSection(['actions', 'scan', 'lines', 'totals'], 'scan', 1, isSupportedCartOrder)
    ).toBe(false)
    expect(moveSection(order, 'actions', -1, isSupportedCartOrder)).toEqual([...order])
  })
})
