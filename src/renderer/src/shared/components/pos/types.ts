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

export type PaymentMethodKind = 'cash' | 'card' | 'wallet' | 'bank_transfer' | 'loyalty' | 'other'

export interface DisplayPaymentMethod {
  id: string
  kind: PaymentMethodKind
  label: string
}

/** One method tile as the payment panel renders it — eligibility is a checkout-only concern. */
export interface DisplayPaymentMethodOption {
  method: DisplayPaymentMethod
  /** `false` for a method whose type cannot be tendered at checkout (bank_transfer/wallet/loyalty). */
  eligible: boolean
  /** Shown as the disabled tile's reason (e.g. a native `title`) when `eligible` is `false`. */
  ineligibleReason?: string
}

export interface DisplaySplitPayment {
  id: string
  methodLabel: string
  /** Pre-formatted amount. */
  amount: string
  /** Pre-formatted reference, when the row carries one. */
  reference?: string
}

export type ShiftPhase =
  'closed' | 'cancelled' | 'opening' | 'open' | 'pausing' | 'paused' | 'resuming' | 'closing'

export type SyncQueueDisplayState =
  'pending' | 'uploading' | 'retryable-error' | 'conflict' | 'rejected'

/**
 * `PaymentPanel`'s local completion-recovery display state (Phase 3F CP-4). `blocked` is an
 * existing claimed attempt for this cashier that must be retried or explicitly abandoned before a
 * new sale can start (D1-A); `awaiting-acknowledgment` is a just-committed sale whose receipt the
 * cashier must explicitly dismiss (T7) before starting another. Both messages are already
 * localized upstream — this folder never imports i18n directly.
 */
export type PaymentPanelRecoveryState =
  | { readonly kind: 'clear' }
  | { readonly kind: 'blocked'; readonly message: string }
  | { readonly kind: 'awaiting-acknowledgment'; readonly message: string }

/** One committed-but-unacknowledged sale as `SaleRecoveryBanner` renders it. */
export interface DisplayRecoveryResult {
  readonly attemptKey: string
  /** Pre-formatted, locale-aware display string — never a raw ISO timestamp. */
  readonly committedAtLabel: string
}
