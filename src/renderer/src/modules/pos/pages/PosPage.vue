<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import type { CatalogProduct, PaymentMethodType } from '@shared/contracts/catalog.contract'
import type { CheckoutIntent } from '@shared/contracts/checkout.contract'
import type { LocaleCode } from '@shared/contracts/preferences.contract'
import type {
  DisplayHeldSale,
  DisplayPaymentMethodOption,
  DisplayQuickAction,
  DisplayQuickTender,
  DisplayRecoveryResult,
  DisplayScanResult,
  DisplaySplitPayment,
  PaymentPanelRecoveryState,
  ShiftPhase
} from '@renderer/shared/components/pos/types'
import { useBootstrapStore } from '@renderer/modules/bootstrap/store'
import { useSyncStore } from '@renderer/modules/sync/store'
import { useLocaleStore } from '@renderer/modules/preferences/locale.store'
import { formatDateTime, formatRelativeDateTime } from '@renderer/shared/utils/format'
import {
  formatMinorCurrency,
  parseMinorCurrencyInput,
  parsePercentageBasisPointsInput
} from '@shared/money/minorUnits'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppDialog from '@renderer/shared/components/common/AppDialog.vue'
import AppEmptyState from '@renderer/shared/components/feedback/AppEmptyState.vue'
import AppInlineError from '@renderer/shared/components/feedback/AppInlineError.vue'
import AppLoadingSkeleton from '@renderer/shared/components/feedback/AppLoadingSkeleton.vue'
import AppStatusChip from '@renderer/shared/components/feedback/AppStatusChip.vue'
import AppInput from '@renderer/shared/components/forms/AppInput.vue'
import AppSelect from '@renderer/shared/components/forms/AppSelect.vue'
import CartLineItem from '@renderer/shared/components/pos/CartLineItem.vue'
import CatalogRefreshPanel from '@renderer/shared/components/pos/CatalogRefreshPanel.vue'
import CartPanel from '@renderer/shared/components/pos/CartPanel.vue'
import CategorySelector from '@renderer/shared/components/pos/CategorySelector.vue'
import OrderTotals from '@renderer/shared/components/pos/OrderTotals.vue'
import PosWorkspaceShell from '@renderer/shared/components/pos/PosWorkspaceShell.vue'
import ProductCard from '@renderer/shared/components/pos/ProductCard.vue'
import ProductSearchBar from '@renderer/shared/components/pos/ProductSearchBar.vue'
import ShiftStatusControl from '@renderer/shared/components/pos/ShiftStatusControl.vue'
import CustomerSelector from '@renderer/shared/components/pos/CustomerSelector.vue'
import PaymentMethodTile from '@renderer/shared/components/pos/PaymentMethodTile.vue'
import PaymentPanel from '@renderer/shared/components/pos/PaymentPanel.vue'
import HeldSalesList from '@renderer/shared/components/pos/HeldSalesList.vue'
import QuickActionsBar from '@renderer/shared/components/pos/QuickActionsBar.vue'
import ScanEntry from '@renderer/shared/components/pos/ScanEntry.vue'
import SaleRecoveryBanner from '@renderer/shared/components/pos/SaleRecoveryBanner.vue'
import { useCartStore } from '../cart.store'
import { useCatalogStore } from '../catalog.store'
import { usePaymentStore } from '../payment.store'
import { useShiftStore } from '../shift.store'
import { useBarcodeScanner } from '../useBarcodeScanner'
import { usePosShortcuts } from '../usePosShortcuts'
import { minorToDecimalText, parseScanEntry, quickCashAmounts } from '../quickSale'

type DialogMode =
  | 'open'
  | 'pause'
  | 'close'
  | 'help'
  | 'customers'
  | 'payment-methods'
  | 'rebuild'
  | 'discount'
  | 'held'
  | null

type InvoiceDiscountSelection = 'none' | 'fixed' | 'percentage'

const { t, te } = useI18n()
const localeStore = useLocaleStore()
const bootstrap = useBootstrapStore()
const catalog = useCatalogStore()
const cart = useCartStore()
const shift = useShiftStore()
const payment = usePaymentStore()
const sync = useSyncStore()
// Live queue visibility in the till shell. Deliberately independent of connectivity: an offline
// cashier must still see what is waiting, and POS rendering never depends on the network.
const syncChipVariant = computed(() => {
  if (sync.failedCount > 0) {
    return 'error' as const
  }

  return sync.isPaused ? ('warning' as const) : ('information' as const)
})
const syncChipLabel = computed(() => {
  if (sync.failedCount > 0) {
    return t('pos.syncReview', { count: sync.failedCount })
  }

  return sync.isPaused
    ? t('pos.syncPaused', { count: sync.queuedCount })
    : t('pos.syncIdle', { count: sync.queuedCount })
})
const {
  categories,
  products,
  query,
  selectedCategoryUuid,
  isLoading: catalogLoading,
  isAvailable: catalogAvailable,
  status: catalogState,
  paymentMethods,
  customers,
  customerQuery,
  selectedCustomerUuid,
  error: catalogError,
  isRefreshing: catalogRefreshing,
  lastRefreshedAt: catalogLastRefreshedAt,
  lastRefreshRevisionChanged: catalogRevisionChanged,
  refreshError: catalogRefreshError
} = storeToRefs(catalog)
const {
  lines,
  contract: cartContract,
  calculation,
  cartState,
  canEdit,
  error: cartError,
  invoiceDiscountType,
  invoiceDiscountValue,
  draftRevision: cartDraftRevision,
  heldDrafts
} = storeToRefs(cart)
const {
  currentShift,
  activeShiftUuid,
  observedStatus,
  freshness,
  mutation,
  error: shiftError,
  canSell
} = storeToRefs(shift)
const {
  rows: paymentRows,
  draftAmountText,
  draftReferenceText,
  draftErrorCode,
  isEditingDraft,
  activeMethodUuid,
  paidTotalAmount,
  previewOutcome,
  previewPending,
  previewError,
  completionPending,
  completionOutcome,
  completionError,
  blockingAttemptKey,
  pendingResults,
  isBlocked
} = storeToRefs(payment)
const { isRunning: isRefreshingCatalog, error: bootstrapError } = storeToRefs(bootstrap)
const searchRef = ref<InstanceType<typeof ProductSearchBar> | null>(null)
const dialogMode = ref<DialogMode>(null)
const cashAmount = ref('0.00')
const cashError = ref<string | null>(null)
const note = ref('')
const invoiceDiscountSelection = ref<InvoiceDiscountSelection>('none')
const invoiceDiscountDraft = ref('')
const invoiceDiscountError = ref<string | null>(null)
const rebuildError = ref<string | null>(null)
const rebuildPreview = ref<{
  readonly token: string
  readonly revision: string
  readonly products: readonly CatalogProduct[]
} | null>(null)
const scanRef = ref<InstanceType<typeof ScanEntry> | null>(null)
const scanText = ref('')
const pendingMultiplier = ref<number | null>(null)
const scanResult = ref<DisplayScanResult | null>(null)
const lastAddedProductUuid = ref<string | null>(null)
let scanSequence = 0
const paymentPanelOpen = ref(false)
let searchTimer: number | undefined
let customerSearchTimer: number | undefined
let previewTimer: number | undefined
let synchronizationAgeTimer: number | undefined
const synchronizationReferenceTime = ref(Date.now())

