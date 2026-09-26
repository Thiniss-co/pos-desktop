/**
 * Receipt-printing plan §D-4 — the pure pagination packer and height decision. Pure and
 * side-effect-free so it is exhaustively unit-testable without Electron: `receiptRenderer.ts`
 * (main-process only) measures real DOM heights and feeds them in here as `LayoutUnit[]`.
 *
 * All lengths are integer MICROMETRES (µm). A CSS px converts as `ceil(px * 25400 / 96)`.
 */

export const HEIGHT_QUANTUM_UM = 500

export function roundUpToQuantum(um: number, quantum: number = HEIGHT_QUANTUM_UM): number {
  return Math.ceil(um / quantum) * quantum
}

export function pxToUm(px: number): number {
  return Math.ceil((px * 25400) / 96)
}

/**
 * One atomic layout unit. `groupId` marks units that must be packed together when they fit an
 * empty continuation page (plan §D-4 rule 2) — the settlement's totals subgroup and each item
 * block are the intended uses. A unit with no `groupId` packs independently. `splitInto`, when
 * present, is the ordered list of child units this unit decomposes into when it does not fit even
 * an empty page (rule 3) — e.g. a product-name paragraph decomposed into measured line units. A
 * unit with no `splitInto` and that still does not fit an empty page is the unreachable case (rule
 * 4); the caller (receiptRenderer.ts) is expected to always supply line-level `splitInto` for any
 * unit whose height could plausibly exceed a page.
 */
export interface LayoutUnit {
  readonly id: string
  readonly heightUm: number
  readonly groupId?: string
  readonly isContinuationHeader?: boolean
  readonly splitInto?: readonly LayoutUnit[]
}

export interface PageLengthParams {
  readonly marginTopUm: number
  readonly marginBottomUm: number
  readonly safetyUm: number
  readonly continuationHeaderHeightUm: number
}

export interface PackedPage {
  readonly unitIds: readonly string[]
  readonly contentHeightUm: number
}

export class LayoutUnverifiableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LayoutUnverifiableError'
  }
}

function usableHeight(pageIndex: number, pageHeightUm: number, params: PageLengthParams): number {
  const base = pageHeightUm - params.marginTopUm - params.marginBottomUm - params.safetyUm
  return pageIndex === 0 ? base : base - params.continuationHeaderHeightUm
}

/**
 * Greedy, deterministic packing into pages of (at most) `pageHeightUm` usable content height.
 * Rules 1-5 of plan §D-4. Throws `LayoutUnverifiableError` only for the unreachable case (rule 4):
 * an atomic unit (no further `splitInto`) that does not fit even an empty continuation page.
 */
export function pack(
  units: readonly LayoutUnit[],
  pageHeightUm: number,
  params: PageLengthParams
): PackedPage[] {
  // Expand groups into flat placement candidates: a group is offered as one bundle first; if it
  // doesn't fit an empty page, its members are offered individually (rule 3 applied at the group
  // level before the per-unit level).
  const bundles = bundleByGroup(units)

  const pages: PackedPage[] = []
  let current: { ids: string[]; height: number } = { ids: [], height: 0 }
  let pageIndex = 0

  const pushCurrent = (): void => {
    pages.push({ unitIds: current.ids, contentHeightUm: current.height })
    pageIndex += 1
    current = { ids: [], height: 0 }
  }

  const placeFlatUnit = (unit: LayoutUnit): void => {
    const usable = usableHeight(pageIndex, pageHeightUm, params)

    if (current.height + unit.heightUm <= usable) {
      current.ids.push(unit.id)
      current.height += unit.heightUm
      return
    }

    // Rule 2: doesn't fit the remainder of this page — try an empty continuation page.
    if (current.ids.length > 0) {
      pushCurrent()
    }

    const emptyUsable = usableHeight(pageIndex, pageHeightUm, params)

    if (unit.heightUm <= emptyUsable) {
      current.ids.push(unit.id)
      current.height += unit.heightUm
      return
    }

    // Rule 3: doesn't fit even an empty page — split into children and retry each.
    if (unit.splitInto && unit.splitInto.length > 0) {
      for (const child of unit.splitInto) {
        placeFlatUnit(child)
      }
      return
    }

    // Rule 4: unreachable in practice (receiptRenderer always supplies line-level splits for any
    // unit that could exceed a page) — treated as a hard verification failure, never silently
    // clipped or overflowed.
    throw new LayoutUnverifiableError(
      `Layout unit "${unit.id}" (${unit.heightUm}µm) does not fit an empty page (${emptyUsable}µm usable) and has no further split.`
    )
  }

  const placeBundle = (bundle: readonly LayoutUnit[]): void => {
    const usable = usableHeight(pageIndex, pageHeightUm, params)
    const bundleHeight = bundle.reduce((sum, u) => sum + u.heightUm, 0)

    if (current.height + bundleHeight <= usable) {
      for (const unit of bundle) {
        current.ids.push(unit.id)
      }
      current.height += bundleHeight
      return
    }

    if (current.ids.length > 0) {
      pushCurrent()
    }

    const emptyUsable = usableHeight(pageIndex, pageHeightUm, params)

    if (bundleHeight <= emptyUsable) {
      for (const unit of bundle) {
        current.ids.push(unit.id)
      }
      current.height += bundleHeight
      return
    }

    // The whole group doesn't fit even an empty page: fall back to placing its members
    // individually (each may itself split further via placeFlatUnit).
    for (const unit of bundle) {
      placeFlatUnit(unit)
    }
  }

  for (const bundle of bundles) {
    if (bundle.length === 1) {
      placeFlatUnit(bundle[0]!)
    } else {
      placeBundle(bundle)
    }
  }

  if (current.ids.length > 0 || pages.length === 0) {
    pushCurrent()
  }

  return pages
}

