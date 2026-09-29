import type { ProductStockView } from '@shared/contracts/catalog.contract'
import type { StockLevel } from '@renderer/shared/components/pos/types'

export interface StockDisplay {
  readonly level: StockLevel
  readonly label: string
  readonly detail: string | null
  /** True only when proven local spendability cannot cover another unit (offline allocation). */
  readonly blocked: boolean
  readonly blockedReason: string | null
}

export interface StockDisplayContext {
  /** Main-reported connectivity is `online` (checkout can request a reservation). */
  readonly online: boolean
  /** Quantity of this product already in the cart, in thousandths. */
  readonly inCartMilli: number
  /**
   * The quantity about to be added (a scan with a multiplier), in thousandths. Without it the
   * question is "can another sale of this product still be covered at all" (cards and rows).
   */
  readonly requestedMilli?: number
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
 * POS reliability rev 3 (Area 1) — pure presentation of the separated stock facts.
 *
 * - The warehouse figure is a dated snapshot ("as of"), never adjusted and never "in stock".
 * - "Sold here" and "Reserved here" are exact local facts, shown beside it, never subtracted.
 * - The only gate: allocation mode, not online, and the exact spendable allocation cannot cover
 *   what is already in the cart plus the requested quantity — the same rule the sale commit
 *   enforces (main remains authoritative; this only refuses earlier and explains why). Physical-presence and untracked
 *   products are never gated here; an unknown or stale snapshot is never a refusal rule.
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
      detail: null,
      blocked: false,
      blockedReason: null
    }
  }

  const warehouseMilli = view.warehouse.quantity === null ? null : toMilli(view.warehouse.quantity)
  // The warehouse figure is *unreserved* stock, so units reserved to this till are not in it. While
  // a local reservation still covers another unit, a zero snapshot must not tone the card as "out".
  const reservedAvailableMilli =
    view.kind === 'allocation' && view.reservedHere !== null
      ? toMilli(view.reservedHere) - context.inCartMilli
      : 0
  const level: StockLevel =
    warehouseMilli === null
      ? 'low-stock'
      : warehouseMilli <= 0
        ? reservedAvailableMilli > 0
          ? 'low-stock'
          : 'out-of-stock'
        : warehouseMilli <= 5000
          ? 'low-stock'
          : 'in-stock'
  const label =
    warehouseMilli === null
      ? t('pos.stock.noWarehouseRecord')
      : t('pos.stock.warehouseSnapshot', { count: context.formatQuantity(warehouseMilli / 1000) })

  const details = [t('pos.stock.asOf', { time: context.formatTime(view.warehouse.asOf) })]
  const soldMilli = toMilli(view.soldHereUnderCatalog)
  if (soldMilli > 0) {
    details.push(t('pos.stock.soldHere', { count: context.formatQuantity(soldMilli / 1000) }))
  }

  let blocked = false
  let blockedReason: string | null = null
  if (view.kind === 'allocation' && view.reservedHere !== null) {
    const reservedMilli = toMilli(view.reservedHere)
    if (reservedMilli > 0 || !context.online) {
      details.push(
        t('pos.stock.reservedHere', { count: context.formatQuantity(reservedMilli / 1000) })
      )
    }
    const available = reservedMilli - context.inCartMilli
    blocked =
      !context.online &&
      (context.requestedMilli === undefined ? available <= 0 : available < context.requestedMilli)
    if (blocked) {
      blockedReason =
        available > 0
          ? t('pos.stock.onlyReservedOffline', {
              count: context.formatQuantity(available / 1000)
            })
          : t('pos.stock.notReservedOffline')
    }
  }

  return {
    level,
    label,
    detail: details.join(' · '),
    blocked,
    blockedReason
  }
}