const activeCurrency = computed(() => cartContract.value?.currency ?? 'EGP')
const currencyExponent = computed(() => cartContract.value?.currencyExponent ?? 2)
const shiftPhase = computed<ShiftPhase>(() => mutation.value ?? observedStatus.value ?? 'closed')
const shiftPhaseLabel = computed(() =>
  freshness.value === 'unknown' ? t('pos.shiftUnknown') : t(`pos.shift.${shiftPhase.value}`)
)
const catalogStatus = computed(() => catalogState.value?.status ?? 'unavailable')
const catalogStatusVariant = computed(() => {
  if (catalogStatus.value === 'fresh') {
    return 'success'
  }

  if (catalogStatus.value === 'cached') {
    return 'information'
  }

  return catalogStatus.value === 'stale' ? 'warning' : 'error'
})
const catalogUsableForDraft = computed(() => catalogState.value?.catalogValid === true)
const catalogLastRefreshedLabel = computed(() => {
  const value = catalogLastRefreshedAt.value
  return value
    ? t('pos.catalogRefresh.lastRefreshed', {
        time: formatDateTime(value, localeStore.locale as LocaleCode, {
          dateStyle: 'medium',
          timeStyle: 'short'
        })
      })
    : null
})
/**
 * Only surfaced while a draft actually exists: a revision change with an empty cart needs no
 * cashier action, and telling them to rebuild nothing would be noise. With lines present the cart
 * store has already invalidated the draft (`CART_CATALOG_CHANGED`), so this message names the
 * resolution the page already offers — rebuild or clear — and never a silent reprice.
 */
const catalogRevisionChangedMessage = computed(() =>
  catalogRevisionChanged.value && lines.value.length > 0
    ? t('pos.catalogRefresh.revisionChanged')
    : null
)
const lastSyncedAt = computed(() => {
  const value = catalogState.value?.lastSyncedAt
  return value
    ? formatDateTime(value, localeStore.locale as LocaleCode, {
        dateStyle: 'medium',
        timeStyle: 'short'
      })
    : null
})
const lastSyncedRelative = computed(() => {
  const value = catalogState.value?.lastSyncedAt
  return value
    ? formatRelativeDateTime(
        value,
        localeStore.locale as LocaleCode,
        synchronizationReferenceTime.value
      )
    : null
})
const cartDisplayLines = computed(() =>
  lines.value.map((line, index) => ({
    id: line.id,
    name: line.product.name,
    sku: line.product.sku ?? '—',
    quantity: Number.parseFloat(line.quantity),
    unitPrice: money(line.product.price.amount, line.product.price.currency),
    lineTotal: money(calculation.value?.lines[index]?.totalAmount ?? 0, line.product.price.currency)
  }))
)
const rebuildPreviewRows = computed(() => {
  if (!rebuildPreview.value) {
    return []
  }

  const replacements = new Map(
    rebuildPreview.value.products.map((product) => [product.uuid, product])
  )
  return lines.value.flatMap((line) => {
    const replacement = replacements.get(line.product.uuid)
    return replacement
      ? [
          {
            id: line.id,
            name: line.product.name,
            oldPrice: money(line.product.price.amount, line.product.price.currency),
            newPrice: money(replacement.price.amount, replacement.price.currency),
            taxChanged:
              line.product.tax.mode !== replacement.tax.mode ||
              line.product.tax.rateBasisPoints !== replacement.tax.rateBasisPoints
          }
        ]
      : []
  })
})

const canOpenPaymentPanel = computed(() => canSell.value && cartState.value.kind === 'valid')
const checkoutActionLabel = computed(() => {
  if (!canSell.value) {
    return t('pos.checkoutRequiresOpenShift')
  }

  if (cartState.value.kind === 'empty') {
    return t('pos.checkoutRequiresItem')
  }

  if (cartState.value.kind === 'invalid') {
    return t('pos.checkoutRequiresValidCart')
  }

  return t('pos.payment.proceedToPayment')
})

const paymentMethodOptions = computed<DisplayPaymentMethodOption[]>(() =>
  paymentMethods.value.map((method) => {
    const reasonKey = paymentMethodIneligibleReasonKey(method.type)
    return {
      method: { id: method.uuid, kind: paymentMethodKind(method.type), label: method.name },
      eligible: reasonKey === null,
      ineligibleReason: reasonKey ? String(t(reasonKey)) : undefined
    }
  })
)

const activeMethod = computed(() =>
  activeMethodUuid.value
    ? (paymentMethods.value.find((method) => method.uuid === activeMethodUuid.value) ?? null)
    : null
)

const paymentDisplayRows = computed<DisplaySplitPayment[]>(() =>
  paymentRows.value.map((row) => {
    const method = paymentMethods.value.find((candidate) => candidate.uuid === row.methodUuid)
    return {
      id: row.id,
      methodLabel: method?.name ?? t('pos.payment.unknownMethod'),
      amount: money(row.amount),
      reference: row.reference ?? undefined
    }
  })
)

const checkoutIntent = computed<CheckoutIntent | null>(() => {
  if (!cartContract.value || lines.value.length === 0 || paymentRows.value.length === 0) {
    return null
  }

  return {
    draftRevision: cartDraftRevision.value,
    catalogRevision: cartContract.value.revision,
    items: lines.value.map((line) => ({
      id: line.id,
      productUuid: line.product.uuid,
      quantity: line.quantity,
      discountType: line.discountType,
      discountValue: line.discountValue
    })),
    invoiceDiscount: {
      discountType: invoiceDiscountType.value,
      discountValue: invoiceDiscountValue.value
    },
    customerUuid: selectedCustomerUuid.value,
    payments: paymentRows.value.map((row) => ({
      id: row.id,
      paymentMethodUuid: row.methodUuid,
      amount: row.amount,
      reference: row.reference
    }))
  }
})

const paidTotalDisplay = computed(() => money(paidTotalAmount.value))
const changeDueDisplay = computed(() => {
  const outcome = previewOutcome.value
  return outcome?.outcome === 'valid' && outcome.changeDueAmount > 0
    ? money(outcome.changeDueAmount)
    : undefined
})
const dueDisplay = computed(() => {
  const outcome = previewOutcome.value
  return outcome?.outcome === 'valid' && outcome.dueAmount > 0
    ? money(outcome.dueAmount)
    : undefined
})

const previewIsError = computed(
  () => previewError.value !== null || (previewOutcome.value?.outcome ?? 'valid') !== 'valid'
)
const previewMessage = computed<string | undefined>(() => {
  if (previewError.value) {
    return previewError.value
  }

  const outcome = previewOutcome.value
  if (!outcome || outcome.outcome === 'valid') {
    return undefined
  }

  if (outcome.outcome === 'invalid') {
    return String(t(`pos.errors.${outcome.code}`))
  }

  if (outcome.outcome === 'shift-unavailable') {
    return String(t(`pos.payment.shiftUnavailable.${outcome.state}`))
  }

  return String(
    t(
      `pos.payment.${outcome.outcome === 'refresh-required' ? 'refreshRequired' : 'contextChanged'}`
    )
  )
})

const completionEnabled = computed(
  () => canSell.value && !isBlocked.value && previewOutcome.value?.outcome === 'valid'
)

const completionRefreshAvailable = computed(
  () =>
    completionOutcome.value?.outcome === 'rejected' &&
    completionOutcome.value.failureCode === 'stock-allocation-unavailable'
)

function localizedCompletionCode(namespace: 'rejected' | 'failed', code: string): string {
  const key = `pos.payment.completion.${namespace}.${code}`
  return te(key) ? String(t(key)) : String(t('pos.payment.completion.genericFailure'))
}

const completionIsError = computed(() => {
  if (completionError.value) {
    return true
  }

  const outcome = completionOutcome.value
  return (
    outcome !== null &&
    outcome.outcome !== 'committed' &&
    outcome.outcome !== 'acknowledged' &&
    !(outcome.outcome === 'failed' && outcome.code === 'attempt-blocked')
  )
})

const completionMessage = computed<string | undefined>(() => {
  if (completionError.value) {
    return completionError.value
  }

  const outcome = completionOutcome.value
  if (!outcome) {
    return undefined
  }

  if (outcome.outcome === 'rejected') {
    const message = localizedCompletionCode('rejected', outcome.failureCode)
    if (outcome.failureCode === 'stock-allocation-unavailable' && outcome.affectedLineIds?.length) {
      const affectedIds = new Set(outcome.affectedLineIds)
      const productNames = lines.value
        .filter((line) => affectedIds.has(line.id))
        .map((line) => line.product.name)

      if (productNames.length > 0) {
        return `${t('pos.payment.completion.affectedProducts', {
          products: productNames.join(', ')
        })} ${message}`
      }
    }

    return message
  }

  // `attempt-blocked` is shown through `paymentPanelRecoveryState` instead, never as an inline
  // error alongside a completion control the cashier cannot use while blocked.
  if (outcome.outcome === 'failed' && outcome.code !== 'attempt-blocked') {
    return localizedCompletionCode('failed', outcome.code)
  }

  return undefined
})

