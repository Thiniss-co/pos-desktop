/**
 * Display-only shapes for the Phase 3 presentational component set under `shared/components/pos/`.
 *
 * These are deliberately NOT the real business contracts (catalog, cart, payment). Every value a
 * component in this folder receives is already computed and formatted by the real Phase 3
 * services/stores; these components only ever render what they're given.
 * No file in this folder may import the preload bridge, HTTP, the local database, main-process
 * code, a business Pinia store, or a license/sync service (enforced by importBoundary.test.ts).
 */

import type { IconName } from '@renderer/shared/components/common/icons.generated'

/**
 * `recorded` is a neutral, informational tone (Rev 4 §4.3): a zero, negative or missing warehouse
 * figure, and every physical-presence figure. `out-of-stock` is reserved for the one stock rule that
 * refuses a sale on this screen — a proven offline reservation shortfall in allocation mode.
 */
export type StockLevel = 'in-stock' | 'low-stock' | 'recorded' | 'out-of-stock'

export interface DisplayProduct {
  id: string
  name: string
  sku: string
  /** Pre-formatted, locale- and currency-aware display string — never a raw number. */
  price: string
  stock: StockLevel
  categoryId?: string
  /** Sale unit as recorded in the catalog (e.g. "1L"); omitted when the catalog has none. */
  unit?: string
  /** Two-letter monogram shown on the pastel band when the product has no verified image. */
  monogram?: string
  /** The product's verified thumbnail as a `data:` URL (P8); the monogram band is used without one. */
  imageUrl?: string
  /** Pastel tone 0–5, cycled from the product's category position — never a status. */
  tone?: number
  /** Quantity already in the cart, pre-formatted; omitted when the product is not in the cart. */
  inCartQuantity?: string
  /** Full accessible name for the add action, e.g. "Add Cola Can to cart · EGP 15.00". */
  ariaLabel?: string
  /** Secondary, honestly labelled stock facts ("as of 14:05 · Sold here 2 · Reserved here 3"). */
  stockDetail?: string
}

export interface DisplayCategory {
  id: string
  label: string
  /** Pastel tone 0–5, cycled by position. */
  tone?: number
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
  /** Pre-formatted "EGP 42.50 each" line; falls back to `unitPrice`. */
  eachLabel?: string
  /** Phase E: the offer this line is sold under, pre-formatted ("Weekend deal · −EGP 3.00"). */
  offerLabel?: string
  /** POS workspace: secondary facts shown in the line menu (tax treatment), pre-formatted. */
  detail?: string
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
  | {
      readonly kind: 'blocked'
      readonly message: string
      /** Rev 3: false for an integrity-blocked attempt — retrying cannot succeed, so it is hidden. */
      readonly retryAvailable?: boolean
      /** Rev 3: extra honest context (support reference, legacy uncertainty). */
      readonly detail?: string
    }
  | { readonly kind: 'awaiting-acknowledgment'; readonly message: string }

/** One committed-but-unacknowledged sale as `SaleRecoveryBanner` renders it. */
export interface DisplayRecoveryResult {
  readonly attemptKey: string
  /** Pre-formatted, locale-aware display string — never a raw ISO timestamp. */
  readonly committedAtLabel: string
}

/** The outcome strip under `ScanEntry`. `sequence` changes on every scan so a repeat re-animates. */
export interface DisplayScanResult {
  sequence: number
  code: string
  tone: 'success' | 'warning' | 'error'
  message: string
  /** Pre-formatted detail, e.g. "Milk 1L · ×3 · 45.00". */
  detail?: string
}

export interface DisplayQuickAction {
  id: string
  label: string
  /** Shown as a key hint and exposed via `aria-keyshortcuts`, e.g. "F4". */
  shortcut?: string
  badge?: string
  icon?: IconName
  disabled?: boolean
  tone?: 'default' | 'danger'
  /** POS workspace toolbar: a fuller accessible name than the visible label ("Customer: Walk-in"). */
  ariaLabel?: string
  /** POS workspace toolbar: shown as set (a chosen customer, an applied discount). */
  active?: boolean
}

export interface DisplayHeldSale {
  id: string
  title: string
  /** Pre-formatted: time held, item count, customer. */
  meta: string
  /** Pre-formatted grand total at the moment the sale was held. */
  total: string
}

/** One quick cash tender button, e.g. "Exact 37.40" or "50.00". */
export interface DisplayQuickTender {
  id: string
  label: string
  exact?: boolean
  disabled?: boolean
}

/**
 * `PaymentPanel`'s "Complete · Exact cash" action. `label` is the full, already-formatted text
 * (e.g. "Complete · Exact cash · Cash · EGP 37.40"); `keyHint` is the visible shortcut ("Shift+F9").
 */
export interface DisplayExactCashAction {
  readonly label: string
  readonly keyHint: string
}

/** `PaymentPanel`'s "Add remaining" action: adds a tender row only, never completes. */
export interface DisplayAddRemainingAction {
  readonly label: string
}

/** The commit-class controls of `PaymentPanel` — each is also its `data-commit-action` value. */
export type PaymentCommitAction =
  'complete' | 'exact-cash' | 'retry' | 'confirm-abandon' | 'print' | 'acknowledge'

/**
 * Screen-reader descriptions (`aria-describedby`) for the commit-class controls, already localized,
 * e.g. `{ complete: 'Press F9 to complete the sale' }`. A missing entry renders no description.
 */
export type PaymentCommitKeyDescriptions = Partial<Record<PaymentCommitAction, string>>
