/**
 * Display-only shapes for the Phase 3 presentational component set under `shared/components/pos/`.
 *
 * These are deliberately NOT the real business contracts (catalog, cart, payment). Every value a
 * component in this folder receives is already computed and formatted by the real Phase 3
 * services/stores; these components only ever render what they're given.
 * No file in this folder may import the preload bridge, HTTP, the local database, main-process
 * code, a business Pinia store, or a license/sync service (enforced by importBoundary.test.ts).
 */

export type StockLevel = 'in-stock' | 'low-stock' | 'out-of-stock'

export interface DisplayProduct {
  id: string
  name: string
  sku: string
  /** Pre-formatted, locale- and currency-aware display string — never a raw number. */
  price: string
  stock: StockLevel
  categoryId?: string
}

export interface DisplayCategory {
  id: string
  label: string
}

export interface DisplayCartLine {
  id: string
  name: string
  sku: string
  quantity: number
  /** Pre-formatted unit price. */
  unitPrice: string
  /** Pre-formatted line total (quantity × unit price, already computed upstream). */
  lineTotal: string
}

export interface DisplayCustomer {
  id: string
  name: string
  detail?: string
}

export type PaymentMethodKind = 'cash' | 'card' | 'wallet' | 'store-credit' | 'other'

export interface DisplayPaymentMethod {
  id: string
  kind: PaymentMethodKind
  label: string
}

export interface DisplaySplitPayment {
  id: string
  methodLabel: string
  /** Pre-formatted amount. */
  amount: string
}

export type ShiftPhase =
  'closed' | 'cancelled' | 'opening' | 'open' | 'pausing' | 'paused' | 'resuming' | 'closing'

export type SyncQueueDisplayState =
  'pending' | 'uploading' | 'retryable-error' | 'conflict' | 'rejected'
