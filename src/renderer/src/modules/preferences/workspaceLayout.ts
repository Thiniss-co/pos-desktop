import type {
  PosCartSectionId,
  PosCartSide,
  PosCatalogSectionId,
  PosCatalogView,
  PosDensity,
  PosWorkspaceLayout,
  PosWorkspacePreset
} from '@shared/contracts/posWorkspace.contract'

/**
 * Turns a saved (requested) workspace layout into what the current window can actually show. Pure:
 * no DOM, no store. The saved layout is never modified — clamping happens here, on every render —
 * so a layout chosen on a large monitor comes back unchanged when the window is large again.
 */

/** Space between the catalog (or rail) and the cart. */
export const WORKSPACE_GAP = 12
/** Width of the collapsed product browser rail. */
export const WORKSPACE_RAIL = 64
/** Below this window width products always collapse to the rail (the cart stays visible). */
export const WORKSPACE_RAIL_BREAKPOINT = 900
/** Below this workspace-body height (≈ a 700px window) the workspace uses its short arrangement. */
export const WORKSPACE_SHORT_BODY_HEIGHT = 580

export const CART_MIN_WIDTH: Readonly<Record<PosDensity, number>> = {
  compact: 400,
  comfortable: 440
}
export const CATALOG_MIN_WIDTH: Readonly<Record<PosCatalogView, number>> = {
  compact: 300,
  cards: 360
}
/** The rail's product browser never grows wider than this and never narrower than the minimum. */
export const RAIL_BROWSER_MAX = 420
export const RAIL_BROWSER_MIN = 240

export interface WorkspaceEnvironment {
  /** Width available to the panels (the workspace body's content box), in CSS px. */
  width: number
  /** Height of the workspace body, in CSS px. */
  height: number
  /** The window's inner width (the breakpoint rule uses the window, not the body). */
  viewportWidth: number
  touchMode: boolean
}

export type CatalogMode = 'panel' | 'rail'
export type RailBrowserMode = 'beside' | 'stacked'

export interface EffectiveWorkspaceLayout {
  preset: PosWorkspacePreset
  cartSide: PosCartSide
  density: PosDensity
  /** Touch mode forces the comfortable density without changing the saved choice. */
  densityForced: boolean
  catalogView: PosCatalogView
  catalogMode: CatalogMode
  /** Why the catalog is a rail: the cashier collapsed it, or the window is too narrow. */
  railReason: 'collapsed' | 'narrow' | null
  /** Applied pixel widths. `catalogWidth` is the rail width in rail mode. */
  cartWidth: number
  catalogWidth: number
  /** Width of the product browser opened from the rail, and where it opens. */
  railBrowserWidth: number
  railBrowserMode: RailBrowserMode
  /** The applied cart share (%), after clamping — what the resize control shows. */
  appliedCartShare: number
  minCartShare: number
  maxCartShare: number
  short: boolean
  sections: { cart: PosCartSectionId[]; catalog: PosCatalogSectionId[] }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function resolveEffectiveLayout(
  layout: PosWorkspaceLayout,
  environment: WorkspaceEnvironment
): EffectiveWorkspaceLayout {
  const width = Math.max(0, Math.floor(environment.width))
  const density: PosDensity = environment.touchMode ? 'comfortable' : layout.density
  const densityForced = environment.touchMode && layout.density !== 'comfortable'
  const cartMin = Math.min(CART_MIN_WIDTH[density], width)
  const catalogMin = CATALOG_MIN_WIDTH[layout.catalogView]
  const panelsFit = width >= cartMin + catalogMin + WORKSPACE_GAP
  const narrowWindow = environment.viewportWidth < WORKSPACE_RAIL_BREAKPOINT

  let catalogMode: CatalogMode = 'panel'
  let railReason: EffectiveWorkspaceLayout['railReason'] = null

  if (layout.catalogCollapsed) {
    catalogMode = 'rail'
    railReason = 'collapsed'
  } else if (narrowWindow || !panelsFit) {
    catalogMode = 'rail'
    railReason = 'narrow'
  }

  const share = (px: number): number => (width > 0 ? Math.round((px / width) * 100) : 0)

  let cartWidth: number
  let catalogWidth: number
  let minCartShare: number
  let maxCartShare: number

  if (catalogMode === 'rail') {
    catalogWidth = WORKSPACE_RAIL
    cartWidth = Math.max(0, width - WORKSPACE_RAIL - WORKSPACE_GAP)
    minCartShare = share(cartWidth)
    maxCartShare = minCartShare
  } else {
    const maxCart = width - catalogMin - WORKSPACE_GAP
    cartWidth = clamp(Math.round((width * layout.cartShare) / 100), cartMin, maxCart)
    catalogWidth = width - cartWidth - WORKSPACE_GAP
    minCartShare = share(cartMin)
    maxCartShare = share(maxCart)
  }

  // The browser opened from the rail keeps the cart's minimum (scanner, lines and footer stay in view).
  const besideRoom = width - WORKSPACE_RAIL - WORKSPACE_GAP * 2 - cartMin
  const railBrowserMode: RailBrowserMode = besideRoom >= RAIL_BROWSER_MIN ? 'beside' : 'stacked'
  const railBrowserWidth =
    railBrowserMode === 'beside'
      ? Math.min(RAIL_BROWSER_MAX, besideRoom)
      : Math.max(0, width - WORKSPACE_RAIL - WORKSPACE_GAP)

  return {
    preset: layout.preset,
    cartSide: layout.cartSide,
    density,
    densityForced,
    catalogView: layout.catalogView,
    catalogMode,
    railReason,
    cartWidth,
    catalogWidth,
    railBrowserWidth,
    railBrowserMode,
    appliedCartShare: share(cartWidth),
    minCartShare,
    maxCartShare,
    short: environment.height > 0 && environment.height < WORKSPACE_SHORT_BODY_HEIGHT,
    sections: { cart: [...layout.sections.cart], catalog: [...layout.sections.catalog] }
  }
}

/** Moves one section up (-1) or down (+1) if the resulting order is supported; otherwise unchanged. */
export function moveSection<T extends string>(
  order: readonly T[],
  id: T,
  direction: -1 | 1,
  isSupported: (order: readonly string[]) => boolean
): T[] {
  const index = order.indexOf(id)
  const target = index + direction

  if (index < 0 || target < 0 || target >= order.length) {
    return [...order]
  }

  const next = [...order]
  ;[next[index], next[target]] = [next[target], next[index]]
  return isSupported(next) ? next : [...order]
}

/** Whether a section can move in a direction (drives the disabled state of Move up / Move down). */
export function canMoveSection<T extends string>(
  order: readonly T[],
  id: T,
  direction: -1 | 1,
  isSupported: (order: readonly string[]) => boolean
): boolean {
  const moved = moveSection(order, id, direction, isSupported)
  return moved.some((value, index) => value !== order[index])
}
