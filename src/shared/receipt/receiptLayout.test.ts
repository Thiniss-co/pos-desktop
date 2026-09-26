import { describe, expect, it } from 'vitest'
import {
  HEIGHT_QUANTUM_UM,
  LayoutUnverifiableError,
  decideHeight,
  pack,
  pxToUm,
  roundUpToQuantum,
  type LayoutUnit,
  type PageLengthParams
} from './receiptLayout'

const params: PageLengthParams = {
  marginTopUm: 2_000,
  marginBottomUm: 6_000,
  safetyUm: 1_000,
  continuationHeaderHeightUm: 3_000
}

function unit(id: string, heightUm: number, groupId?: string): LayoutUnit {
  return { id, heightUm, groupId }
}

describe('roundUpToQuantum / pxToUm', () => {
  it('rounds up to the nearest quantum', () => {
    expect(roundUpToQuantum(1)).toBe(HEIGHT_QUANTUM_UM)
    expect(roundUpToQuantum(500)).toBe(500)
    expect(roundUpToQuantum(501)).toBe(1000)
  })

  it('converts px to um using the documented formula', () => {
    expect(pxToUm(96)).toBe(25400) // 1 inch
    expect(pxToUm(1)).toBe(Math.ceil(25400 / 96))
  })
})

describe('pack: single-page cases', () => {
  it('packs everything on one page when it fits', () => {
    const units = [unit('a', 10_000), unit('b', 10_000)]
    const pages = pack(units, 100_000, params)
    expect(pages).toHaveLength(1)
    expect(pages[0]!.unitIds).toEqual(['a', 'b'])
  })

  it('always returns at least one (possibly empty) page for empty input', () => {
    const pages = pack([], 100_000, params)
    expect(pages).toHaveLength(1)
    expect(pages[0]!.unitIds).toEqual([])
  })
})

describe('pack: multi-page and continuation headers', () => {
  it('spills onto a second page when content exceeds the first page usable height', () => {
    // usable on page 1 = pageHeight - margins - safety; usable on page 2+ also subtracts the
    // continuation header.
    const pageHeight = 20_000
    const usable1 = pageHeight - params.marginTopUm - params.marginBottomUm - params.safetyUm // 11_000
    const units = [unit('a', usable1), unit('b', 5_000)]

    const pages = pack(units, pageHeight, params)

    expect(pages).toHaveLength(2)
    expect(pages[0]!.unitIds).toEqual(['a'])
    expect(pages[1]!.unitIds).toEqual(['b'])
  })

  it('keeps a group bundle together across a page break rather than splitting it needlessly', () => {
    const pageHeight = 20_000
    const usable1 = pageHeight - params.marginTopUm - params.marginBottomUm - params.safetyUm // 11_000
    // A settlement bundle that would NOT fit the remainder of page 1 but DOES fit an empty page.
    const filler = unit('filler', usable1 - 2_000)
    const settlementA = unit('settlement-a', 4_000, 'settlement')
    const settlementB = unit('settlement-b', 4_000, 'settlement')

    const pages = pack([filler, settlementA, settlementB], pageHeight, params)

    expect(pages).toHaveLength(2)
    expect(pages[0]!.unitIds).toEqual(['filler'])
    expect(pages[1]!.unitIds).toEqual(['settlement-a', 'settlement-b'])
  })

  it('splits an oversized group into its members when even an empty page cannot hold the whole bundle', () => {
    const pageHeight = 30_000
    const emptyUsablePage2 =
      pageHeight -
      params.marginTopUm -
      params.marginBottomUm -
      params.safetyUm -
      params.continuationHeaderHeightUm // smaller than page 1's, since it must also fit a continuation-page-2 unit
    const big1 = unit('big-1', emptyUsablePage2 - 1_000, 'group')
    const big2 = unit('big-2', emptyUsablePage2 - 1_000, 'group')

    const pages = pack([big1, big2], pageHeight, params)

    // The bundle (big-1 + big-2) is too tall for one empty page, so members are placed
    // individually: big-1 on page 1, big-2 spills to page 2.
    expect(pages.length).toBeGreaterThanOrEqual(2)
    expect(pages.flatMap((p) => p.unitIds)).toEqual(['big-1', 'big-2'])
  })
})

describe('pack: oversized single unit splits into children', () => {
  it('decomposes a unit taller than an empty page into its splitInto children', () => {
    const pageHeight = 20_000 // usable on page 1 is 11_000, so a 16_000 paragraph must split
    const lines = [
      unit('line-1', 4_000),
      unit('line-2', 4_000),
      unit('line-3', 4_000),
      unit('line-4', 4_000)
    ]
    const paragraph: LayoutUnit = { id: 'paragraph', heightUm: 16_000, splitInto: lines }

    const pages = pack([paragraph], pageHeight, params)

    expect(pages.flatMap((p) => p.unitIds)).toEqual(['line-1', 'line-2', 'line-3', 'line-4'])
    expect(pages.length).toBeGreaterThanOrEqual(2)
  })

  it('throws LayoutUnverifiableError for a unit that cannot fit an empty page and has no split (rule 4 guard)', () => {
    const pageHeight = 20_000
    const emptyUsable = pageHeight - params.marginTopUm - params.marginBottomUm - params.safetyUm
    const impossible = unit('impossible', emptyUsable + 1_000)

    expect(() => pack([impossible], pageHeight, params)).toThrow(LayoutUnverifiableError)
  })
})