const paymentPanelRecoveryState = computed<PaymentPanelRecoveryState>(() => {
  if (isBlocked.value) {
    return { kind: 'blocked', message: String(t('pos.payment.completion.blocked')) }
  }

  const outcome = completionOutcome.value
  if (outcome && outcome.outcome === 'committed') {
    return {
      kind: 'awaiting-acknowledgment',
      message: String(
        t('pos.payment.completion.committed', { offlineNumber: outcome.invoice.offlineNumber })
      )
    }
  }

  return { kind: 'clear' }
})

const displayUnacknowledgedResults = computed<DisplayRecoveryResult[]>(() =>
  pendingResults.value.map((result) => ({
    attemptKey: result.attemptKey,
    committedAtLabel: formatDateTime(result.committedAt, localeStore.locale as LocaleCode, {
      dateStyle: 'medium',
      timeStyle: 'short'
    })
  }))
)

// --- Quick sale column: scan entry, quick actions, held sales, quick tender ---------------------
/**
 * A sale that is committing, blocked on recovery, or committed-but-unacknowledged still owns the
 * attempt key. Adding lines then would start the next sale inside the previous attempt, so the
 * scan entry and quick actions stay locked until that attempt is resolved.
 */
const attemptSettled = computed(
  () => !completionPending.value && paymentPanelRecoveryState.value.kind === 'clear'
)
const canAddToCart = computed(
  () => canSell.value && catalogUsableForDraft.value && attemptSettled.value
)
const canHold = computed(() => lines.value.length > 0 && attemptSettled.value)
const selectedCustomer = computed(() =>
  selectedCustomerUuid.value
    ? (customers.value.find((customer) => customer.uuid === selectedCustomerUuid.value) ?? null)
    : null
)
const selectedCustomerLabel = computed(() => {
  if (!selectedCustomerUuid.value) {
    return null
  }

  return selectedCustomer.value?.name ?? String(t('pos.quickSale.customerAttached'))
})
const lastAddedLine = computed(() =>
  lastAddedProductUuid.value
    ? ([...lines.value]
        .reverse()
        .find((line) => line.product.uuid === lastAddedProductUuid.value) ?? null)
    : null
)

const quickActions = computed<DisplayQuickAction[]>(() => [
  {
    id: 'hold',
    label: String(t('pos.quickSale.hold')),
    shortcut: 'F4',
    disabled: !canHold.value
  },
  {
    id: 'recall',
    label: String(t('pos.quickSale.recall')),
    shortcut: 'F6',
    badge: heldDrafts.value.length > 0 ? String(heldDrafts.value.length) : undefined,
    disabled: heldDrafts.value.length === 0 || !attemptSettled.value
  },
  {
    id: 'customer',
    label: String(t('pos.quickSale.customer')),
    shortcut: 'F7',
    disabled: !catalogAvailable.value || !attemptSettled.value
  },
  {
    id: 'discount',
    label: String(t('pos.discount')),
    shortcut: 'F8',
    disabled: lines.value.length === 0 || !canEdit.value || !attemptSettled.value
  },
  {
    id: 'repeat',
    label: String(t('pos.quickSale.repeatLast')),
    disabled: lastAddedLine.value === null || !canEdit.value || !canAddToCart.value
  },
  {
    id: 'clear',
    label: String(t('pos.clearCart')),
    tone: 'danger',
    disabled: lines.value.length === 0 || !attemptSettled.value
  }
])

const heldSalesDisplay = computed<DisplayHeldSale[]>(() =>
  [...heldDrafts.value].reverse().map((held, index, all) => ({
    id: held.id,
    title: String(t('pos.quickSale.heldTitle', { number: all.length - index })),
    meta: [
      formatDateTime(held.heldAt, localeStore.locale as LocaleCode, { timeStyle: 'short' }),
      String(t('pos.quickSale.heldItems', { count: held.itemCount })),
      held.customerName ?? (held.customerUuid ? String(t('pos.quickSale.customerAttached')) : null)
    ]
      .filter((part): part is string => Boolean(part))
      .join(' · '),
    total: held.grandTotalAmount === null ? '—' : money(held.grandTotalAmount)
  }))
)

const cashTenderMethod = computed(
  () =>
    paymentMethods.value.find((method) => method.type === 'cash' && !method.requiresReference) ??
    null
)
/** Authoritative due amount from the main-process preview when it has one, else a local estimate. */
const outstandingAmount = computed(() => {
  const outcome = previewOutcome.value
  if (outcome?.outcome === 'valid') {
    return Math.max(0, outcome.dueAmount)
  }

  return Math.max(0, (calculation.value?.grandTotalAmount ?? 0) - paidTotalAmount.value)
})
const quickTenders = computed<DisplayQuickTender[]>(() => {
  if (!cashTenderMethod.value || cartState.value.kind !== 'valid') {
    return []
  }

  return quickCashAmounts(outstandingAmount.value, currencyExponent.value).map((amount, index) => ({
    id: String(amount),
    label:
      index === 0 ? String(t('pos.quickSale.exactCash', { amount: money(amount) })) : money(amount),
    exact: index === 0,
    disabled: isEditingDraft.value || completionPending.value || isBlocked.value
  }))
})

function reportScan(
  code: string,
  tone: DisplayScanResult['tone'],
  message: string,
  detail?: string
): void {
  scanSequence += 1
  scanResult.value = { sequence: scanSequence, code, tone, message, detail }
}

function quantityLabel(quantityMilli: number): string {
  return String(quantityMilli / 1000)
}

/**
 * The single add-by-code path shared by the scan-entry field and the page-level scanner listener.
 * `explicitMilli` comes from a typed `3*code` prefix; otherwise a pending multiplier tile applies
 * once, then resets, so the next scan is back to one unit.
 */
async function addByCode(code: string, explicitMilli: number | null): Promise<void> {
  const quantityMilli = explicitMilli ?? (pendingMultiplier.value ?? 1) * 1000
  const result = await catalog.findProductByBarcode(code)

  if (result.outcome !== 'found') {
    reportScan(
      code,
      result.outcome === 'stale-catalog' ? 'warning' : 'error',
      String(t(`pos.barcode.${result.outcome}`))
    )
    return
  }

  if (!canAddToCart.value) {
    reportScan(
      code,
      'warning',
      String(t(canSell.value ? 'pos.quickSale.addBlocked' : 'pos.openShiftToSell'))
    )
    return
  }

  if (!cart.addProduct(result.product, quantityMilli)) {
    reportScan(code, 'error', cartError.value ?? String(t('pos.errors.CART_INVALID')))
    return
  }

  pendingMultiplier.value = null
  lastAddedProductUuid.value = result.product.uuid
  reportScan(
    code,
    'success',
    String(t('pos.quickSale.added')),
    `${result.product.name} · ×${quantityLabel(quantityMilli)} · ${money(result.product.price.amount, result.product.price.currency)}`
  )
}

function handleScanSubmit(text: string): void {
  const parsed = parseScanEntry(text)
  if (!parsed.ok) {
    if (parsed.code === 'SCAN_QUANTITY_INVALID') {
      reportScan(text.trim(), 'error', String(t('pos.quickSale.invalidQuantity')))
    }
    return
  }

  scanText.value = ''
  void addByCode(parsed.code, parsed.quantityMilli)
}

function focusScanEntry(): void {
  scanRef.value?.focus()
}

function holdCurrentSale(): boolean {
  if (!canHold.value) {
    return false
  }

  const customer = selectedCustomerUuid.value
    ? { uuid: selectedCustomerUuid.value, name: selectedCustomer.value?.name ?? null }
    : null
  const held = cart.holdDraft(customer)
  if (!held) {
    return false
  }

  payment.clearDraft()
  catalog.selectCustomer(null)
  paymentPanelOpen.value = false
  pendingMultiplier.value = null
  lastAddedProductUuid.value = null
  reportScan('—', 'success', String(t('pos.quickSale.heldNotice', { count: held.itemCount })))
  return true
}

