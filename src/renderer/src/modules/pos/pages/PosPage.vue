<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import type { CatalogProduct, PaymentMethodType } from '@shared/contracts/catalog.contract'
import type { CheckoutIntent } from '@shared/contracts/checkout.contract'
import type { LocaleCode } from '@shared/contracts/preferences.contract'
import type {
  DisplayPaymentMethodOption,
  DisplayProduct,
  DisplayRecoveryResult,
  DisplaySplitPayment,
  PaymentPanelRecoveryState,
  ShiftPhase
} from '@renderer/shared/components/pos/types'
import { useBootstrapStore } from '@renderer/modules/bootstrap/store'
import { useSyncStore } from '@renderer/modules/sync/store'
import { useLocaleStore } from '@renderer/modules/preferences/locale.store'
import { formatDateTime, formatNumber, formatRelativeDateTime } from '@renderer/shared/utils/format'
import {
  formatMinorCurrency,
  parseMinorCurrencyInput,
  parsePercentageBasisPointsInput
} from '@shared/money/minorUnits'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppConfirmDialog from '@renderer/shared/components/common/AppConfirmDialog.vue'
import AppDialog from '@renderer/shared/components/common/AppDialog.vue'
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import AppIconButton from '@renderer/shared/components/common/AppIconButton.vue'
import AppKbd from '@renderer/shared/components/common/AppKbd.vue'
import AppBanner from '@renderer/shared/components/feedback/AppBanner.vue'
import AppEmptyState from '@renderer/shared/components/feedback/AppEmptyState.vue'
import AppInlineError from '@renderer/shared/components/feedback/AppInlineError.vue'
import AppLoadingSkeleton from '@renderer/shared/components/feedback/AppLoadingSkeleton.vue'
import AppInput from '@renderer/shared/components/forms/AppInput.vue'
import AppSegmented from '@renderer/shared/components/forms/AppSegmented.vue'
import AppSelect from '@renderer/shared/components/forms/AppSelect.vue'
import BarcodeFeedback from '@renderer/shared/components/pos/BarcodeFeedback.vue'
import CartLineItem from '@renderer/shared/components/pos/CartLineItem.vue'
import CatalogRefreshPanel from '@renderer/shared/components/pos/CatalogRefreshPanel.vue'
import CartPanel from '@renderer/shared/components/pos/CartPanel.vue'
import CategorySelector from '@renderer/shared/components/pos/CategorySelector.vue'
import OrderTotals from '@renderer/shared/components/pos/OrderTotals.vue'
import PosWorkspaceShell from '@renderer/shared/components/pos/PosWorkspaceShell.vue'
import ProductCard from '@renderer/shared/components/pos/ProductCard.vue'
import ProductSearchBar from '@renderer/shared/components/pos/ProductSearchBar.vue'
import CustomerSelector from '@renderer/shared/components/pos/CustomerSelector.vue'
import PaymentPanel from '@renderer/shared/components/pos/PaymentPanel.vue'
import SaleRecoveryBanner from '@renderer/shared/components/pos/SaleRecoveryBanner.vue'
import ReceiptPreviewDialog from '@renderer/modules/printing/components/ReceiptPreviewDialog.vue'
import type { ReceiptDocumentRef } from '@shared/contracts/printing.contract'
import { useCartStore } from '../cart.store'
import { CATALOG_PAGE_SIZES, type CatalogPageSize, useCatalogStore } from '../catalog.store'
import { usePaymentStore } from '../payment.store'
import { useShiftStore } from '../shift.store'
import { useShiftDialogStore } from '../shiftDialog.store'
import { useBarcodeScanner } from '../useBarcodeScanner'
import { usePosShortcuts } from '../usePosShortcuts'

type DialogMode = 'help' | 'customers' | 'rebuild' | 'discount' | null

type InvoiceDiscountSelection = 'none' | 'fixed' | 'percentage'

