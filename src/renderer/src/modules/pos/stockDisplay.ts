import type { ProductStockView } from '@shared/contracts/catalog.contract'
import type { StockLevel } from '@renderer/shared/components/pos/types'

export interface StockDisplay {
  readonly level: StockLevel
  readonly label: string
  readonly detail: string | null
}

export interface StockDisplayContext {
  /** Main-reported connectivity is `online`; offline, "Reserved here" is shown even at zero. */
  readonly online: boolean
  readonly translate: (key: string, params?: Record<string, unknown>) => string
  readonly formatQuantity: (value: number) => string
  readonly formatTime: (iso: string) => string
}

function toMilli(value: string): number {
  const match = /^(-?)(\d+)(?:\.(\d{1,3}))?$/.exec(value)
  if (!match) {
    return 0
  }
  const milli = Number(match[2]) * 1000 + Number((match[3] ?? '').padEnd(3, '0'))
  return match[1] === '-' ? -milli : milli
}

/**
 * A negative figure keeps its minus sign on the left in RTL text ("-10", never "10-"): the number
 * is wrapped in a left-to-right isolate, which is invisible and changes nothing in LTR text.
 */
function signedCount(milli: number, format: (value: number) => string): string {
  const text = format(milli / 1000)
  return milli < 0 ? `\u2066${text}\u2069` : text
}

/**
 * POS reliability rev 3 (Area 1) — pure presentation of the separated stock facts.
 *
 * - The warehouse figure is a dated snapshot ("as of"), never adjusted and never "in stock".
 * - "Sold here" and "Reserved here" are exact local facts, shown beside it, never subtracted.
 * - Stock is information only: nothing here disables, dims or refuses a product, online or
 *   offline, in any mode. Whether a sale may complete is decided once, by main, at commit.
 * - Rev 4 §4.3: a warehouse quantity never dims, disables or turns a product red, in any mode. A
 *   zero, negative or missing figure is the neutral `recorded` tone; physical presence is always
 *   neutral ("Recorded 0 · Sold here 3 · as of 10:42", or "No stock record yet").
 */
export function describeStock(
  view: ProductStockView | undefined,
  context: StockDisplayContext
): StockDisplay {
  const { translate: t } = context
  if (!view || view.kind === 'untracked') {
    return {
      level: 'in-stock',
      label: t('pos.stock.notTracked'),
      detail: null
    }
  }

  const warehouseMilli = view.warehouse.quantity === null ? null : toMilli(view.warehouse.quantity)
  const physicalPresence = view.kind === 'physical_presence'
  const tone: StockLevel =
    physicalPresence || warehouseMilli === null || warehouseMilli <= 0
      ? 'recorded'
      : warehouseMilli <= 5000
        ? 'low-stock'
        : 'in-stock'
  const label = physicalPresence
    ? warehouseMilli === null
      ? t('pos.stock.noStockRecordYet')
      : t('pos.stock.recorded', { count: signedCount(warehouseMilli, context.formatQuantity) })
    : warehouseMilli === null
      ? t('pos.stock.noWarehouseRecord')
      : t('pos.stock.warehouseSnapshot', {
          count: signedCount(warehouseMilli, context.formatQuantity)
        })

  const details = [t('pos.stock.asOf', { time: context.formatTime(view.warehouse.asOf) })]
  const soldMilli = toMilli(view.soldHereUnderCatalog)
  if (soldMilli > 0) {
    details.push(t('pos.stock.soldHere', { count: context.formatQuantity(soldMilli / 1000) }))
  }

  if (view.kind === 'allocation' && view.reservedHere !== null) {
    const reservedMilli = toMilli(view.reservedHere)
    if (reservedMilli > 0 || !context.online) {
      details.push(
        t('pos.stock.reservedHere', { count: context.formatQuantity(reservedMilli / 1000) })
      )
    }
  }

  return { level: tone, label, detail: details.join(' · ') }
}