function recallHeldSale(id: string): void {
  if (!attemptSettled.value) {
    return
  }

  // Recall never merges: a non-empty live draft is parked first, so switching customers is one tap.
  if (lines.value.length > 0 && !holdCurrentSale()) {
    return
  }

  const held = cart.recallDraft(id)
  if (!held) {
    return
  }

  payment.clearDraft()
  catalog.selectCustomer(held.customerUuid)
  lastAddedProductUuid.value = null
  dialogMode.value = null
  focusScanEntry()
}

function discardHeldSale(id: string): void {
  cart.discardHeldDraft(id)
  if (heldDrafts.value.length === 0) {
    dialogMode.value = null
  }
}

function repeatLastItem(): void {
  const line = lastAddedLine.value
  if (line && canAddToCart.value) {
    cart.incrementQuantity(line.id)
  }
}

function clearSale(): void {
  if (!attemptSettled.value) {
    return
  }

  cart.clear()
  payment.clearDraft()
  catalog.selectCustomer(null)
  pendingMultiplier.value = null
  lastAddedProductUuid.value = null
  paymentPanelOpen.value = false
}

function handleQuickAction(id: string): void {
  const action = quickActions.value.find((candidate) => candidate.id === id)
  if (!action || action.disabled) {
    return
  }

  if (id === 'hold') {
    holdCurrentSale()
  } else if (id === 'recall') {
    dialogMode.value = 'held'
  } else if (id === 'customer') {
    openDialog('customers')
  } else if (id === 'discount') {
    openInvoiceDiscountDialog()
  } else if (id === 'repeat') {
    repeatLastItem()
  } else if (id === 'clear') {
    clearSale()
  }
}

function handleQuickTender(id: string): void {
  const method = cashTenderMethod.value
  const amount = Number(id)
  if (!method || !Number.isSafeInteger(amount) || amount <= 0) {
    return
  }

  payment.beginAddRow(method.uuid)
  payment.setDraftAmountText(minorToDecimalText(amount, currencyExponent.value))
  payment.commitDraftRow(currencyExponent.value)
}

/** F9: first press opens payment in the column; once a valid tender covers the sale, completes it. */
function handlePayShortcut(): void {
  if (!paymentPanelOpen.value) {
    openPaymentPanel()
  } else if (completionEnabled.value && !completionPending.value) {
    handleComplete()
  }
}

function handleComplete(): void {
  if (!checkoutIntent.value) {
    return
  }

  const intent = checkoutIntent.value
  void payment.complete(
    () => cart.captureContext(),
    intent,
    () => cart.clear()
  )
}

/**
 * Runs the authoritative workstation-data refresh. The store refuses a duplicate while one is in
 * flight, so a double-click cannot start two. The cart is deliberately left alone: if the refresh
 * moved the catalog revision, the existing `catalogState.contract` watcher hands the new contract
 * to `cart.setContract()`, which invalidates the draft with `CART_CATALOG_CHANGED` and leaves the
 * cashier the explicit rebuild-or-clear choice this page already implements.
 */
function handleRefreshCatalog(): void {
  void catalog.refresh()
}

function handleRetryAttempt(key: string | null = blockingAttemptKey.value): void {
  if (key) {
    void payment.retryAttempt(key)
  }
}

function handleAbandonAttempt(key: string | null = blockingAttemptKey.value): void {
  if (key) {
    void payment.abandonAttempt(key)
  }
}

function handleAcknowledgeAttempt(
  key: string | null = completionOutcome.value?.outcome === 'committed' ||
  completionOutcome.value?.outcome === 'acknowledged'
    ? completionOutcome.value.attemptKey
    : null
): void {
  if (key) {
    void payment.acknowledgeAttempt(key)
  }
}

function schedulePaymentPreview(): void {
  window.clearTimeout(previewTimer)

  if (!paymentPanelOpen.value || !checkoutIntent.value) {
    return
  }

  const intent = checkoutIntent.value
  previewTimer = window.setTimeout(() => {
    void payment.refreshPreview(() => cart.captureContext(), intent)
  }, 300)
}

function openPaymentPanel(): void {
  if (!canOpenPaymentPanel.value) {
    return
  }

  paymentPanelOpen.value = true

  if (checkoutIntent.value) {
    void payment.refreshPreview(() => cart.captureContext(), checkoutIntent.value)
  }
}

function closePaymentPanel(): void {
  paymentPanelOpen.value = false
}

function selectPaymentMethod(methodId: string): void {
  payment.beginAddRow(methodId)
  // Pre-fill what is still owed: the common case (exact card/cash) becomes one Enter.
  if (outstandingAmount.value > 0) {
    payment.setDraftAmountText(minorToDecimalText(outstandingAmount.value, currencyExponent.value))
  }
}

function editPaymentRow(rowId: string): void {
  const row = paymentRows.value.find((candidate) => candidate.id === rowId)
  if (!row) {
    return
  }

  payment.beginEditRow(rowId)
  payment.setDraftAmountText(String(row.amount / 10 ** currencyExponent.value))
}

function commitPaymentDraft(): void {
  payment.commitDraftRow(currencyExponent.value)
}

watch(checkoutIntent, () => schedulePaymentPreview(), { deep: true })
watch(paymentPanelOpen, (isOpen) => {
  if (isOpen) {
    schedulePaymentPreview()
  } else {
    window.clearTimeout(previewTimer)
  }
})

function money(amount: number, currency = activeCurrency.value): string {
  const formatted = formatMinorCurrency(
    amount,
    localeStore.locale as LocaleCode,
    currency,
    currencyExponent.value
  )
  return formatted.ok ? formatted.value : '—'
}

function paymentMethodKind(
  value: string | null
): 'cash' | 'card' | 'wallet' | 'bank_transfer' | 'loyalty' | 'other' {
  return value === 'cash' ||
    value === 'card' ||
    value === 'wallet' ||
    value === 'bank_transfer' ||
    value === 'loyalty'
    ? value
    : 'other'
}

const ELIGIBLE_PAYMENT_TYPES = new Set<string>(['cash', 'card', 'other'])

/** Ineligible types render disabled with a reason — never hidden. See the frozen contract matrix. */
function paymentMethodIneligibleReasonKey(type: PaymentMethodType | null): string | null {
  if (type !== null && ELIGIBLE_PAYMENT_TYPES.has(type)) {
    return null
  }

  if (type === 'loyalty') {
    return 'pos.payment.ineligibleLoyalty'
  }

  if (type === 'bank_transfer') {
    return 'pos.payment.ineligibleBankTransfer'
  }

  if (type === 'wallet') {
    return 'pos.payment.ineligibleWallet'
  }

  return 'pos.payment.ineligibleUnsupported'
}

function stock(product: CatalogProduct): {
  level: 'in-stock' | 'low-stock' | 'out-of-stock'
  label: string
} {
  if (!product.trackStock || product.availableQuantity === null) {
    return { level: 'in-stock', label: t('pos.stockUntracked') }
  }

  const quantity = Number(product.availableQuantity)

  if (quantity <= 0) {
    return { level: 'out-of-stock', label: t('pos.outOfStock') }
  }

  if (quantity <= 5) {
    return { level: 'low-stock', label: t('pos.lowStock') }
  }

  return { level: 'in-stock', label: t('pos.inStock') }
}

async function addSelectedProduct(uuid: string): Promise<void> {
  if (canAddToCart.value) {
    const currentProduct = await catalog.getProduct(uuid)

    if (currentProduct && cart.addProduct(currentProduct, (pendingMultiplier.value ?? 1) * 1000)) {
      pendingMultiplier.value = null
      lastAddedProductUuid.value = currentProduct.uuid
    }
  }
}

function openDialog(mode: Exclude<DialogMode, null>): void {
  cashAmount.value =
    mode === 'close' && currentShift.value?.expectedCashAmount !== null
      ? String((currentShift.value?.expectedCashAmount ?? 0) / 100)
      : '0.00'
  note.value = ''
  cashError.value = null
  dialogMode.value = mode
}