function bundleByGroup(units: readonly LayoutUnit[]): LayoutUnit[][] {
  const bundles: LayoutUnit[][] = []
  let openGroup: string | undefined
  let openBundle: LayoutUnit[] = []

  for (const unit of units) {
    if (unit.groupId !== undefined && unit.groupId === openGroup) {
      openBundle.push(unit)
      continue
    }

    if (openBundle.length > 0) {
      bundles.push(openBundle)
    }

    if (unit.groupId !== undefined) {
      openGroup = unit.groupId
      openBundle = [unit]
    } else {
      openGroup = undefined
      openBundle = []
      bundles.push([unit])
    }
  }

  if (openBundle.length > 0) {
    bundles.push(openBundle)
  }

  return bundles
}

export interface HeightDecisionParams extends PageLengthParams {
  readonly mode: 'content_sized' | 'fixed_page'
  /** `content_sized`: the configured maxContinuousLengthMm limit, in µm. `fixed_page`: the fixed page height, in µm. */
  readonly limitUm: number
}

export interface HeightDecisionResult {
  readonly pages: PackedPage[]
  readonly pageHeightUm: number
  readonly pageCount: number
  readonly unusedLastPageUm: number | null
}

function totalContentHeight(units: readonly LayoutUnit[]): number {
  return units.reduce((sum, u) => sum + u.heightUm, 0)
}

/**
 * The height decision (plan §D-4 "Height decision"). `fixed_page` mode packs at exactly `limitUm`
 * and reports the last page's unused paper. `content_sized` mode finds the smallest page height
 * `P <= limitUm` that still packs into the minimum page count `N* = |pack(limitUm)|` (properties
 * W1-W3 — see `receiptLayout.test.ts`).
 */
export function decideHeight(
  units: readonly LayoutUnit[],
  params: HeightDecisionParams
): HeightDecisionResult {
  if (params.mode === 'fixed_page') {
    const pages = pack(units, params.limitUm, params)
    const last = pages[pages.length - 1]!
    const usableLast = usableHeight(pages.length - 1, params.limitUm, params)

    return {
      pages,
      pageHeightUm: params.limitUm,
      pageCount: pages.length,
      unusedLastPageUm: usableLast - last.contentHeightUm
    }
  }

  const C = totalContentHeight(units)
  const onePage = roundUpToQuantum(params.marginTopUm + C + params.safetyUm + params.marginBottomUm)

  if (onePage <= params.limitUm) {
    return {
      pages: pack(units, onePage, params),
      pageHeightUm: onePage,
      pageCount: 1,
      unusedLastPageUm: 0
    }
  }

  const nStar = pack(units, params.limitUm, params).length
  const perPageContent = Math.ceil((C + (nStar - 1) * params.continuationHeaderHeightUm) / nStar)
  let candidate = roundUpToQuantum(
    params.marginTopUm + params.marginBottomUm + params.safetyUm + perPageContent
  )

  // Scan upward from the theoretical minimum to the first height that still packs into N* pages
  // (property W2: minimality). This always terminates because `limitUm` itself packs into <= N*
  // pages by definition of N*.
  while (candidate < params.limitUm) {
    const pageCount = pack(units, candidate, params).length

    if (pageCount <= nStar) {
      break
    }

    candidate += HEIGHT_QUANTUM_UM
  }

  if (candidate > params.limitUm) {
    candidate = params.limitUm
  }

  const pages = pack(units, candidate, params)

  return {
    pages,
    pageHeightUm: candidate,
    pageCount: pages.length,
    unusedLastPageUm: null
  }
}
