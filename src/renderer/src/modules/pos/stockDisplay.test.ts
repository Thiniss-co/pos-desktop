import { describe, expect, it } from 'vitest'
import { describeStock, type StockDisplayContext } from './stockDisplay'

const context = (online: boolean, inCartMilli = 0): StockDisplayContext => ({
  online,
  inCartMilli,
  translate: (key: string, params?: Record<string, unknown>) =>
    params ? `${key}(${JSON.stringify(params)})` : key,
  formatQuantity: (value: number) => String(value),
  formatTime: () => '14:05'
})

const allocation = (
  reservedHere: string | null,
  sold = '0.000',
  warehouse: string | null = '50.000'
) =>
  ({
    kind: 'allocation',
    warehouse: { quantity: warehouse, asOf: '2026-09-29T14:05:00Z' },
    soldHereUnderCatalog: sold,
    reservedHere
  }) as const

describe('describeStock (rev 3 separated stock facts)', () => {
  it('labels the warehouse figure as a dated snapshot, never "in stock"', () => {
    const result = describeStock(allocation('0.000'), context(true))
    expect(result.label).toContain('pos.stock.warehouseSnapshot')
    expect(result.detail).toContain('pos.stock.asOf')
    expect(result.blocked).toBe(false)
  })

  it('shows local activity beside the snapshot and never subtracts it', () => {
    const result = describeStock(allocation('2.000', '3.000'), context(true))
    expect(result.label).toContain('"count":"50"')
    expect(result.detail).toContain('pos.stock.soldHere({"count":"3"})')
    expect(result.detail).toContain('pos.stock.reservedHere({"count":"2"})')
  })

  it('gates only offline allocation selling on the exact local spendable allocation', () => {
    expect(describeStock(allocation('0.000'), context(true)).blocked).toBe(false)
    expect(describeStock(allocation('0.000'), context(false)).blocked).toBe(true)
    expect(describeStock(allocation('2.000'), context(false, 1000)).blocked).toBe(false)
    expect(describeStock(allocation('2.000'), context(false, 2000)).blocked).toBe(true)
    // Live finding: a ×10 scan against 9 reserved must be refused at scan time, not at payment.
    expect(
      describeStock(allocation('9.000'), { ...context(false), requestedMilli: 10_000 })
    ).toMatchObject({
      blocked: true,
      blockedReason: 'pos.stock.onlyReservedOffline({"count":"9"})'
    })
    expect(
      describeStock(allocation('9.000'), { ...context(false, 1000), requestedMilli: 8000 }).blocked
    ).toBe(false)
    expect(
      describeStock(allocation('9.000'), { ...context(true), requestedMilli: 10_000 }).blocked
    ).toBe(false)
    // An unknown spendable (no trusted clock) is never turned into a refusal here.
    expect(describeStock(allocation(null), context(false)).blocked).toBe(false)
  })

  it('never tones a product "out of stock" while this till still holds a reservation for it', () => {
    // Live finding: all 7 units were reserved to this till, so the unreserved warehouse figure was
    // 0 and the card was dimmed although it was sellable.
    expect(describeStock(allocation('7.000', '0.000', '0.000'), context(true)).level).toBe(
      'low-stock'
    )
    expect(describeStock(allocation('7.000', '0.000', '0.000'), context(true, 7000)).level).toBe(
      'out-of-stock'
    )
    expect(describeStock(allocation('0.000', '0.000', '0.000'), context(true)).level).toBe(
      'out-of-stock'
    )
  })

  it('never gates physical-presence or untracked products, whatever the snapshot says', () => {
    const pp = {
      kind: 'physical_presence',
      warehouse: { quantity: '-4.000', asOf: '2026-09-29T14:05:00Z' },
      soldHereUnderCatalog: '9.000'
    } as const
    expect(describeStock(pp, context(false)).blocked).toBe(false)
    expect(describeStock({ kind: 'untracked' }, context(false))).toMatchObject({
      blocked: false,
      detail: null
    })
    expect(describeStock(undefined, context(false)).blocked).toBe(false)
  })

  it('states an explicitly unknown warehouse record instead of inventing one', () => {
    expect(describeStock(allocation('1.000', '0.000', null), context(true)).label).toBe(
      'pos.stock.noWarehouseRecord'
    )
  })
})