function openInvoiceDiscountDialog(): void {
  invoiceDiscountSelection.value = invoiceDiscountType.value ?? 'none'
  invoiceDiscountDraft.value =
    invoiceDiscountType.value === 'percentage'
      ? String(invoiceDiscountValue.value / 100)
      : String(invoiceDiscountValue.value / 10 ** currencyExponent.value)
  invoiceDiscountError.value = null
  dialogMode.value = 'discount'
}

function applyInvoiceDiscount(): boolean {
  if (invoiceDiscountSelection.value === 'none') {
    if (invoiceDiscountType.value === null && invoiceDiscountValue.value === 0) {
      invoiceDiscountDraft.value = ''
      invoiceDiscountError.value = null
      return true
    }

    if (cart.setInvoiceDiscount(null, 0)) {
      invoiceDiscountDraft.value = ''
      invoiceDiscountError.value = null
      return true
    }

    return false
  }

  const parsed =
    invoiceDiscountSelection.value === 'fixed'
      ? parseMinorCurrencyInput(invoiceDiscountDraft.value, currencyExponent.value)
      : parsePercentageBasisPointsInput(invoiceDiscountDraft.value)

  if (!parsed.ok) {
    invoiceDiscountError.value = t('pos.invalidDiscount')
    return false
  }

  if (
    invoiceDiscountType.value === invoiceDiscountSelection.value &&
    invoiceDiscountValue.value === parsed.value
  ) {
    invoiceDiscountError.value = null
    return true
  }

  const applied = cart.setInvoiceDiscount(invoiceDiscountSelection.value, parsed.value)
  invoiceDiscountError.value = applied ? null : cartError.value
  return applied
}

function commitInvoiceDiscount(): void {
  if (applyInvoiceDiscount()) {
    dialogMode.value = null
  }
}

function resetInvoiceDiscountDraft(): void {
  invoiceDiscountSelection.value = invoiceDiscountType.value ?? 'none'
  invoiceDiscountDraft.value =
    invoiceDiscountType.value === 'percentage'
      ? String(invoiceDiscountValue.value / 100)
      : String(invoiceDiscountValue.value / 10 ** currencyExponent.value)
  invoiceDiscountError.value = null
}

function handleInvoiceDiscountKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault()
    commitInvoiceDiscount()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    resetInvoiceDiscountDraft()
  }
}

function parseMinorUnits(value: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim())

  if (!match) {
    return null
  }

  const amount = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
  return Number.isSafeInteger(amount) && amount <= 2_147_483_647 ? amount : null
}

async function submitDialog(): Promise<void> {
  const amount = parseMinorUnits(cashAmount.value)
  let succeeded = false

  if (dialogMode.value !== 'pause' && amount === null) {
    cashError.value = t('pos.invalidCash')
    return
  }

  if (dialogMode.value === 'open' && amount !== null) {
    succeeded = await shift.open({ openingCashAmount: amount, notes: note.value || null })
  } else if (dialogMode.value === 'pause' && activeShiftUuid.value) {
    // `activeShiftUuid` may come from local authority while the backend is unreachable. The store's
    // `mutate` still refuses to send any lifecycle change until an authoritative refresh succeeds,
    // so this surfaces the real transport denial instead of silently doing nothing.
    succeeded = await shift.pause({
      uuid: activeShiftUuid.value,
      reason: note.value || null,
      notes: null
    })
  } else if (dialogMode.value === 'close' && activeShiftUuid.value && amount !== null) {
    succeeded = await shift.close({
      uuid: activeShiftUuid.value,
      actualCashAmount: amount,
      closeNotes: note.value || null
    })
  }

  if (succeeded) {
    dialogMode.value = null
  }
}

async function resumeShift(): Promise<void> {
  if (activeShiftUuid.value) {
    await shift.resume({ uuid: activeShiftUuid.value, resumeNotes: null })
  }
}

/**
 * A scan made while no input has focus. The scan outcome is always reported: found, not-found,
 * ambiguous, stale-catalog, and unavailable-catalog stay distinguishable in the scan strip.
 */
async function handleBarcode(barcode: string): Promise<void> {
  await addByCode(barcode, null)
}

async function refreshCatalog(): Promise<void> {
  if (await bootstrap.runBootstrap()) {
    await catalog.initialize()
    console.log('Catalog refreshed successfully')
    if (catalog.status?.catalogValid && catalog.status.contract) {
      cart.setContract(catalog.status.contract)
    }
  }
}

async function prepareCartRebuild(): Promise<void> {
  const before = catalog.status
  if (!before?.catalogValid || !before.contract || cartState.value.kind !== 'invalid') {
    return
  }

  const token = cart.captureContext()
  const products: CatalogProduct[] = []
  for (const line of lines.value) {
    const product = await catalog.getProduct(line.product.uuid)
    if (!product) {
      rebuildError.value = t('pos.rebuildProductMissing')
      return
    }
    products.push(product)
  }

  const after = catalog.status
  if (
    !cart.isCurrentContext(token) ||
    !after?.catalogValid ||
    !after.contract ||
    after.contract.revision !== before.contract.revision
  ) {
    rebuildError.value = t('pos.rebuildCatalogChanged')
    return
  }

  rebuildError.value = null
  rebuildPreview.value = { token, revision: before.contract.revision, products }
  dialogMode.value = 'rebuild'
}

function confirmCartRebuild(): void {
  const preview = rebuildPreview.value
  const status = catalog.status
  if (
    !preview ||
    !cart.isCurrentContext(preview.token) ||
    !status?.catalogValid ||
    status.contract?.revision !== preview.revision
  ) {
    rebuildError.value = t('pos.rebuildCatalogChanged')
    dialogMode.value = null
    rebuildPreview.value = null
    return
  }

  if (cart.rebuildFromCatalog(preview.products)) {
    rebuildError.value = null
    dialogMode.value = null
    rebuildPreview.value = null
  }
}

useBarcodeScanner({ onScan: handleBarcode })
usePosShortcuts({
  focusSearch: () => searchRef.value?.focus(),
  showHelp: () => openDialog('help'),
  bindings: {
    F3: focusScanEntry,
    F4: () => handleQuickAction('hold'),
    F6: () => handleQuickAction('recall'),
    F7: () => handleQuickAction('customer'),
    F8: () => handleQuickAction('discount'),
    F9: handlePayShortcut
  }
})

// Payment lives in the checkout column now, so it folds away by itself once there is nothing left
// to pay for — but never while a committed sale is still waiting for the cashier's acknowledgment.
watch(
  () => [lines.value.length, attemptSettled.value] as const,
  ([lineCount, settled], previous) => {
    if (lineCount === 0 && settled && paymentPanelOpen.value) {
      paymentPanelOpen.value = false
    }

    if (settled && previous && !previous[1]) {
      focusScanEntry()
    }
  }
)

watch(query, () => {
  window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => void catalog.search(), 180)
})

watch(customerQuery, () => {
  window.clearTimeout(customerSearchTimer)
  customerSearchTimer = window.setTimeout(() => void catalog.searchCustomers(), 180)
})

watch(
  () => activeShiftUuid.value,
  (current, previous) => {
    if (previous !== undefined && current !== previous) {
      cart.resetDraft('shift-changed')
      payment.resetPayment()
      paymentPanelOpen.value = false
      pendingMultiplier.value = null
      lastAddedProductUuid.value = null
      scanResult.value = null
    }
  }
)

watch(
  () => catalogState.value?.contract,
  (nextContract) => {
    if (catalogState.value?.catalogValid && nextContract) {
      cart.setContract(nextContract)
    }
  },
  { immediate: true }
)

watch(
  () => catalogState.value?.catalogValid === true,
  (isValid) => cart.setCatalogValidity(isValid),
  { immediate: true }
)

onBeforeUnmount(() => {
  window.clearTimeout(searchTimer)
  window.clearTimeout(customerSearchTimer)
  window.clearTimeout(previewTimer)
  window.clearInterval(synchronizationAgeTimer)
  sync.dispose()
})

