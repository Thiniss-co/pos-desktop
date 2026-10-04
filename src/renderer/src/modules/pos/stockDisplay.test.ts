import { describe, expect, it } from 'vitest'
import { describeStock, type StockDisplayContext } from './stockDisplay'

const context = (online: boolean): StockDisplayContext => ({
  online,
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
  })

  it('shows local activity beside the snapshot and never subtracts it', () => {
    const result = describeStock(allocation('2.000', '3.000'), context(true))
    expect(result.label).toContain('"count":"50"')
    expect(result.detail).toContain('pos.stock.soldHere({"count":"3"})')
    expect(result.detail).toContain('pos.stock.reservedHere({"count":"2"})')
  })

  it('never gates a sale on stock: offline with nothing reserved still offers the product', () => {
    // Reported on a real till: offline, tracked cards were disabled "not reserved on this till".
    // Reservations are shown as a fact; they are never a refusal rule here (main decides at commit).
    const offlineNothingReserved = describeStock(allocation('0.000'), context(false))
    expect(offlineNothingReserved).not.toHaveProperty('blocked')
    expect(offlineNothingReserved).not.toHaveProperty('blockedReason')
    expect(offlineNothingReserved.level).toBe('in-stock')
    expect(offlineNothingReserved.detail).toContain('pos.stock.reservedHere({"count":"0"})')
    // An unknown spendable (no trusted clock) is shown as nothing at all.
    expect(describeStock(allocation(null), context(false)).detail).not.toContain('reservedHere')
  })

  it('never tones a product by its warehouse figure alone (Rev 4 §4.3)', () => {
    // G0 A5: a zero figure dimmed the card although it was sellable. Zero, negative and missing
    // figures are now the neutral `recorded` tone online, in every mode.
    for (const figure of ['0.000', '-3.000', null]) {
      for (const online of [true, false]) {
        expect(describeStock(allocation('0.000', '0.000', figure), context(online)).level).toBe(
          'recorded'
        )
      }
    }
    expect(describeStock(allocation('7.000', '0.000', '0.000'), context(true)).level).toBe(
      'recorded'
    )
    expect(describeStock(allocation('0.000', '0.000', '3.000'), context(true)).level).toBe(
      'low-stock'
    )
    expect(describeStock(allocation('0.000'), context(true)).level).toBe('in-stock')
    // No red tone is produced from stock at all any more.
    expect(describeStock(allocation('0.000', '0.000', '50.000'), context(false)).level).toBe(
      'in-stock'
    )
  })

  it('shows physical presence as neutral recorded facts, never a shortage', () => {
    const pp = (quantity: string | null) =>
      ({
        kind: 'physical_presence',
        warehouse: { quantity, asOf: '2026-09-29T14:05:00Z' },
        soldHereUnderCatalog: '3.000'
      }) as const
    for (const [figure, label] of [
      ['0.000', 'pos.stock.recorded({"count":"0"})'],
      ['-4.000', 'pos.stock.recorded({"count":"\u2066-4\u2069"})'],
      ['120.000', 'pos.stock.recorded({"count":"120"})'],
      [null, 'pos.stock.noStockRecordYet']
    ] as const) {
      expect(describeStock(pp(figure), context(false))).toMatchObject({
        level: 'recorded',
        label
      })
    }
    expect(describeStock(pp('0.000'), context(false)).detail).toBe(
      'pos.stock.asOf({"time":"14:05"}) · pos.stock.soldHere({"count":"3"})'
    )
  })

  it('never gates physical-presence or untracked products, whatever the snapshot says', () => {
    const pp = {
      kind: 'physical_presence',
      warehouse: { quantity: '-4.000', asOf: '2026-09-29T14:05:00Z' },
      soldHereUnderCatalog: '9.000'
    } as const
    expect(describeStock(pp, context(false)).level).toBe('recorded')
    expect(describeStock({ kind: 'untracked' }, context(false))).toMatchObject({
      level: 'in-stock',
      detail: null
    })
    expect(describeStock(undefined, context(false)).label).toBe('pos.stock.notTracked')
  })

  it('states an explicitly unknown warehouse record instead of inventing one', () => {
    expect(describeStock(allocation('1.000', '0.000', null), context(true)).label).toBe(
      'pos.stock.noWarehouseRecord'
    )
  })
})