const { t, te } = useI18n()
const localeStore = useLocaleStore()
const bootstrap = useBootstrapStore()
const catalog = useCatalogStore()
const cart = useCartStore()
const shift = useShiftStore()
const payment = usePaymentStore()
const sync = useSyncStore()
const shiftDialog = useShiftDialogStore()
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
  refreshError: catalogRefreshError,
  total: catalogTotal,
  page: catalogPage,
  pageSize: catalogPageSize,
  pageCount: catalogPageCount
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
  draftRevision: cartDraftRevision
} = storeToRefs(cart)
const {
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
const clearConfirmOpen = ref(false)
const cartSheetOpen = ref(false)
const invoiceDiscountSelection = ref<InvoiceDiscountSelection>('none')
const invoiceDiscountDraft = ref('')
const invoiceDiscountError = ref<string | null>(null)
const rebuildError = ref<string | null>(null)
const rebuildPreview = ref<{
  readonly token: string
  readonly revision: string
  readonly products: readonly CatalogProduct[]
} | null>(null)
const lastBarcode = ref<{
  code: string
  outcome: 'found' | 'not-found' | 'ambiguous' | 'stale-catalog' | 'unavailable-catalog'
} | null>(null)
const pageSizeOptions = CATALOG_PAGE_SIZES.map((size) => ({
  value: String(size),
  label: String(size)
}))
const paymentPanelOpen = ref(false)
let searchTimer: number | undefined
let customerSearchTimer: number | undefined
let previewTimer: number | undefined
let synchronizationAgeTimer: number | undefined
const synchronizationReferenceTime = ref(Date.now())

const activeCurrency = computed(() => cartContract.value?.currency ?? 'EGP')
const currencyExponent = computed(() => cartContract.value?.currencyExponent ?? 2)
const shiftPhase = computed<ShiftPhase>(() => mutation.value ?? observedStatus.value ?? 'closed')
const catalogStatus = computed(() => catalogState.value?.status ?? 'unavailable')
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
/** V3 catalog status line: freshness + when this workstation last synchronized its catalog. */
const catalogLine = computed<{ label: string; tone: 'ok' | 'muted' | 'warn' } | null>(() => {
  if (catalogStatus.value === 'unavailable') {
    return null
  }
  const tone =
    catalogStatus.value === 'fresh' ? 'ok' : catalogStatus.value === 'stale' ? 'warn' : 'muted'
  const relative = lastSyncedRelative.value
  return {
    tone,
    label: relative
      ? t(`pos.catalogLine.${catalogStatus.value}`, { relative })
      : t('pos.catalogLine.unknown')
  }
})
const cartItemCount = computed(() =>
  lines.value.reduce((sum, line) => sum + Number.parseFloat(line.quantity), 0)
)
const cartItemsLabel = computed(() =>
  cartItemCount.value === 1
    ? t('pos.cart.item1')
    : t('pos.cart.items', {
        count: formatNumber(cartItemCount.value, localeStore.locale as LocaleCode, {
          maximumFractionDigits: 3
        })
      })
)
const selectedCustomerName = computed(() => {
  if (!selectedCustomerUuid.value) {
    return t('pos.cart.walkIn')
  }
  return (
    customers.value.find((customer) => customer.uuid === selectedCustomerUuid.value)?.name ??
    t('pos.cart.selectedCustomer')
  )
})
/** Category position → pastel tone (All is 0; categories cycle 1…5, 0). Never a status. */
const categoryTone = computed(
  () => new Map(categories.value.map((category, index) => [category.uuid, (index + 1) % 6]))
)
const displayCategories = computed(() =>
  categories.value.map((category) => ({
    id: category.uuid,
    label: category.name,
    tone: categoryTone.value.get(category.uuid)
  }))
)
const inCartQuantity = computed(() => {
  const totals = new Map<string, number>()
  for (const line of lines.value) {
    totals.set(
      line.product.uuid,
      (totals.get(line.product.uuid) ?? 0) + Number.parseFloat(line.quantity)
    )
  }
  return totals
})
const paginationRange = computed(() => {
  if (catalogTotal.value === 0) {
    return ''
  }
  const from = catalogPage.value * catalogPageSize.value + 1
  const to = Math.min(catalogTotal.value, from + products.value.length - 1)
  const locale = localeStore.locale as LocaleCode
  return t('pos.pagination.range', {
    from: formatNumber(from, locale),
    to: formatNumber(to, locale),
    total: formatNumber(catalogTotal.value, locale)
  })
})

function monogram(name: string): string {
  const words = name.split(/[\s\-—–·/]+/u).filter(Boolean)
  const letters =
    words.length >= 2 ? [words[0][0], words[1][0]] : Array.from(words[0] ?? '').slice(0, 2)
  return letters.join('').toLocaleUpperCase()
}

function displayProduct(product: CatalogProduct): DisplayProduct {
  const price = money(product.price.amount, product.price.currency)
  const quantity = inCartQuantity.value.get(product.uuid)
  return {
    id: product.uuid,
    name: product.name,
    sku: product.sku ?? '—',
    price,
    stock: stock(product).level,
    categoryId: product.categoryUuid,
    unit: product.unit ?? undefined,
    monogram: monogram(product.name),
    tone: product.categoryUuid ? (categoryTone.value.get(product.categoryUuid) ?? 0) : 0,
    inCartQuantity: quantity
      ? formatNumber(quantity, localeStore.locale as LocaleCode, { maximumFractionDigits: 3 })
      : undefined,
    ariaLabel: t('pos.addToCart', { name: product.name, price })
  }
}

function changePageSize(value: string): void {
  void catalog.setPageSize(Number(value) as CatalogPageSize)
}

function clearSearch(): void {
  query.value = ''
}

function openCustomerDialog(): void {
  dialogMode.value = 'customers'
}

function useWalkInCustomer(): void {
  catalog.selectCustomer(null)
  dialogMode.value = null
}

function confirmClearCart(): void {
  cart.clear()
  clearConfirmOpen.value = false
}

const cartDisplayLines = computed(() =>
  lines.value.map((line, index) => ({
    id: line.id,
    name: line.product.name,
    sku: line.product.sku ?? '—',
    quantity: Number.parseFloat(line.quantity),
    unitPrice: money(line.product.price.amount, line.product.price.currency),
    eachLabel: t('pos.cart.each', {
      price: money(line.product.price.amount, line.product.price.currency)
    }),
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

  return t('pos.cart.pay', { amount: money(calculation.value?.grandTotalAmount ?? 0) })
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

/**
 * The amount the tender field can be pre-filled with: the validated preview's amount due, or — before
 * any tender is added — the cart's own grand total. Both are values the page already holds; no new
 * money arithmetic happens here.
 */
const fillDueAmount = computed<number | null>(() => {
  const outcome = previewOutcome.value
  if (outcome?.outcome === 'valid' && outcome.dueAmount > 0) {
    return outcome.dueAmount
  }
  return paymentRows.value.length === 0 ? (calculation.value?.grandTotalAmount ?? null) : null
})

function fillDue(): void {
  if (fillDueAmount.value !== null) {
    payment.setDraftAmountText(
      (fillDueAmount.value / 10 ** currencyExponent.value).toFixed(currencyExponent.value)
    )
  }
}

const completedTotal = computed(() => {
  const outcome = completionOutcome.value
  return outcome && (outcome.outcome === 'committed' || outcome.outcome === 'acknowledged')
    ? money(outcome.invoice.grandTotalAmount)
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
  if (!key) {
    return
  }
  // "New sale" (V3): acknowledging the payment panel's own committed sale ends that sale, so the
  // panel closes and the cashier is back on the catalog. Acknowledging an unrelated recovery-banner
  // result leaves whatever the cashier is doing untouched.
  const outcome = completionOutcome.value
  const panelOwnsAttempt =
    paymentPanelOpen.value &&
    (outcome?.outcome === 'committed' || outcome?.outcome === 'acknowledged') &&
    outcome.attemptKey === key
  void payment.acknowledgeAttempt(key).then((result) => {
    if (panelOwnsAttempt && result.outcome === 'acknowledged') {
      paymentPanelOpen.value = false
    }
  })
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

const receiptDialogOpen = ref(false)
const receiptDocument = ref<ReceiptDocumentRef | null>(null)

function handlePrintReceipt(): void {
  const outcome = completionOutcome.value
  if (!outcome || (outcome.outcome !== 'committed' && outcome.outcome !== 'acknowledged')) {
    return
  }

  receiptDocument.value = { kind: 'sale', invoiceLocalUuid: outcome.invoice.localUuid }
  receiptDialogOpen.value = true
}

function closeReceiptDialog(): void {
  receiptDialogOpen.value = false
}

function selectPaymentMethod(methodId: string): void {
  payment.beginAddRow(methodId)
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

  const count = formatNumber(quantity, localeStore.locale as LocaleCode, {
    maximumFractionDigits: 3
  })

  if (quantity <= 5) {
    return { level: 'low-stock', label: t('pos.stock.lowStockCount', { count }) }
  }

  return { level: 'in-stock', label: t('pos.stock.inStockCount', { count }) }
}

async function addSelectedProduct(uuid: string): Promise<void> {
  if (canSell.value && catalogUsableForDraft.value) {
    const currentProduct = await catalog.getProduct(uuid)

    if (currentProduct) {
      cart.addProduct(currentProduct)
    }
  }
}

function openDialog(mode: Exclude<DialogMode, null>): void {
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

/** The paused-shift notice resumes directly, exactly as the shell's shift menu does. */
async function resumeShift(): Promise<void> {
  if (activeShiftUuid.value) {
    await shift.resume({ uuid: activeShiftUuid.value, resumeNotes: null })
  }
}

async function handleBarcode(barcode: string): Promise<void> {
  const result = await catalog.findProductByBarcode(barcode)

  if (result.outcome === 'found' && canSell.value && catalogUsableForDraft.value) {
    cart.addProduct(result.product)
  }

  // The scan outcome is always reported: Phase 3C must still distinguish found, not-found,
  // ambiguous, stale-catalog, and unavailable-catalog without building a draft line.
  lastBarcode.value = { code: barcode, outcome: result.outcome }
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
  showHelp: () => openDialog('help')
})

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
      cartSheetOpen.value = false
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
  <section class="pos-page flex min-h-0 flex-1 flex-col">
    <h1 class="sr-only">{{ t('navigation.pos') }}</h1>
    <SaleRecoveryBanner
      class="pos-page__recovery-banner mx-3 mt-3 wide:mx-4 wide:mt-4"
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

    <PosWorkspaceShell
      :sheet-open="cartSheetOpen"
      :catalog-label="t('pos.catalogLabel')"
      :cart-label="t('pos.cart.title')"
    >
      <template #catalog>
        <CategorySelector
          class="wide:hidden"
          compact
          :categories="displayCategories"
          :selected-id="selectedCategoryUuid"
          :all-label="t('pos.allCategories')"
          :group-label="t('pos.categoriesLabel')"
          @select="catalog.selectCategory"
        />
        <CategorySelector
          class="hidden wide:flex"
          :categories="displayCategories"
          :selected-id="selectedCategoryUuid"
          :all-label="t('pos.allCategories')"
          :group-label="t('pos.categoriesLabel')"
          @select="catalog.selectCategory"
        />
        <ProductSearchBar
          ref="searchRef"
          v-model="query"
          :label="t('pos.search.label')"
          :placeholder="t('pos.search.placeholder')"
          :clear-label="t('pos.search.clear')"
          :disabled="!catalogAvailable"
          @submit="catalog.search()"
        />
        <CatalogRefreshPanel
          :pending="catalogRefreshing"
          :stale="catalogStatus === 'stale'"
          :stale-message="t('pos.catalogStaleWarning')"
          :refresh-label="t('pos.catalogRefresh.action')"
          :pending-label="t('pos.catalogRefresh.pending')"
          :last-refreshed-label="catalogLastRefreshedLabel"
          :error-message="catalogRefreshError"
          :revision-changed-message="catalogRevisionChangedMessage"
          :status-label="catalogLine?.label ?? null"
          :status-tone="catalogLine?.tone ?? 'muted'"
          :refresh-note="t('pos.catalogLine.refreshNote')"
          @refresh="handleRefreshCatalog"
        >
          <template v-if="cartState.kind === 'invalid' && catalogUsableForDraft" #revision-action>
            <AppButton variant="secondary" size="sm" @click="prepareCartRebuild">
              {{ t('pos.notices.reviewRebuild') }}
            </AppButton>
          </template>
        </CatalogRefreshPanel>

        <!-- Shift state that limits selling (the lifecycle actions live in the top-bar menu). -->
        <template v-if="freshness !== 'loading'">
          <AppBanner
            v-if="freshness === 'error'"
            variant="warning"
            icon="lock_clock"
            role="alert"
            :title="t('pos.shiftUnavailable')"
          >
            <template #action>
              <AppButton variant="secondary" size="sm" icon="refresh" @click="shift.loadCurrent()">
                {{ t('common.retry') }}
              </AppButton>
            </template>
          </AppBanner>
          <AppBanner
            v-else-if="freshness === 'unknown'"
            variant="warning"
            icon="help"
            role="alert"
            :title="t('pos.shiftUnknownHelp')"
          >
            <template #action>
              <AppButton variant="secondary" size="sm" icon="refresh" @click="shift.loadCurrent()">
                {{ t('shell.shift.refreshStatus') }}
              </AppButton>
            </template>
          </AppBanner>
          <AppBanner
            v-else-if="freshness === 'cached'"
            variant="info"
            icon="history"
            :title="t('pos.shiftRefreshUnavailable')"
          />
          <AppBanner
            v-else-if="shiftPhase === 'paused' || shiftPhase === 'resuming'"
            variant="warning"
            icon="pause_circle"
            :title="t('pos.notices.paused')"
          >
            <template #action>
              <AppButton
                variant="secondary"
                size="sm"
                :loading="shiftPhase === 'resuming'"
                @click="resumeShift"
              >
                {{ t('pos.resumeShift') }}
              </AppButton>
            </template>
          </AppBanner>
          <AppBanner
            v-else-if="!canSell"
            variant="info"
            icon="lock_clock"
            :title="t('pos.notices.browseOnly')"
          >
            <template v-if="shiftPhase === 'closed' || shiftPhase === 'cancelled'" #action>
              <AppButton variant="secondary" size="sm" @click="shiftDialog.request('open')">
                {{ t('pos.openShift') }}
              </AppButton>
            </template>
          </AppBanner>
        </template>
        <AppInlineError v-if="shiftError">{{ shiftError }}</AppInlineError>

        <BarcodeFeedback
          v-if="lastBarcode"
          :outcome="lastBarcode.outcome"
          :code="lastBarcode.code"
          :hint="
            lastBarcode.outcome === 'not-found' ? t('pos.notices.barcodeUnknownHint') : undefined
          "
          :dismiss-label="t('pos.notices.dismiss')"
          @dismiss="lastBarcode = null"
        >
          {{ t(`pos.barcode.${lastBarcode.outcome}`) }}
        </BarcodeFeedback>
        <AppInlineError v-if="catalogError">{{ catalogError }}</AppInlineError>
        <AppInlineError v-if="bootstrapError">{{ bootstrapError }}</AppInlineError>

        <div class="min-h-0 flex-1 overflow-auto p-0.5">
          <AppLoadingSkeleton v-if="catalogLoading" :label="t('pos.loadingCatalog')" :lines="6" />
          <AppEmptyState
            v-else-if="!catalogAvailable"
            icon="gpp_bad"
            :title="t('pos.catalogUnavailableTitle')"
            :description="t('pos.catalogUnavailableDescription')"
          >
            <template #action>
              <AppButton
                variant="secondary"
                icon="refresh"
                :loading="isRefreshingCatalog"
                @click="refreshCatalog"
              >
                {{ t('pos.refreshCatalog') }}
              </AppButton>
            </template>
          </AppEmptyState>
          <AppEmptyState
            v-else-if="products.length === 0"
            icon="search_off"
            :title="t('pos.noProducts')"
            :description="t('pos.noProductsDescription')"
          >
            <template v-if="query" #action>
              <AppButton variant="secondary" @click="clearSearch">{{
                t('pos.search.clear')
              }}</AppButton>
            </template>
          </AppEmptyState>
          <div
            v-else
            class="pos-page__product-grid grid grid-cols-2 gap-3 wide:grid-cols-[repeat(auto-fill,minmax(176px,1fr))]"
          >
            <ProductCard
              v-for="product in products"
              :key="product.uuid"
              :product="displayProduct(product)"
              :stock-label="stock(product).label"
              :disabled="!canSell || !catalogUsableForDraft"
              @select="addSelectedProduct(product.uuid)"
            />
          </div>
        </div>

        <div
          v-if="catalogAvailable && catalogTotal > 0"
          class="pos-page__pagination flex flex-none flex-wrap items-center gap-2.5 border-t border-line pt-3"
        >
          <AppSelect
            :model-value="String(catalogPageSize)"
            :label="t('pos.pagination.perPage')"
            :options="pageSizeOptions"
            size="sm"
            inline
            @update:model-value="changePageSize"
          />
          <div class="flex-1" />
          <span class="numeric text-sm">{{ paginationRange }}</span>
          <div class="flex gap-1">
            <AppIconButton
              variant="outline"
              icon="first_page"
              mirror-icon
              :label="t('pos.pagination.first')"
              :disabled="catalogPage === 0 || catalogLoading"
              @click="catalog.goToPage(0)"
            />
            <AppIconButton
              variant="outline"
              icon="chevron_left"
              mirror-icon
              :label="t('pos.pagination.previous')"
              :disabled="catalogPage === 0 || catalogLoading"
              @click="catalog.goToPage(catalogPage - 1)"
            />
            <AppIconButton
              variant="outline"
              icon="chevron_right"
              mirror-icon
              :label="t('pos.pagination.next')"
              :disabled="catalogPage >= catalogPageCount - 1 || catalogLoading"
              @click="catalog.goToPage(catalogPage + 1)"
            />
            <AppIconButton
              variant="outline"
              icon="last_page"
              mirror-icon
              :label="t('pos.pagination.last')"
              :disabled="catalogPage >= catalogPageCount - 1 || catalogLoading"
              @click="catalog.goToPage(catalogPageCount - 1)"
            />
          </div>
        </div>
      </template>

      <template #cart>
        <div class="pos-page__cart-spine flex min-h-0 flex-1 flex-col">
          <div class="flex flex-none items-center gap-2.5 px-4 pt-4 pb-3">
            <AppIconButton
              v-if="cartSheetOpen"
              variant="outline"
              icon="close"
              :label="t('pos.cart.closeCart')"
              @click="cartSheetOpen = false"
            />
            <h2 class="text-2xl font-bold">{{ t('pos.cart.title') }}</h2>
            <span
              class="numeric flex min-h-6.5 items-center rounded-full bg-pri-soft px-2.5 py-0.5 text-xs font-semibold text-pri-text"
              >{{ cartItemsLabel }}</span
            >
            <div class="flex-1" />
            <AppButton
              variant="secondary"
              size="sm"
              :disabled="lines.length === 0"
              @click="clearConfirmOpen = true"
            >
              {{ t('pos.cart.clear') }}
            </AppButton>
          </div>

          <div
            class="mx-4 flex flex-none flex-wrap items-center gap-2.5 rounded-notice border border-line px-3 py-2.5"
          >
            <AppIcon name="person" :size="20" class="text-muted" />
            <p class="min-w-0 flex-1 text-sm leading-[1.35]">
              <span class="whitespace-nowrap text-muted">{{ t('pos.cart.customer') }}: </span>
              <span class="font-semibold">{{ selectedCustomerName }}</span>
            </p>
            <AppButton
              variant="ghost"
              size="sm"
              class="px-1.5 text-pri-text"
              :disabled="!catalogAvailable"
              @click="openCustomerDialog"
            >
              {{ selectedCustomerUuid ? t('pos.cart.change') : t('pos.cart.choose') }}
            </AppButton>
          </div>

          <div class="flex flex-none flex-col gap-2 px-4 pt-2 empty:hidden">
            <AppInlineError v-if="cartError">{{ cartError }}</AppInlineError>
            <p v-if="!canSell && lines.length > 0" class="pos-page__cart-guard text-sm text-muted">
              {{ t('pos.openShiftToSell') }}
            </p>
            <AppBanner
              v-if="cartState.kind === 'invalid'"
              variant="warning"
              icon="published_with_changes"
            >
              {{ t('pos.cartRequiresResolution') }}
              <template v-if="catalogUsableForDraft" #action>
                <AppButton variant="secondary" size="sm" @click="prepareCartRebuild">
                  {{ t('pos.rebuildCart') }}
                </AppButton>
              </template>
            </AppBanner>
            <AppInlineError v-if="rebuildError && dialogMode !== 'rebuild'">{{
              rebuildError
            }}</AppInlineError>
          </div>

          <div
            class="mx-4 grid flex-none grid-cols-[minmax(0,1fr)_7rem_minmax(84px,auto)] gap-2.5 border-b border-line pt-3 pb-1.5 text-xs font-semibold text-muted"
            aria-hidden="true"
          >
            <span>{{ t('pos.cart.colItem') }}</span>
            <span class="text-center">{{ t('pos.cart.colQty') }}</span>
            <span class="text-end">{{ t('pos.cart.colAmount') }}</span>
          </div>

          <CartPanel
            :lines="cartDisplayLines"
            :empty-title="t('pos.emptyCart')"
            :empty-description="
              shiftPhase === 'paused'
                ? t('pos.notices.paused')
                : !canSell
                  ? t('pos.openShiftToSell')
                  : t('pos.cart.emptyBody')
            "
            :empty-icon="
              shiftPhase === 'paused' ? 'pause_circle' : !canSell ? 'lock_clock' : 'shopping_cart'
            "
          >
            <CartLineItem
              v-for="line in cartDisplayLines"
              :key="line.id"
              :line="line"
              :decrease-label="t('pos.cart.decreaseOf', { name: line.name })"
              :increase-label="t('pos.cart.increaseOf', { name: line.name })"
              :remove-label="t('pos.cart.removeOf', { name: line.name })"
              :quantity-label="t('pos.cart.quantityOf', { name: line.name })"
              :disabled="!canEdit"
              @decrease="cart.decrementQuantity(line.id)"
              @increase="cart.incrementQuantity(line.id)"
              @remove="cart.remove(line.id)"
            />
            <template #footer>
              <OrderTotals
                class="mx-4 mt-3"
                framed
                :subtotal-label="t('pos.subtotal')"
                :subtotal="money(calculation?.subtotalAmount ?? 0)"
                :discount-label="
                  invoiceDiscountType === 'percentage'
                    ? t('pos.cart.discountPercent', {
                        rate: formatNumber(
                          invoiceDiscountValue / 100,
                          localeStore.locale as LocaleCode,
                          {
                            maximumFractionDigits: 2
                          }
                        )
                      })
                    : t('pos.discount')
                "
                :discount="
                  (calculation?.discountTotalAmount ?? 0) > 0
                    ? money(calculation?.discountTotalAmount ?? 0)
                    : undefined
                "
                :tax-label="t('pos.tax')"
                :tax="money(calculation?.taxTotalAmount ?? 0)"
                :total-label="t('pos.cart.totalDue')"
                :total="money(calculation?.grandTotalAmount ?? 0)"
              >
                <template #discount-action>
                  <button
                    type="button"
                    class="flex items-center gap-1 py-1 text-sm font-semibold text-pri-text disabled:cursor-not-allowed disabled:text-muted"
                    :disabled="lines.length === 0 || !canEdit"
                    @click="openInvoiceDiscountDialog"
                  >
                    <AppIcon
                      v-if="(calculation?.discountTotalAmount ?? 0) === 0"
                      name="sell"
                      :size="18"
                    />
                    {{
                      (calculation?.discountTotalAmount ?? 0) > 0
                        ? t('pos.cart.editDiscount')
                        : t('pos.cart.addDiscount')
                    }}
                  </button>
                </template>
              </OrderTotals>
              <div class="flex-none px-4 pt-3 pb-3.5">
                <AppButton
                  class="pos-page__future-action"
                  variant="transaction"
                  full-width
                  :disabled="!canOpenPaymentPanel"
                  :aria-disabled="!canOpenPaymentPanel ? 'true' : undefined"
                  :icon-end="canOpenPaymentPanel ? 'arrow_forward' : undefined"
                  mirror-icon
                  @click="openPaymentPanel"
                >
                  {{ checkoutActionLabel }}
                </AppButton>
                <p class="mt-2 text-center text-xs text-muted">{{ t('pos.cart.shortcutsHint') }}</p>
              </div>
            </template>
          </CartPanel>
        </div>
      </template>

      <template #compact-bar>
        <div class="flex items-center gap-2.5 border-t border-line bg-surf px-3 py-2.5">
          <div class="min-w-0 flex-1">
            <div class="text-sm font-semibold">
              {{ t('pos.cart.title') }} · {{ cartItemsLabel }}
            </div>
            <div class="numeric text-[1.125rem] font-extrabold">
              {{ money(calculation?.grandTotalAmount ?? 0) }}
            </div>
          </div>
          <AppButton variant="secondary" size="lg" @click="cartSheetOpen = true">
            {{ t('pos.cart.viewCart') }}
          </AppButton>
          <AppButton
            variant="primary"
            size="lg"
            :disabled="!canOpenPaymentPanel"
            @click="openPaymentPanel"
          >
            {{ t('pos.cart.payShort') }}
          </AppButton>
        </div>
      </template>
    </PosWorkspaceShell>

    <PaymentPanel
      :open="paymentPanelOpen"
      :title="t('pos.payment.title')"
      :status-chip-label="t('pos.tender.statusChip')"
      :close-label="t('common.close')"
      :subtotal-label="t('pos.subtotal')"
      :subtotal="money(calculation?.subtotalAmount ?? 0)"
      :discount-label="t('pos.discount')"
      :discount="
        (calculation?.discountTotalAmount ?? 0) > 0
          ? money(calculation?.discountTotalAmount ?? 0)
          : undefined
      "
      :tax-label="t('pos.tax')"
      :tax="money(calculation?.taxTotalAmount ?? 0)"
      :total-label="t('pos.cart.totalDue')"
      :total="money(calculation?.grandTotalAmount ?? 0)"
      :method-options="paymentMethodOptions"
      :methods-label="t('pos.tender.methodsLabel')"
      :no-methods-title="t('pos.payment.noMethodsTitle')"
      :no-methods-description="t('pos.payment.noMethodsDescription')"
      :rows="paymentDisplayRows"
      :rows-title="t('pos.tender.rowsTitle')"
      :rows-limit-note="t('pos.tender.rowsLimit')"
      :no-rows-label="t('pos.tender.noRows')"
      :edit-row-label="t('pos.payment.editRow')"
      :remove-row-label="t('pos.payment.removeRow')"
      :remove-row-text="t('pos.tender.remove')"
      :is-editing-draft="isEditingDraft"
      :draft-method-label="activeMethod?.name"
      :draft-amount-label="t('pos.payment.amount')"
      :draft-amount="draftAmountText"
      :draft-amount-error="draftErrorCode ? t(`pos.payment.errors.${draftErrorCode}`) : undefined"
      :draft-reference-label="t('pos.payment.reference')"
      :draft-reference="draftReferenceText"
      :requires-reference="activeMethod?.requiresReference ?? false"
      :currency-label="activeCurrency"
      :fill-due-label="fillDueAmount !== null ? t('pos.tender.fillDue') : undefined"
      :enter-hint="t('pos.tender.enterHint')"
      :cancel-draft-label="t('common.cancel')"
      :commit-draft-label="t('pos.tender.addPayment')"
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
      :completing-body="t('pos.tender.completingBody')"
      :completion-message="completionMessage"
      :completion-is-error="completionIsError"
      :completion-refresh-available="completionRefreshAvailable"
      :completion-refresh-pending="catalogRefreshing"
      :refresh-workstation-label="t('pos.catalogRefresh.action')"
      :recovery-state="paymentPanelRecoveryState"
      :completed-title="t('pos.tender.completedTitle')"
      :completed-total="completedTotal"
      :completed-note="t('pos.tender.savedLocal')"
      :failed-title="t('pos.tender.failedTitle')"
      :retry-label="t('pos.tender.retrySale')"
      :abandon-label="t('pos.tender.abandonSale')"
      :acknowledge-label="t('pos.tender.newSale')"
      :abandon-warning="t('pos.payment.completion.abandonWarning')"
      :confirm-abandon-label="t('pos.payment.completion.confirmAbandon')"
      :cancel-confirm-label="t('common.cancel')"
      :print-receipt-label="t('pos.payment.printReceipt')"
      @close="closePaymentPanel"
      @select-method="selectPaymentMethod"
      @edit-row="editPaymentRow"
      @remove-row="payment.removeRow"
      @update:draft-amount="payment.setDraftAmountText"
      @update:draft-reference="payment.setDraftReferenceText"
      @commit-draft="commitPaymentDraft"
      @cancel-draft="payment.cancelDraftRow"
      @fill-due="fillDue"
      @complete="handleComplete"
      @refresh-workstation="handleRefreshCatalog"
      @retry="handleRetryAttempt"
      @abandon="handleAbandonAttempt"
      @acknowledge="handleAcknowledgeAttempt"
      @print="handlePrintReceipt"
    >
      <template #actions>
        <AppButton
          variant="ghost"
          size="lg"
          :disabled="completionPending"
          @click="closePaymentPanel"
        >
          {{ t('common.close') }}
        </AppButton>
      </template>
    </PaymentPanel>

    <ReceiptPreviewDialog
      :open="receiptDialogOpen"
      :document="receiptDocument"
      @close="closeReceiptDialog"
    />

    <AppConfirmDialog
      :open="clearConfirmOpen"
      :title="t('pos.clearDialog.title')"
      :message="
        invoiceDiscountType
          ? t('pos.clearDialog.bodyWithDiscount', { count: cartItemsLabel })
          : t('pos.clearDialog.body', { count: cartItemsLabel })
      "
      :confirm-label="t('pos.cart.clear')"
      :cancel-label="t('common.cancel')"
      @confirm="confirmClearCart"
      @cancel="clearConfirmOpen = false"
    />

    <AppDialog
      :open="dialogMode !== null"
      :size="dialogMode === 'rebuild' ? 'lg' : dialogMode === 'customers' ? 'md' : 'sm'"
      :close-label="t('common.close')"
      @close="dialogMode = null"
    >
      <template #title>
        {{
          dialogMode === 'help'
            ? t('pos.shortcutsTitle')
            : dialogMode === 'customers'
              ? t('pos.customerDialog.title')
              : dialogMode
                ? t(`pos.dialog.${dialogMode}`)
                : ''
        }}
      </template>
      <template v-if="dialogMode === 'help'">
        <dl class="pos-page__shortcuts flex flex-col">
          <div class="flex items-center gap-3.5 border-b border-line py-2.5">
            <dt><AppKbd class="min-w-14">F1</AppKbd></dt>
            <dd>{{ t('pos.shortcutHelp') }}</dd>
          </div>
          <div class="flex items-center gap-3.5 border-b border-line py-2.5">
            <dt><AppKbd class="min-w-14">F2</AppKbd></dt>
            <dd>{{ t('pos.shortcutSearch') }}</dd>
          </div>
          <div class="flex items-center gap-3.5 border-b border-line py-2.5">
            <dt><AppKbd class="min-w-14">Esc</AppKbd></dt>
            <dd>{{ t('pos.shortcuts.esc') }}</dd>
          </div>
        </dl>
        <AppBanner variant="info" icon="barcode_scanner" role="note">
          {{ t('pos.shortcuts.scanner') }}
        </AppBanner>
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
          :empty-description="t('pos.customerDialog.noneBody')"
          :count-label="t('pos.customerDialog.matches', { count: customers.length })"
          :selected-label="t('pos.customerDialog.selected')"
          @select="
            (uuid) => {
              catalog.selectCustomer(uuid)
              dialogMode = null
            }
          "
        />
      </template>
      <template v-else-if="dialogMode === 'rebuild'">
        <p class="text-muted">{{ t('pos.rebuildDescription') }}</p>
        <AppInlineError v-if="rebuildError">{{ rebuildError }}</AppInlineError>
        <div
          v-if="rebuildPreviewRows.length > 0"
          class="pos-page__rebuild-preview overflow-hidden rounded-notice border border-line"
          role="table"
        >
          <div
            role="row"
            class="grid grid-cols-[minmax(0,1.6fr)_minmax(0,0.8fr)_minmax(0,1.2fr)] gap-2.5 bg-subtle px-3.5 py-2.5 text-xs font-semibold text-muted"
          >
            <span role="columnheader">{{ t('pos.rebuildTable.product') }}</span>
            <span role="columnheader">{{ t('pos.rebuildTable.was') }}</span>
            <span role="columnheader">{{ t('pos.rebuildTable.now') }}</span>
          </div>
          <div
            v-for="row in rebuildPreviewRows"
            :key="row.id"
            role="row"
            class="numeric grid grid-cols-[minmax(0,1.6fr)_minmax(0,0.8fr)_minmax(0,1.2fr)] items-center gap-2.5 border-t border-line px-3.5 py-3 text-sm"
          >
            <span role="cell" class="font-medium">{{ row.name }}</span>
            <span role="cell">{{ row.oldPrice }}</span>
            <span
              role="cell"
              class="flex flex-wrap items-center gap-1.5 font-semibold"
              :class="row.oldPrice === row.newPrice && !row.taxChanged ? 'text-ok' : 'text-warn'"
            >
              <AppIcon
                :name="
                  row.oldPrice === row.newPrice && !row.taxChanged
                    ? 'check'
                    : 'published_with_changes'
                "
                :size="18"
              />
              {{ row.oldPrice === row.newPrice ? t('pos.rebuildTable.same') : row.newPrice }}
              <span v-if="row.taxChanged">· {{ t('pos.rebuildTaxChanged') }}</span>
            </span>
          </div>
        </div>
        <p v-else class="text-muted">{{ t('pos.rebuildNoChanges') }}</p>
      </template>
      <template v-else-if="dialogMode === 'discount'">
        <AppSegmented
          :model-value="invoiceDiscountSelection"
          :label="t('pos.discountType')"
          :columns="3"
          :options="[
            { value: 'none', label: t('pos.discountNone') },
            { value: 'fixed', label: t('pos.discountFixed') },
            { value: 'percentage', label: t('pos.discountPercentage') }
          ]"
          @update:model-value="
            (value) => {
              invoiceDiscountSelection = value
              invoiceDiscountError = null
            }
          "
        />
        <AppInput
          v-if="invoiceDiscountSelection !== 'none'"
          v-model="invoiceDiscountDraft"
          :label="
            invoiceDiscountSelection === 'fixed'
              ? t('pos.discountAmount')
              : t('pos.discountPercent')
          "
          :prefix="invoiceDiscountSelection === 'fixed' ? activeCurrency : '%'"
          inputmode="decimal"
          size="lg"
          autofocus
          :error="invoiceDiscountError ?? undefined"
          @blur="applyInvoiceDiscount"
          @keydown="handleInvoiceDiscountKeydown"
        />
      </template>
      <template v-if="dialogMode === 'customers'" #actions>
        <AppButton variant="secondary" class="me-auto" @click="useWalkInCustomer">
          {{ t('pos.customerDialog.useWalkIn') }}
        </AppButton>
        <AppButton variant="ghost" @click="dialogMode = null">{{ t('common.cancel') }}</AppButton>
      </template>
      <template v-else-if="dialogMode === 'rebuild' || dialogMode === 'discount'" #actions>
        <AppButton variant="secondary" @click="dialogMode = null">{{
          t('common.cancel')
        }}</AppButton>
        <AppButton
          variant="primary"
          @click="dialogMode === 'rebuild' ? confirmCartRebuild() : commitInvoiceDiscount()"
        >
          {{ dialogMode === 'rebuild' ? t('pos.rebuildCart') : t('pos.applyDiscount') }}
        </AppButton>
      </template>
    </AppDialog>
  </section>
</template>