onMounted(async () => {
  synchronizationAgeTimer = window.setInterval(() => {
    synchronizationReferenceTime.value = Date.now()
  }, 60_000)
  await Promise.all([
    shift.loadCurrent(),
    catalog.initialize(),
    payment.discoverPending(),
    // Subscribes before its first read, so an upload finishing during startup is not missed.
    sync.initialize()
  ])

  if (catalog.status?.catalogValid && catalog.status.contract) {
    cart.setContract(catalog.status.contract)
  }
})
</script>

<template>
  <section class="pos-page">
    <SaleRecoveryBanner
      class="pos-page__recovery-banner"
      :blocking-attempt-key="blockingAttemptKey"
      :blocked-message="t('pos.payment.completion.blocked')"
      :retry-label="t('pos.payment.completion.retry')"
      :abandon-label="t('pos.payment.completion.abandon')"
      :unacknowledged-results="displayUnacknowledgedResults"
      :unacknowledged-message="t('pos.recovery.unacknowledgedPrefix')"
      :acknowledge-label="t('pos.payment.completion.acknowledge')"
      :abandon-warning="t('pos.payment.completion.abandonWarning')"
      :confirm-abandon-label="t('pos.payment.completion.confirmAbandon')"
      :cancel-confirm-label="t('common.cancel')"
      @retry="handleRetryAttempt"
      @abandon="handleAbandonAttempt"
      @acknowledge="handleAcknowledgeAttempt"
    />

    <PosWorkspaceShell>
      <template #toolbar>
        <div class="pos-page__heading">
          <div>
            <p class="pos-page__eyebrow">{{ t('pos.label') }}</p>
            <h2>{{ t('pos.title') }}</h2>
          </div>
          <div class="pos-page__status-row">
            <AppStatusChip :variant="catalogStatusVariant">
              {{ t(`pos.catalogStatus.${catalogStatus}`) }}
            </AppStatusChip>
            <span v-if="lastSyncedAt && lastSyncedRelative" class="pos-page__last-synced numeric">
              {{ t('pos.lastSyncedAt', { relative: lastSyncedRelative, absolute: lastSyncedAt }) }}
            </span>
            <AppStatusChip :variant="syncChipVariant">{{ syncChipLabel }}</AppStatusChip>
            <template v-if="freshness !== 'loading'">
              <template v-if="freshness === 'error'">
                <AppStatusChip variant="error">{{ t('pos.shiftUnavailable') }}</AppStatusChip>
                <AppButton variant="ghost" @click="shift.loadCurrent()">
                  {{ t('common.retry') }}
                </AppButton>
              </template>
              <ShiftStatusControl
                v-else
                :phase="shiftPhase"
                :phase-label="shiftPhaseLabel"
                :open-label="t('pos.openShift')"
                :pause-label="t('pos.pauseShift')"
                :resume-label="t('pos.resumeShift')"
                :close-label="t('pos.closeShift')"
                @open="openDialog('open')"
                @pause="openDialog('pause')"
                @resume="resumeShift"
                @close="openDialog('close')"
              />
            </template>
            <p
              v-if="currentShift?.status === 'closed' && currentShift.cashDifferenceAmount !== null"
              class="pos-page__variance numeric"
            >
              {{ t('pos.cashVariance') }}:
              {{ money(currentShift.cashDifferenceAmount) }}
            </p>
          </div>
        </div>
        <AppInlineError v-if="shiftError">{{ shiftError }}</AppInlineError>
        <p v-if="freshness === 'cached'" class="pos-page__cart-guard">
          {{ t('pos.shiftRefreshUnavailable') }}
        </p>
        <AppInlineError v-if="freshness === 'unknown'">{{
          t('pos.shiftUnknownHelp')
        }}</AppInlineError>
        <CatalogRefreshPanel
          :pending="catalogRefreshing"
          :stale="catalogStatus === 'stale'"
          :stale-message="t('pos.catalogStaleWarning')"
          :refresh-label="t('pos.catalogRefresh.action')"
          :pending-label="t('pos.catalogRefresh.pending')"
          :last-refreshed-label="catalogLastRefreshedLabel"
          :error-message="catalogRefreshError"
          :revision-changed-message="catalogRevisionChangedMessage"
          @refresh="handleRefreshCatalog"
        />
        <ProductSearchBar
          ref="searchRef"
          v-model="query"
          :label="t('pos.searchLabel')"
          :placeholder="t('pos.searchPlaceholder')"
          :disabled="!catalogAvailable"
          @submit="catalog.search()"
        />
        <CategorySelector
          :categories="categories.map((category) => ({ id: category.uuid, label: category.name }))"
          :selected-id="selectedCategoryUuid"
          :all-label="t('pos.allCategories')"
          @select="catalog.selectCategory"
        />
        <div class="pos-page__catalog-actions">
          <AppButton variant="ghost" :disabled="!catalogAvailable" @click="openDialog('customers')">
            {{ t('pos.browseCustomers') }}
          </AppButton>
          <AppButton
            variant="ghost"
            :disabled="!catalogAvailable"
            @click="openDialog('payment-methods')"
          >
            {{ t('pos.viewPaymentMethods') }}
          </AppButton>
        </div>
      </template>

      <template #catalog>
        <AppInlineError v-if="catalogError">{{ catalogError }}</AppInlineError>
        <AppInlineError v-if="bootstrapError">{{ bootstrapError }}</AppInlineError>
        <AppLoadingSkeleton v-if="catalogLoading" :label="t('pos.loadingCatalog')" :lines="6" />
        <AppEmptyState
          v-else-if="!catalogAvailable"
          :title="t('pos.catalogUnavailableTitle')"
          :description="t('pos.catalogUnavailableDescription')"
        >
          <template #action>
            <AppButton variant="secondary" :loading="isRefreshingCatalog" @click="refreshCatalog">
              {{ t('pos.refreshCatalog') }}
            </AppButton>
          </template>
        </AppEmptyState>
        <AppEmptyState
          v-else-if="products.length === 0"
          :title="t('pos.noProducts')"
          :description="t('pos.noProductsDescription')"
        />
        <div v-else class="pos-page__product-grid">
          <ProductCard
            v-for="product in products"
            :key="product.uuid"
            :product="{
              id: product.uuid,
              name: product.name,
              sku: product.sku ?? '—',
              price: money(product.price.amount, product.price.currency),
              stock: stock(product).level,
              categoryId: product.categoryUuid
            }"
            :stock-label="stock(product).label"
            :disabled="!canAddToCart"
            @select="addSelectedProduct(product.uuid)"
          />
        </div>
      </template>

      <template #cart>
        <div class="pos-page__cart-spine">
          <div class="pos-page__cart-heading">
            <div>
              <p class="pos-page__eyebrow">{{ t('pos.currentSale') }}</p>
              <h3>{{ t('pos.cartTitle') }}</h3>
            </div>
            <div class="pos-page__cart-badges">
              <AppStatusChip v-if="selectedCustomerLabel" variant="information">
                {{ selectedCustomerLabel }}
              </AppStatusChip>
              <AppStatusChip v-if="heldDrafts.length > 0" variant="warning">
                {{ t('pos.quickSale.heldCount', { count: heldDrafts.length }) }}
              </AppStatusChip>
            </div>
          </div>
          <ScanEntry
            ref="scanRef"
            v-model="scanText"
            :label="t('pos.quickSale.scanLabel')"
            :placeholder="t('pos.quickSale.scanPlaceholder')"
            :hint="t('pos.quickSale.scanHint')"
            :multiplier-label="t('pos.quickSale.multiplier')"
            :clear-multiplier-label="t('pos.quickSale.clearMultiplier')"
            :pending-multiplier="pendingMultiplier"
            :result="scanResult"
            :disabled="!canAddToCart"
            @submit="handleScanSubmit"
            @set-multiplier="pendingMultiplier = $event"
          />
          <QuickActionsBar
            :actions="quickActions"
            :label="t('pos.quickSale.actionsLabel')"
            @action="handleQuickAction"
          />
          <AppInlineError v-if="cartError">{{ cartError }}</AppInlineError>
          <p v-if="!canSell" class="pos-page__cart-guard">{{ t('pos.openShiftToSell') }}</p>
          <p v-if="cartState.kind === 'invalid'" class="pos-page__cart-guard">
            {{ t('pos.cartRequiresResolution') }}
          </p>
          <div
            v-if="cartState.kind === 'invalid' && catalogUsableForDraft"
            class="pos-page__rebuild-action"
          >
            <AppButton variant="secondary" @click="prepareCartRebuild">
              {{ t('pos.rebuildCart') }}
            </AppButton>
          </div>
          <CartPanel
            class="pos-page__cart-lines"
            :class="{ 'pos-page__cart-lines--paying': paymentPanelOpen }"
            :lines="cartDisplayLines"
            :empty-title="t('pos.emptyCart')"
            :empty-description="t('pos.emptyCartDescription')"
          >
            <CartLineItem
              v-for="line in cartDisplayLines"
              :key="line.id"
              :line="line"
              :decrease-label="t('pos.decreaseQuantity')"
              :increase-label="t('pos.increaseQuantity')"
              :remove-label="t('pos.removeLine')"
              :disabled="!canEdit || !attemptSettled"
              @decrease="cart.decrementQuantity(line.id)"
              @increase="cart.incrementQuantity(line.id)"
              @remove="cart.remove(line.id)"
            />
            <template v-if="!paymentPanelOpen" #footer>
              <OrderTotals
                :subtotal-label="t('pos.subtotal')"
                :subtotal="money(calculation?.subtotalAmount ?? 0)"
                :discount-label="t('pos.discount')"
                :discount="money(calculation?.discountTotalAmount ?? 0)"
                :tax-label="t('pos.tax')"
                :tax="money(calculation?.taxTotalAmount ?? 0)"
                :total-label="t('pos.total')"
                :total="money(calculation?.grandTotalAmount ?? 0)"
              />
              <AppButton
                class="pos-page__future-action"
                variant="transaction"
                full-width
                :disabled="!canOpenPaymentPanel"
                :aria-disabled="!canOpenPaymentPanel ? 'true' : undefined"
                :aria-keyshortcuts="'F9'"
                @click="openPaymentPanel"
              >
                {{ checkoutActionLabel }}
              </AppButton>
            </template>
          </CartPanel>
          <PaymentPanel
            inline
            class="pos-page__payment"
            :open="paymentPanelOpen"
            :title="t('pos.payment.title')"
            :status-chip-label="t('pos.payment.statusChip')"
            :subtotal-label="t('pos.subtotal')"
            :subtotal="money(calculation?.subtotalAmount ?? 0)"
            :discount-label="t('pos.discount')"
            :discount="money(calculation?.discountTotalAmount ?? 0)"
            :tax-label="t('pos.tax')"
            :tax="money(calculation?.taxTotalAmount ?? 0)"
            :total-label="t('pos.total')"
            :total="money(calculation?.grandTotalAmount ?? 0)"
            :method-options="paymentMethodOptions"
            :no-methods-title="t('pos.payment.noMethodsTitle')"
            :no-methods-description="t('pos.payment.noMethodsDescription')"
            :rows="paymentDisplayRows"
            :edit-row-label="t('pos.payment.editRow')"
            :remove-row-label="t('pos.payment.removeRow')"
            :is-editing-draft="isEditingDraft"
            :draft-method-label="activeMethod?.name"
            :draft-amount-label="t('pos.payment.amount')"
            :draft-amount="draftAmountText"
            :draft-amount-error="
              draftErrorCode ? t(`pos.payment.errors.${draftErrorCode}`) : undefined
            "
            :draft-reference-label="t('pos.payment.reference')"
            :draft-reference="draftReferenceText"
            :requires-reference="activeMethod?.requiresReference ?? false"
            :cancel-draft-label="t('common.cancel')"
            :commit-draft-label="t('pos.payment.addTender')"
            :paid-total-label="t('pos.payment.tendered')"
            :paid-total="paidTotalDisplay"
            :change-due-label="changeDueDisplay ? t('pos.payment.changeDue') : undefined"
            :change-due="changeDueDisplay"
            :due-label="dueDisplay ? t('pos.payment.dueAmount') : undefined"
            :due="dueDisplay"
            :preview-pending="previewPending"
            :preview-pending-label="t('pos.payment.validating')"
            :preview-message="previewMessage"
            :preview-is-error="previewIsError"
            :completion-label="t('pos.payment.completeSale')"
            :completion-enabled="completionEnabled"
            :completion-pending="completionPending"
            :completion-pending-label="t('pos.payment.completion.pending')"
            :completion-message="completionMessage"
            :completion-is-error="completionIsError"
            :completion-refresh-available="completionRefreshAvailable"
            :completion-refresh-pending="catalogRefreshing"
            :refresh-workstation-label="t('pos.catalogRefresh.action')"
            :recovery-state="paymentPanelRecoveryState"
            :retry-label="t('pos.payment.completion.retry')"
            :abandon-label="t('pos.payment.completion.abandon')"
            :acknowledge-label="t('pos.payment.completion.acknowledge')"
            :abandon-warning="t('pos.payment.completion.abandonWarning')"
            :confirm-abandon-label="t('pos.payment.completion.confirmAbandon')"
            :cancel-confirm-label="t('common.cancel')"
            :quick-tenders="quickTenders"
            :quick-tenders-label="t('pos.quickSale.quickCash')"
            @close="closePaymentPanel"
            @select-method="selectPaymentMethod"
            @edit-row="editPaymentRow"
            @remove-row="payment.removeRow"
            @update:draft-amount="payment.setDraftAmountText"
            @update:draft-reference="payment.setDraftReferenceText"
            @commit-draft="commitPaymentDraft"
            @cancel-draft="payment.cancelDraftRow"
            @complete="handleComplete"
            @quick-tender="handleQuickTender"
            @refresh-workstation="handleRefreshCatalog"
            @retry="handleRetryAttempt"
            @abandon="handleAbandonAttempt"
            @acknowledge="handleAcknowledgeAttempt"
          >
            <template #actions>
              <AppButton variant="ghost" @click="closePaymentPanel">{{
                t('pos.quickSale.backToCart')
              }}</AppButton>
            </template>
          </PaymentPanel>
        </div>
      </template>
    </PosWorkspaceShell>

    <AppDialog :open="dialogMode !== null" @close="dialogMode = null">
      <template #title>
        {{
          dialogMode === null
            ? ''
            : dialogMode === 'help'
              ? t('pos.shortcutsTitle')
              : dialogMode === 'customers'
                ? t('pos.customersTitle')
                : dialogMode === 'payment-methods'
                  ? t('pos.paymentMethodsTitle')
                  : t(`pos.dialog.${dialogMode}`)
        }}
      </template>
      <template v-if="dialogMode === 'help'">
        <dl class="pos-page__shortcuts">
          <div>
            <dt class="numeric">F1</dt>
            <dd>{{ t('pos.shortcutHelp') }}</dd>
          </div>
          <div>
            <dt class="numeric">F2</dt>
            <dd>{{ t('pos.shortcutSearch') }}</dd>
          </div>
          <div>
            <dt class="numeric">F3</dt>
            <dd>{{ t('pos.quickSale.shortcutScan') }}</dd>
          </div>
          <div>
            <dt class="numeric">F4</dt>
            <dd>{{ t('pos.quickSale.hold') }}</dd>
          </div>
          <div>
            <dt class="numeric">F6</dt>
            <dd>{{ t('pos.quickSale.recall') }}</dd>
          </div>
          <div>
            <dt class="numeric">F7</dt>
            <dd>{{ t('pos.quickSale.customer') }}</dd>
          </div>
          <div>
            <dt class="numeric">F8</dt>
            <dd>{{ t('pos.discount') }}</dd>
          </div>
          <div>
            <dt class="numeric">F9</dt>
            <dd>{{ t('pos.quickSale.shortcutPay') }}</dd>
          </div>
          <div>
            <dt class="numeric">3*</dt>
            <dd>{{ t('pos.quickSale.shortcutMultiplier') }}</dd>
          </div>
        </dl>
      </template>
      <template v-else-if="dialogMode === 'customers'">
        <CustomerSelector
          v-model:query="customerQuery"
          :results="
            customers.map((customer) => ({
              id: customer.uuid,
              name: customer.name,
              detail: customer.phone ?? undefined
            }))
          "
          :selected-id="selectedCustomerUuid"
          :search-label="t('pos.customerSearchLabel')"
          :empty-title="t('pos.noCustomers')"
          @select="
            (uuid) => {
              catalog.selectCustomer(uuid)
              dialogMode = null
            }
          "
        />
      </template>
      <template v-else-if="dialogMode === 'held'">
        <HeldSalesList
          :sales="heldSalesDisplay"
          :empty-title="t('pos.quickSale.noHeld')"
          :note="t('pos.quickSale.heldNote')"
          :recall-label="t('pos.quickSale.recall')"
          :discard-label="t('pos.quickSale.discard')"
          @recall="recallHeldSale"
          @discard="discardHeldSale"
        />
      </template>
      <template v-else-if="dialogMode === 'payment-methods'">
        <p class="pos-page__read-only-note">{{ t('pos.paymentMethodsReadOnly') }}</p>
        <div class="pos-page__payment-methods">
          <PaymentMethodTile
            v-for="method in paymentMethods"
            :key="method.uuid"
            :method="{ id: method.uuid, kind: paymentMethodKind(method.type), label: method.name }"
            disabled
          />
        </div>
        <AppEmptyState
          v-if="paymentMethods.length === 0"
          :title="t('pos.noPaymentMethods')"
          :description="t('pos.paymentMethodsReadOnly')"
        />
      </template>
      <template v-else-if="dialogMode === 'rebuild'">
        <p class="pos-page__read-only-note">{{ t('pos.rebuildDescription') }}</p>
        <AppInlineError v-if="rebuildError">{{ rebuildError }}</AppInlineError>
        <dl v-if="rebuildPreviewRows.length > 0" class="pos-page__rebuild-preview">
          <div v-for="row in rebuildPreviewRows" :key="row.id">
            <dt>{{ row.name }}</dt>
            <dd class="numeric">
              {{ row.oldPrice }} → {{ row.newPrice }}
              <span v-if="row.taxChanged"> · {{ t('pos.rebuildTaxChanged') }}</span>
            </dd>
          </div>
        </dl>
        <p v-else class="pos-page__read-only-note">{{ t('pos.rebuildNoChanges') }}</p>
      </template>
      <template v-else-if="dialogMode === 'discount'">
        <AppSelect
          v-model="invoiceDiscountSelection"
          :label="t('pos.discountType')"
          :options="[
            { value: 'none', label: t('pos.discountNone') },
            { value: 'fixed', label: t('pos.discountFixed') },
            { value: 'percentage', label: t('pos.discountPercentage') }
          ]"
          @update:model-value="invoiceDiscountError = null"
        />
        <AppInput
          v-if="invoiceDiscountSelection !== 'none'"
          v-model="invoiceDiscountDraft"
          :label="
            invoiceDiscountSelection === 'fixed'
              ? t('pos.discountAmount')
              : t('pos.discountPercent')
          "
          :error="invoiceDiscountError ?? undefined"
          @blur="applyInvoiceDiscount"
          @keydown="handleInvoiceDiscountKeydown"
        />
      </template>
      <template v-else>
        <AppInput
          v-if="dialogMode !== 'pause'"
          v-model="cashAmount"
          :label="dialogMode === 'open' ? t('pos.openingCash') : t('pos.actualCash')"
          :error="cashError ?? undefined"
        />
        <AppInput v-model="note" :label="t('pos.notes')" />
      </template>
      <template #actions>
        <AppButton variant="ghost" @click="dialogMode = null">{{ t('common.cancel') }}</AppButton>
        <AppButton
          v-if="
            dialogMode !== 'help' &&
            dialogMode !== 'customers' &&
            dialogMode !== 'payment-methods' &&
            dialogMode !== 'held'
          "
          variant="secondary"
          :loading="dialogMode === 'rebuild' ? false : mutation !== null"
          @click="
            dialogMode === 'rebuild'
              ? confirmCartRebuild()
              : dialogMode === 'discount'
                ? commitInvoiceDiscount()
                : submitDialog()
          "
        >
          {{
            dialogMode === 'rebuild'
              ? t('pos.rebuildCart')
              : dialogMode === 'discount'
                ? t('pos.applyDiscount')
                : t('common.confirm')
          }}
        </AppButton>
      </template>
    </AppDialog>
  </section>