describe('decideHeight: content_sized mode', () => {
  it('produces exactly one page sized to content when it fits under the limit (property W3)', () => {
    const units = [unit('a', 10_000), unit('b', 5_000)]
    const result = decideHeight(units, { ...params, mode: 'content_sized', limitUm: 1_000_000 })

    expect(result.pageCount).toBe(1)
    const expected = roundUpToQuantum(
      params.marginTopUm + 15_000 + params.safetyUm + params.marginBottomUm
    )
    expect(result.pageHeightUm).toBe(expected)
    // W3: one-page tightness — the page is not padded beyond content + margins + safety by more
    // than one quantum.
    expect(
      result.pageHeightUm - (params.marginTopUm + 15_000 + params.safetyUm + params.marginBottomUm)
    ).toBeLessThan(HEIGHT_QUANTUM_UM)
  })

  it('produces exactly one page when content plus margins/safety lands EXACTLY at the limit', () => {
    // Raw content C such that margins+safety+C is an exact multiple of the quantum and equals the limit.
    const limit = 20_000
    const contentNeeded = limit - params.marginTopUm - params.marginBottomUm - params.safetyUm
    const result = decideHeight([unit('a', contentNeeded)], {
      ...params,
      mode: 'content_sized',
      limitUm: limit
    })

    expect(result.pageCount).toBe(1)
    expect(result.pageHeightUm).toBe(limit)
  })

  it('spills to a second page when raw content fits the limit but content+margins+safety does not', () => {
    // This is the "final physical height, not raw content" boundary case explicitly required by
    // the plan: C alone is <= limit, but C + margins + safety exceeds it. Content is spread across
    // several small flat units (realistic — a receipt is many small rows, not one giant block) so
    // it can actually be repacked across pages without needing a `splitInto`.
    const limit = 15_000
    const rawContent = 11_500 // fits under the raw limit...
    const withMargins = params.marginTopUm + rawContent + params.safetyUm + params.marginBottomUm // ...but this doesn't
    expect(withMargins).toBeGreaterThan(limit)
    const units = Array.from({ length: 23 }, (_, i) => unit(`row-${i}`, 500))

    const result = decideHeight(units, { ...params, mode: 'content_sized', limitUm: limit })

    expect(result.pageCount).toBeGreaterThan(1)
    expect(result.pageHeightUm).toBeLessThanOrEqual(limit)
  })

  it('balances multiple pages and keeps every page height <= the limit (property: P <= L)', () => {
    const units = Array.from({ length: 20 }, (_, i) => unit(`item-${i}`, 3_000))
    const limit = 30_000
    const result = decideHeight(units, { ...params, mode: 'content_sized', limitUm: limit })

    expect(result.pageHeightUm).toBeLessThanOrEqual(limit)
    expect(result.pageCount).toBeGreaterThan(1)
    for (const page of result.pages) {
      expect(page.contentHeightUm).toBeLessThanOrEqual(result.pageHeightUm)
    }
  })

  it('property W2: minimality — one quantum less would need more pages', () => {
    const units = Array.from({ length: 9 }, (_, i) => unit(`item-${i}`, 5_000))
    const limit = 40_000
    const result = decideHeight(units, { ...params, mode: 'content_sized', limitUm: limit })

    if (result.pageHeightUm < limit) {
      const onePageShorter = pack(units, result.pageHeightUm - HEIGHT_QUANTUM_UM, params)
      expect(onePageShorter.length).toBeGreaterThan(result.pageCount)
    } else {
      expect(result.pageHeightUm).toBe(limit)
    }
  })

  it('exactly one grand total unit appears exactly once across all pages', () => {
    const units = [
      ...Array.from({ length: 12 }, (_, i) => unit(`item-${i}`, 3_000)),
      unit('grand-total', 2_000, 'settlement')
    ]
    const limit = 20_000
    const result = decideHeight(units, { ...params, mode: 'content_sized', limitUm: limit })

    const occurrences = result.pages.flatMap((p) => p.unitIds).filter((id) => id === 'grand-total')
    expect(occurrences).toHaveLength(1)
  })
})

describe('decideHeight: fixed_page mode', () => {
  it('packs at exactly the fixed height and reports unused paper on the last page', () => {
    const fixed = 40_000
    const units = [unit('a', 10_000), unit('b', 10_000)]
    const result = decideHeight(units, { ...params, mode: 'fixed_page', limitUm: fixed })

    expect(result.pageHeightUm).toBe(fixed)
    expect(result.pageCount).toBe(1)
    expect(result.unusedLastPageUm).not.toBeNull()
    expect(result.unusedLastPageUm!).toBeGreaterThan(0)
  })
})