</template>

<style scoped>
.pos-page {
  block-size: calc(100vh - 11rem);
  min-block-size: 34rem;
}

.pos-page__recovery-banner {
  margin-block-end: var(--space-3);
}

.pos-page__heading,
.pos-page__status-row,
.pos-page__cart-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
}

.pos-page__catalog-actions,
.pos-page__payment-methods {
  display: flex;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.pos-page__payment-methods {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
}

.pos-page__last-synced,
.pos-page__read-only-note {
  color: var(--color-on-surface-variant);
  font-size: var(--text-body-sm-size);
}

.pos-page__heading h2 {
  font-size: var(--text-display-md-size);
  line-height: var(--text-display-md-line);
}

.pos-page__eyebrow {
  color: var(--color-text-muted);
  font-size: var(--text-label-caps-size);
  font-weight: var(--text-label-caps-weight);
  letter-spacing: var(--text-label-caps-tracking);
  text-transform: uppercase;
}

html[dir='rtl'] .pos-page__eyebrow {
  text-transform: none;
}

.pos-page__product-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
  gap: var(--space-3);
  padding-block-end: var(--space-4);
}

.pos-page__cart-spine {
  display: flex;
  flex-direction: column;
  block-size: 100%;
  min-block-size: 0;
  overflow-y: auto;
  border: 1px solid var(--color-outline-variant);
  border-inline-start: 4px solid var(--color-transaction-accent);
  border-radius: var(--radius-lg);
  background: var(--color-surface-container-lowest);
}

.pos-page__cart-heading {
  padding: var(--space-4);
  border-block-end: 1px solid var(--color-divider-subtle);
}

.pos-page__cart-badges {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.pos-page__cart-lines {
  flex: 1 1 auto;
  min-block-size: 8rem;
}

.pos-page__cart-lines--paying {
  flex: 0 1 12rem;
}

.pos-page__payment {
  flex: none;
}

.pos-page__cart-heading h3 {
  font-size: var(--text-headline-sm-size);
}

.pos-page__cart-guard {
  padding: var(--space-3) var(--space-4);
  background: var(--color-warning-container);
  color: var(--color-on-warning-container);
  font-size: var(--text-body-sm-size);
  font-weight: 600;
}

.pos-page__variance {
  color: var(--color-on-surface-variant);
  font-size: var(--text-body-sm-size);
  font-weight: 600;
}

.pos-page__future-action {
  margin-block-start: var(--space-4);
}

.pos-page__rebuild-action {
  padding: var(--space-3) var(--space-4);
  border-block-end: 1px solid var(--color-divider-subtle);
}

.pos-page__rebuild-preview {
  display: grid;
  gap: var(--space-2);
}

.pos-page__rebuild-preview div {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  padding-block: var(--space-2);
  border-block-end: 1px solid var(--color-divider-subtle);
}

.pos-page__rebuild-preview dt {
  color: var(--color-on-surface);
  font-weight: 600;
}

.pos-page__shortcuts {
  display: grid;
  gap: var(--space-2);
}

.pos-page__shortcuts div {
  display: grid;
  grid-template-columns: 3rem 1fr;
  gap: var(--space-3);
  padding-block: var(--space-2);
  border-block-end: 1px solid var(--color-divider-subtle);
}

@media (max-width: 1200px) {
  .pos-page {
    block-size: auto;
    min-block-size: 38rem;
  }
}
</style>
