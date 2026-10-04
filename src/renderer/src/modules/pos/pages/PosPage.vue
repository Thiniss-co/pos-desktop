<script setup lang="ts">
import { useWorkstationRefreshStore } from '@renderer/modules/catalogInstall/workstationRefresh.store'
import { installHoldActive, waitForInstallHold } from '@renderer/modules/catalogInstall/installHold'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import type { CatalogProduct, PaymentMethodType } from '@shared/contracts/catalog.contract'
import type { CheckoutIntent } from '@shared/contracts/checkout.contract'
import type { LocaleCode } from '@shared/contracts/preferences.contract'
import type {
  DisplayHeldSale,
  DisplayPaymentMethodOption,
  DisplayProduct,
  DisplayQuickAction,
  DisplayQuickTender,
  DisplayScanResult,
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
import CartLineItem from '@renderer/shared/components/pos/CartLineItem.vue'
import CatalogRefreshPanel from '@renderer/shared/components/pos/CatalogRefreshPanel.vue'
import PhysicalPresenceNotice from '@renderer/modules/offlineSale/components/PhysicalPresenceNotice.vue'
import AutoPrintNotices from '@renderer/modules/printing/components/AutoPrintNotices.vue'
import AutoPrintSaleStatus from '@renderer/modules/printing/components/AutoPrintSaleStatus.vue'
import CartPanel from '@renderer/shared/components/pos/CartPanel.vue'
import CategorySelector from '@renderer/shared/components/pos/CategorySelector.vue'
import OrderTotals from '@renderer/shared/components/pos/OrderTotals.vue'
import PosWorkspaceShell from '@renderer/shared/components/pos/PosWorkspaceShell.vue'
import ProductCard from '@renderer/shared/components/pos/ProductCard.vue'
import ProductSearchBar from '@renderer/shared/components/pos/ProductSearchBar.vue'
import CustomerSelector from '@renderer/shared/components/pos/CustomerSelector.vue'
import PaymentPanel from '@renderer/shared/components/pos/PaymentPanel.vue'
import HeldSalesList from '@renderer/shared/components/pos/HeldSalesList.vue'
import QuickActionsBar from '@renderer/shared/components/pos/QuickActionsBar.vue'
import NumericKeypad from '@renderer/shared/components/pos/NumericKeypad.vue'
import { applyKeypadKey, type KeypadKey } from '@renderer/shared/utils/keypad'
import { formatQuantity } from '@shared/pos/posCalculator'
import { useUserPreferencesStore } from '@renderer/modules/preferences/userPreferences.store'
import RefundEntryDialog from '@renderer/modules/refunds/components/RefundEntryDialog.vue'
import RefundDialog from '@renderer/modules/refunds/components/RefundDialog.vue'
import { useQuickCreateStore } from '@renderer/modules/quickCreate/store'
import { useRefundsStore } from '@renderer/modules/refunds/store'
import QuickCreateDialog from '@renderer/modules/quickCreate/components/QuickCreateDialog.vue'
import AppToast from '@renderer/shared/components/feedback/AppToast.vue'
import type { QuickCreateEntity, QuickCreateRecord } from '@shared/contracts/quickCreate.contract'
import ScanEntry from '@renderer/shared/components/pos/ScanEntry.vue'
import SaleRecoveryBanner from '@renderer/shared/components/pos/SaleRecoveryBanner.vue'
import ReceiptPreviewDialog from '@renderer/modules/printing/components/ReceiptPreviewDialog.vue'
import type { ReceiptDocumentRef } from '@shared/contracts/printing.contract'
import { useCartStore } from '../cart.store'
import { CATALOG_PAGE_SIZES, type CatalogPageSize, useCatalogStore } from '../catalog.store'
import { usePaymentStore } from '../payment.store'
import { useShiftStore } from '../shift.store'
import { useShiftDialogStore } from '../shiftDialog.store'
import { useScanInputRouter, type ScanInputMode } from '../scanInputRouter'
import { usePosShortcuts } from '../usePosShortcuts'
import { describeStock } from '../stockDisplay'
import { useConnectivityStore } from '@renderer/modules/connectivity/store'
import { minorToDecimalText, parseScanEntry, quickCashAmounts } from '../quickSale'

type DialogMode = 'help' | 'customers' | 'rebuild' | 'discount' | 'held' | null

type InvoiceDiscountSelection = 'none' | 'fixed' | 'percentage'

const { t, te } = useI18n()
const localeStore = useLocaleStore()
const bootstrap = useBootstrapStore()
const workstationRefresh = useWorkstationRefreshStore()
const catalog = useCatalogStore()
const cart = useCartStore()
const shift = useShiftStore()
const payment = usePaymentStore()
const sync = useSyncStore()
const shiftDialog = useShiftDialogStore()
const connectivity = useConnectivityStore()
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
  pageCount: catalogPageCount,
  stock: stockViews
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
  heldDrafts,
  catalogChanged: cartCatalogStale
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
  isBlocked,
  attemptKey,
  attemptState,
  attemptRecovery,
  blockingRecovery,
  attemptProtected
} = storeToRefs(payment)
const { isRunning: isRefreshingCatalog, error: bootstrapError } = storeToRefs(bootstrap)
const searchRef = ref<InstanceType<typeof ProductSearchBar> | null>(null)
/** POS improvements: the register quick-create dialog (kind) and its confirmation. */
const quickCreateKind = ref<QuickCreateEntity | null>(null)
const quickCreateName = ref('')
const quickCreateNotice = ref<string | null>(null)
let quickCreateNoticeTimer: ReturnType<typeof setTimeout> | null = null

/** POS improvements, Stage 3: More actions, and Return / Refund (an overlay over the POS). */
const quickCreateStore = useQuickCreateStore()
const moreActionsOpen = ref(false)
const refundsStore = useRefundsStore()
const refundAllowed = computed(() => refundsStore.accessAllowed)
const refundEntryOpen = ref(false)
const refundInvoiceUuid = ref<string | null>(null)
const moreActions = computed(() =>
  (['customer', 'product', 'supplier'] as const).filter((kind) => quickCreateStore.access[kind])
)

async function loadRefundAccess(): Promise<void> {
  await refundsStore.loadAccess()
}

function openRefundEntry(): void {
  if (!refundAllowed.value) return
  refundEntryOpen.value = true
}

function selectRefundInvoice(invoiceLocalUuid: string): void {
  refundEntryOpen.value = false
  refundInvoiceUuid.value = invoiceLocalUuid
}

function closeRefund(): void {
  refundInvoiceUuid.value = null
  void nextTick(() => focusScanEntry())
}

/** Closes a POS overlay and gives the scan entry its focus back (the cashier keeps scanning). */
function closeOverlay(close: () => void): void {
  close()
  void nextTick(() => focusScanEntry())
}

function chooseMoreAction(kind: QuickCreateEntity): void {
  moreActionsOpen.value = false
  openQuickCreate(kind)
}

function openNewCustomerFromSelector(): void {
  const name = customerQuery.value
  dialogMode.value = null
  openQuickCreate('customer', name)
}

function openQuickCreate(kind: QuickCreateEntity, initialName = ''): void {
  quickCreateName.value = initialName
  quickCreateKind.value = kind
}

async function handleQuickCreated(record: QuickCreateRecord): Promise<void> {
  quickCreateKind.value = null
  if (record.entityType === 'customer') {
    // The new customer is selectable at once (main merges it into the customer search).
    customerQuery.value = record.name
    await catalog.searchCustomers()
    catalog.selectCustomer(record.entityUuid)
  }
  quickCreateNotice.value = String(
    t(`quickCreate.created.${record.entityType}`, { name: record.name })
  )
  if (quickCreateNoticeTimer) clearTimeout(quickCreateNoticeTimer)
  quickCreateNoticeTimer = setTimeout(() => (quickCreateNotice.value = null), 6000)
  void nextTick(() => focusScanEntry())
}
const dialogMode = ref<DialogMode>(null)
const clearConfirmOpen = ref(false)

// --- POS improvements, Stage 5: touch mode -------------------------------------------------------
// Per-user (main owns the identity). Touch adds visible controls for every shortcut and an on-screen
// keypad; the scanner and the function keys keep working exactly as before.
const userPreferences = useUserPreferencesStore()
const touchMode = computed(() => userPreferences.preferences.touchMode)
const keypadLabels = computed(() =>
  touchMode.value
    ? {
        backspace: t('touch.keypad.backspace'),
        clear: t('touch.keypad.clear'),
        decimal: t('touch.keypad.decimal')
      }
    : null
)
const quantityKeypadLineId = ref<string | null>(null)
const quantityKeypadDraft = ref('')
const quantityKeypadError = ref<string | null>(null)
const cartSheetOpen = ref(false)
const invoiceDiscountSelection = ref<InvoiceDiscountSelection>('none')
const invoiceDiscountDraft = ref('')
const invoiceDiscountError = ref<string | null>(null)
const rebuildError = ref<string | null>(null)
const rebuildPreview = ref<{
  readonly token: string
  readonly revision: string
  readonly products: readonly CatalogProduct[]
  /** Lines whose product the installed catalog no longer offers; dropped only on confirmation. */
  readonly removedLineIds: readonly string[]
} | null>(null)
const paymentPanelRef = ref<InstanceType<typeof PaymentPanel> | null>(null)
/** Rev 3: scanner-safety notices inside the payment dialog. */
const scannerNotice = ref<string | null>(null)
const collectingScan = ref(false)
/** Codes scanned on the completed-sale screen, delivered in order after acknowledgement. */
const heldScans = ref<string[]>([])
const heldScansAckFailed = ref(false)
/** A compact "last sale" strip that survives acknowledgement (change due, reprint). */
const lastSale = ref<{ readonly total: string; readonly change: string | null } | null>(null)
const scanRef = ref<InstanceType<typeof ScanEntry> | null>(null)
const scanText = ref('')
const pendingMultiplier = ref<number | null>(null)
const scanResult = ref<DisplayScanResult | null>(null)
const lastAddedProductUuid = ref<string | null>(null)
let scanSequence = 0
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
 * Only surfaced while the open draft is actually frozen on an older catalog: a revision change with
 * an empty cart needs no cashier action, and a cart started after the refresh has already adopted
 * the installed contract (rev 3 — the refresh flag alone stayed set and wrongly asked the cashier
 * to rebuild a current cart). With a stale draft the cart store has invalidated it
 * (`CART_CATALOG_CHANGED`), so this names the resolution the page offers — rebuild or clear — and
 * never a silent reprice.
 */
const catalogRevisionChangedMessage = computed(() =>
  catalogRevisionChanged.value && cartCatalogStale.value && lines.value.length > 0
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
  const relative = lastSyncedRelative.value
  if (catalogRefreshError.value) {
    // A failed refresh never claims "up to date": it states when data was last installed.
    return {
      tone: 'warn',
      label: relative
        ? t('pos.catalogLine.refreshFailed', { relative })
        : t('pos.catalogLine.unknown')
    }
  }
  const tone =
    catalogStatus.value === 'fresh' ? 'ok' : catalogStatus.value === 'stale' ? 'warn' : 'muted'
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
  const stockInfo = stock(product)
  return {
    stockDetail: stockInfo.detail ?? undefined,
    id: product.uuid,
    name: product.name,
    sku: product.sku ?? '—',
    price,
    stock: stockInfo.level,
    categoryId: product.categoryUuid,
    unit: product.unit ?? undefined,
    monogram: monogram(product.name),
    imageUrl: product.image?.thumbDataUrl,
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
  if (attemptProtected.value) {
    // A protected attempt can only be resolved through recovery (retry / cancel payment).
    clearConfirmOpen.value = false
    return
  }
  cart.clear()
  // New draft: every editable tender field, preview and finished-attempt message is reset.
  payment.resetEditableState()
  scannerNotice.value = null
  // The last scan's "Added to sale" line described the cart that was just cleared.
  scanResult.value = null
  paymentPanelOpen.value = false
  pendingMultiplier.value = null
  lastAddedProductUuid.value = null
  clearConfirmOpen.value = false
  void nextTick(focusScanEntry)
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
  const removed = new Set(rebuildPreview.value.removedLineIds)
  return lines.value.flatMap((line) => {
    if (removed.has(line.id)) {
      return [
        {
          id: line.id,
          name: line.product.name,
          oldPrice: money(line.product.price.amount, line.product.price.currency),
          newPrice: '',
          taxChanged: false,
          nameChanged: false,
          trackingChanged: false,
          removed: true
        }
      ]
    }
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
              line.product.tax.rateBasisPoints !== replacement.tax.rateBasisPoints,
            nameChanged: line.product.name !== replacement.name,
            trackingChanged: line.product.trackStock !== replacement.trackStock,
            removed: false
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
    (completionOutcome.value.failureCode === 'stock-allocation-unavailable' ||
      completionOutcome.value.failureCode === 'catalog-superseded')
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

function recoveryDetail(
  summary: {
    legacyDispatchUnknown: boolean
    outstandingRequests: number
    needsSupport: boolean
    supportReference: string | null
  } | null
): string | undefined {
  if (!summary) {
    return undefined
  }
  const parts: string[] = []
  if (summary.needsSupport) {
    parts.push(
      String(
        summary.supportReference
          ? t('pos.recovery.needsSupportReference', { reference: summary.supportReference })
          : t('pos.recovery.needsSupport')
      )
    )
  }
  if (summary.legacyDispatchUnknown) {
    parts.push(String(t('pos.recovery.legacyUnknown')))
  }
  if (summary.outstandingRequests > 0) {
    parts.push(String(t('pos.recovery.outstandingRequest')))
  }
  return parts.length > 0 ? parts.join(' ') : undefined
}

/** This draft's own attempt is durably claimed by main (retryable or uncertain) and idle. */
const currentAttemptClaimed = computed(
  () => !completionPending.value && attemptKey.value !== null && attemptState.value === 'claimed'
)

const paymentPanelRecoveryState = computed<PaymentPanelRecoveryState>(() => {
  if (isBlocked.value && blockingAttemptKey.value !== attemptKey.value) {
    return {
      kind: 'blocked',
      message: String(t('pos.payment.completion.blocked')),
      retryAvailable: blockingRecovery.value?.needsSupport !== true,
      detail: recoveryDetail(blockingRecovery.value)
    }
  }

  if (currentAttemptClaimed.value) {
    return {
      kind: 'blocked',
      message: completionMessage.value ?? String(t('pos.payment.completion.blocked')),
      retryAvailable: attemptRecovery.value?.needsSupport !== true,
      detail: recoveryDetail(attemptRecovery.value)
    }
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
  () =>
    !completionPending.value &&
    !attemptProtected.value &&
    paymentPanelRecoveryState.value.kind === 'clear'
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
    icon: 'pause_circle',
    shortcut: 'F4',
    disabled: !canHold.value
  },
  {
    id: 'recall',
    label: String(t('pos.quickSale.recall')),
    icon: 'history',
    shortcut: 'F6',
    badge: heldDrafts.value.length > 0 ? String(heldDrafts.value.length) : undefined,
    disabled: heldDrafts.value.length === 0 || !attemptSettled.value
  },
  {
    id: 'repeat',
    label: String(t('pos.quickSale.repeatLast')),
    icon: 'add',
    disabled: lastAddedLine.value === null || !canEdit.value || !canAddToCart.value
  },
  // POS improvements, Stage 3: a visible Return / Refund, and More (register quick-create).
  ...(refundAllowed.value
    ? [
        {
          id: 'refund',
          label: String(t('pos.quickSale.refund')),
          icon: 'undo' as const,
          shortcut: 'F10'
        }
      ]
    : []),
  ...(moreActions.value.length > 0
    ? [{ id: 'more', label: String(t('pos.quickSale.more')), icon: 'more_horiz' as const }]
    : [])
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

/**
 * Rev 3 "Complete · Exact cash": the cashier-selected cash method, else the ONLY active cash method
 * that needs no reference. Several candidates and no selection → no default (hidden).
 */
const exactCashMethod = computed(() => {
  const selected = activeMethod.value
  if (selected && selected.type === 'cash' && !selected.requiresReference) {
    return selected
  }
  const candidates = paymentMethods.value.filter(
    (method) => method.type === 'cash' && !method.requiresReference
  )
  return candidates.length === 1 ? candidates[0] : null
})
const grandTotalAmount = computed(() => calculation.value?.grandTotalAmount ?? 0)
/**
 * POS improvements, Stage 4: a cart whose lines carry different tax modes (allowed under a per-line
 * contract). Its gross-and-net "Subtotal" would not add up with the tax to the total, so the summary
 * shows "Total excl. VAT" (total − VAT) instead. Uniform carts keep the existing summary.
 */
const mixedTaxCart = computed(
  () => new Set(lines.value.map((line) => line.product.tax.mode)).size > 1
)
const summaryFirstLabel = computed(() =>
  mixedTaxCart.value ? t('pos.totalExclVat') : t('pos.subtotal')
)
const summaryFirstAmount = computed(() =>
  mixedTaxCart.value
    ? (calculation.value?.grandTotalAmount ?? 0) - (calculation.value?.taxTotalAmount ?? 0)
    : (calculation.value?.subtotalAmount ?? 0)
)
const exactCashEligible = computed(
  () =>
    exactCashMethod.value !== null &&
    canSell.value &&
    cartState.value.kind === 'valid' &&
    paymentRows.value.length === 0 &&
    grandTotalAmount.value > 0 &&
    !attemptProtected.value &&
    !isBlocked.value &&
    paymentPanelRecoveryState.value.kind === 'clear'
)
const exactCashAction = computed(() =>
  exactCashEligible.value && exactCashMethod.value
    ? {
        label: String(
          t('pos.exactCash.complete', {
            method: exactCashMethod.value.name,
            amount: money(grandTotalAmount.value)
          })
        ),
        keyHint: 'Shift+F9'
      }
    : null
)
const addRemainingAction = computed(() =>
  exactCashMethod.value &&
  paymentRows.value.length > 0 &&
  outstandingAmount.value > 0 &&
  !isEditingDraft.value &&
  paymentPanelRecoveryState.value.kind === 'clear'
    ? {
        label: String(
          t('pos.exactCash.addRemaining', {
            method: exactCashMethod.value.name,
            amount: money(outstandingAmount.value)
          })
        )
      }
    : null
)
const largeChangeWarning = computed(() => {
  const outcome = previewOutcome.value
  return outcome?.outcome === 'valid' &&
    outcome.changeDueAmount > 0 &&
    outcome.changeDueAmount > grandTotalAmount.value * 20
    ? String(t('pos.payment.largeChange'))
    : null
})

/** Explicit cashier confirmation of exact cash received; main validates and commits durably. */
function handleExactCash(): void {
  const method = exactCashMethod.value
  if (!exactCashEligible.value || !method) {
    return
  }
  if (!paymentPanelOpen.value) {
    paymentPanelOpen.value = true
  }
  payment.addExactRow(method.uuid, grandTotalAmount.value)
  handleComplete()
}

function handleAddRemaining(): void {
  const method = exactCashMethod.value
  if (method && addRemainingAction.value) {
    payment.addRemainingRow(method.uuid, outstandingAmount.value)
  }
}

function reportScan(
  code: string,
  tone: DisplayScanResult['tone'],
  message: string,
  detail?: string
): void {
  scanSequence += 1
  scanResult.value = { sequence: scanSequence, code, tone, message, detail }
}

/**
 * The single add-by-code path shared by the scan-entry field and the page-level scanner listener.
 * `explicitMilli` comes from a typed `3*code` prefix; otherwise a pending multiplier tile applies
 * once, then resets, so the next scan is back to one unit. The outcome is always reported: found,
 * not-found, ambiguous, stale-catalog, and unavailable-catalog stay distinguishable.
 */
async function addByCode(code: string, explicitMilli: number | null): Promise<void> {
  // Rev 4 §8.2: a scan queued during a catalog install runs after the new contract is applied.
  if (installHoldActive.value) {
    await waitForInstallHold()
  }
  const quantityMilli = explicitMilli ?? (pendingMultiplier.value ?? 1) * 1000
  const result = await catalog.findProductByBarcode(code)

  if (result.outcome !== 'found') {
    reportScan(
      code,
      result.outcome === 'stale-catalog' ? 'warning' : 'error',
      String(t(`pos.barcode.${result.outcome}`)),
      result.outcome === 'not-found' ? String(t('pos.notices.barcodeUnknownHint')) : undefined
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

  adoptInstalledContractForEmptyCart(result.revision)

  if (!cart.addProduct(result.product, quantityMilli, result.revision)) {
    reportScan(code, 'error', cartError.value ?? String(t('pos.errors.CART_INVALID')))
    return
  }

  pendingMultiplier.value = null
  lastAddedProductUuid.value = result.product.uuid
  const quantity = formatNumber(quantityMilli / 1000, localeStore.locale as LocaleCode, {
    maximumFractionDigits: 3
  })
  reportScan(
    code,
    'success',
    String(t('pos.quickSale.added')),
    `${result.product.name} · ×${quantity} · ${money(result.product.price.amount, result.product.price.currency)}`
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
  // Serialized with page-level scans, so rapid consecutive scans keep their order.
  void enqueueScan(parsed.code, parsed.quantityMilli)
}

let scanChain: Promise<void> = Promise.resolve()
function enqueueScan(code: string, explicitMilli: number | null): Promise<void> {
  scanChain = scanChain.then(() => addByCode(code, explicitMilli)).catch(() => undefined)
  return scanChain
}

/**
 * Rev 3: a new (empty) cart adopts the installed contract its product came from; an existing cart
 * is never re-contracted here (it stays frozen until an explicit review/rebuild).
 */
function adoptInstalledContractForEmptyCart(revision: string | undefined): void {
  const installed = catalog.status?.contract
  if (
    revision &&
    lines.value.length === 0 &&
    catalog.status?.catalogValid &&
    installed &&
    installed.revision === revision &&
    cartContract.value?.revision !== revision
  ) {
    cart.setContract(installed)
  }
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

  payment.resetEditableState()
  catalog.selectCustomer(null)
  paymentPanelOpen.value = false
  pendingMultiplier.value = null
  lastAddedProductUuid.value = null
  reportScan('—', 'success', String(t('pos.quickSale.heldNotice', { count: held.itemCount })))
  return true
}

async function recallHeldSale(id: string): Promise<void> {
  if (installHoldActive.value) {
    await waitForInstallHold()
  }
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

  payment.resetEditableState()
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

function handleQuickAction(id: string): void {
  const action = quickActions.value.find((candidate) => candidate.id === id)
  if (action?.disabled) {
    return
  }

  if (id === 'hold') {
    holdCurrentSale()
  } else if (id === 'recall') {
    dialogMode.value = 'held'
  } else if (id === 'repeat') {
    repeatLastItem()
  } else if (id === 'refund') {
    openRefundEntry()
  } else if (id === 'more') {
    moreActionsOpen.value = true
  } else if (id === 'customer' && catalogAvailable.value && attemptSettled.value) {
    openCustomerDialog()
  } else if (id === 'discount' && lines.value.length > 0 && canEdit.value && attemptSettled.value) {
    openInvoiceDiscountDialog()
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
/**
 * Stage 5: the touch bar holds the shortcuts that have no other visible control — Exact cash
 * (Shift+F9) and Help (F1) — plus Pay. Every other shortcut already has an on-screen control of at
 * least 44×44 in touch mode: Choose customer (F7), Add discount (F8), Clear cart, the search field (F2),
 * the scan field (F3), and the Hold / Recall / Return tiles (F4 / F6 / F10).
 */
const touchActions = computed(() => [
  {
    id: 'touch-exact-cash',
    label: t('touch.actions.exactCash'),
    shortcut: 'Shift+F9',
    icon: 'payments' as const,
    disabled: lines.value.length === 0 || !attemptSettled.value
  },
  {
    id: 'touch-pay',
    label: t('touch.actions.pay'),
    shortcut: 'F9',
    icon: 'point_of_sale' as const,
    disabled: lines.value.length === 0
  },
  { id: 'touch-help', label: t('touch.actions.help'), shortcut: 'F1', icon: 'help' as const }
])

function handleTouchAction(id: string): void {
  if (id === 'touch-exact-cash') {
    handleExactCash()
  } else if (id === 'touch-pay') {
    handlePayShortcut()
  } else if (id === 'touch-help') {
    openDialog('help')
  }
}

function openQuantityKeypad(lineId: string): void {
  const line = lines.value.find((candidate) => candidate.id === lineId)
  if (!line) {
    return
  }
  quantityKeypadLineId.value = lineId
  quantityKeypadDraft.value = ''
  quantityKeypadError.value = null
}

function pressQuantityKey(key: KeypadKey): void {
  quantityKeypadDraft.value = applyKeypadKey(quantityKeypadDraft.value, key, 3)
  quantityKeypadError.value = null
}

function applyQuantityKeypad(): void {
  const lineId = quantityKeypadLineId.value
  const draft = quantityKeypadDraft.value
  if (lineId === null) {
    return
  }
  // The keypad allows at most three decimals; the cart's canonical form is thousandths ("2.500").
  // The cart then applies its own limits; a refusal keeps the dialog open.
  const match = /^(\d{1,6})(?:\.(\d{1,3}))?$/.exec(draft)
  const milli = match ? Number(match[1]) * 1000 + Number((match[2] ?? '').padEnd(3, '0')) : 0
  const quantity = milli > 0 ? formatQuantity(milli) : null
  if (quantity === null || !quantity.ok || !cart.setQuantity(lineId, quantity.value)) {
    quantityKeypadError.value = t('touch.quantity.invalid')
    return
  }
  closeOverlay(() => (quantityKeypadLineId.value = null))
}

function handlePayShortcut(): void {
  // Inside the payment dialog F9 is routed by the scan-input router to the step's primary action.
  if (!paymentPanelOpen.value) {
    openPaymentPanel()
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
  // Rev 4 §8.3: every explicit refresh is the manual install path (consent with a sale in progress).
  void workstationRefresh.request()
}

function recoveryKey(): string | null {
  return blockingAttemptKey.value ?? (currentAttemptClaimed.value ? attemptKey.value : null)
}

function handleRetryAttempt(key: string | null = recoveryKey()): void {
  if (key) {
    void payment.retryAttempt(key, undefined, () => cart.clear())
  }
}

function handleAbandonAttempt(key: string | null = recoveryKey()): void {
  if (!key) {
    return
  }
  const summary = key === blockingAttemptKey.value ? blockingRecovery.value : attemptRecovery.value
  // The cashier confirmed the (legacy-aware) warning explicitly before this emit.
  void payment
    .abandonAttempt(key, { acknowledgeLegacyUncertainty: summary?.legacyDispatchUnknown === true })
    .then(() => {
      void payment.discoverPending()
      void nextTick(focusScanEntry)
    })
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
  if (panelOwnsAttempt) {
    void acknowledgeAndDeliver()
    return
  }
  void payment.acknowledgeAttempt(key)
}

let acknowledging = false
/**
 * Rev 3 scan-to-next-sale: acknowledge the committed sale, and only after main confirmed it close
 * the dialog and deliver any codes scanned on the completed-sale screen, in order, exactly once.
 * A failed acknowledgement keeps the result and the held codes.
 */
async function acknowledgeAndDeliver(): Promise<void> {
  const outcome = completionOutcome.value
  if (acknowledging || !outcome || outcome.outcome !== 'committed') {
    return
  }
  acknowledging = true
  try {
    lastSale.value = {
      total: money(outcome.invoice.grandTotalAmount),
      change: changeDueDisplay.value ?? null
    }
    const result = await payment.acknowledgeAttempt(outcome.attemptKey)
    if (result?.outcome !== 'acknowledged') {
      heldScansAckFailed.value = heldScans.value.length > 0
      return
    }
    heldScansAckFailed.value = false
    // Hand the held codes to the serialized scan chain BEFORE leaving the dialog, so any scan that
    // arrives after it is queued behind them.
    const codes = heldScans.value.splice(0, heldScans.value.length)
    for (const code of codes) {
      void enqueueScan(code, null)
    }
    paymentPanelOpen.value = false
    scannerNotice.value = null
    await nextTick()
    focusScanEntry()
  } finally {
    acknowledging = false
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
  if (paymentPanelRecoveryState.value.kind === 'awaiting-acknowledgment') {
    // Closing the completed-sale screen is "New sale" — never a way back into a locked cart.
    void acknowledgeAndDeliver()
    return
  }
  paymentPanelOpen.value = false
  scannerNotice.value = null
  void nextTick(focusScanEntry)
}

const receiptDialogOpen = ref(false)
const receiptDocument = ref<ReceiptDocumentRef | null>(null)

/** POS improvements, Stage 7: the sale whose automatic print the complete panel reports. */
const completedInvoiceUuid = computed(() => {
  const outcome = completionOutcome.value
  return outcome && (outcome.outcome === 'committed' || outcome.outcome === 'acknowledged')
    ? outcome.invoice.localUuid
    : null
})

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

const isOnline = computed(() => connectivity.snapshot?.status === 'online')

function stockFor(
  product: CatalogProduct,
  view: (typeof stockViews.value)[string] | undefined
): ReturnType<typeof describeStock> {
  return describeStock(product.trackStock ? view : { kind: 'untracked' }, {
    online: isOnline.value,
    translate: (key, params) => String(t(key, params ?? {})),
    formatQuantity: (value) =>
      formatNumber(value, localeStore.locale as LocaleCode, { maximumFractionDigits: 3 }),
    formatTime: (iso) =>
      formatDateTime(iso, localeStore.locale as LocaleCode, { timeStyle: 'short' })
  })
}

/** Rev 3: separated, honestly labelled stock facts (never an adjusted warehouse balance). */
function stock(product: CatalogProduct): ReturnType<typeof describeStock> {
  return stockFor(product, stockViews.value[product.uuid])
}

async function addSelectedProduct(uuid: string): Promise<void> {
  if (installHoldActive.value) {
    await waitForInstallHold()
  }
  if (!canAddToCart.value) {
    return
  }
  const forSale = await catalog.getProductForSale(uuid)
  if (!forSale) {
    return
  }
  const quantityMilli = (pendingMultiplier.value ?? 1) * 1000
  adoptInstalledContractForEmptyCart(forSale.revision)
  if (cart.addProduct(forSale.product, quantityMilli, forSale.revision)) {
    pendingMultiplier.value = null
    lastAddedProductUuid.value = forSale.product.uuid
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

/** A scan made while no input has focus lands in the same add-by-code path as the scan field. */
async function handleBarcode(barcode: string): Promise<void> {
  await enqueueScan(barcode, null)
}

async function prepareCartRebuild(): Promise<void> {
  const before = catalog.status
  if (!before?.catalogValid || !before.contract || cartState.value.kind !== 'invalid') {
    return
  }

  const token = cart.captureContext()
  const products: CatalogProduct[] = []
  const removedLineIds: string[] = []
  for (const line of lines.value) {
    const product = await catalog.getProduct(line.product.uuid)
    if (!product || !product.price) {
      // Shown in the review as "removed"; dropped only when the cashier confirms.
      removedLineIds.push(line.id)
      continue
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
  rebuildPreview.value = { token, revision: before.contract.revision, products, removedLineIds }
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

  if (cart.rebuildFromCatalog(preview.products, { dropLineIds: preview.removedLineIds })) {
    payment.invalidatePreview()
    rebuildError.value = null
    dialogMode.value = null
    rebuildPreview.value = null
  }
}

const scanMode = computed<ScanInputMode>(() => {
  if (receiptDialogOpen.value) {
    return 'inactive'
  }
  if (!paymentPanelOpen.value) {
    return dialogMode.value !== null || clearConfirmOpen.value ? 'inactive' : 'page'
  }
  const kind = paymentPanelRecoveryState.value.kind
  if (kind === 'awaiting-acknowledgment') {
    return 'payment-done'
  }
  if (kind === 'blocked' || completionPending.value) {
    return 'payment-other'
  }
  return 'payment-tender'
})

useScanInputRouter({
  mode: () => scanMode.value,
  onScan: (code: string) => handleBarcode(code),
  onDoneCode: (code: string) => {
    heldScans.value = [...heldScans.value, code]
    void acknowledgeAndDeliver()
  },
  onPrimary: () => {
    paymentPanelRef.value?.activatePrimary()
  },
  onExactCash: () => handleExactCash(),
  onPrint: () => {
    paymentPanelRef.value?.activatePrint()
  },
  onEscape: () => closePaymentPanel(),
  onScannerIgnored: () => {
    scannerNotice.value = String(t('pos.scanner.ignoredWhilePaying'))
  },
  onCollectingChange: (collecting: boolean) => {
    collectingScan.value = collecting
  },
  onFieldBurstReverted: () => {
    scannerNotice.value = String(t('pos.scanner.fieldReverted'))
  }
})
usePosShortcuts({
  focusSearch: () => searchRef.value?.focus(),
  showHelp: () => openDialog('help'),
  bindings: {
    F3: focusScanEntry,
    F4: () => handleQuickAction('hold'),
    F6: () => handleQuickAction('recall'),
    F7: () => handleQuickAction('customer'),
    F8: () => handleQuickAction('discount'),
    F9: handlePayShortcut,
    F10: () => handleQuickAction('refund')
  }
})

// Payment lives in the cart column, so it folds away by itself once there is nothing left to pay
// for — but never while a committed sale is still waiting for the cashier's acknowledgment.
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

// --- POS reliability rev 3: sale identity, attempt lock, preview invalidation ------------------
watch(
  () => cart.saleId,
  (saleId) => payment.bindSale(saleId),
  { immediate: true }
)

// Rev 4 §8: an open payment dialog is payment activity for the catalog-install gate.
watch(paymentPanelOpen, (open) => payment.setPanelOpen(open), { immediate: true })
watch(attemptProtected, (isProtected) => cart.setLocked(isProtected), { immediate: true })
// Any cart change invalidates the preview synchronously: a stale "valid" can never enable Complete.
watch(
  () => cart.captureContext(),
  () => payment.invalidatePreview(),
  { flush: 'sync' }
)
watch(grandTotalAmount, (total) => {
  if (payment.dropStaleExactRows(total)) {
    scannerNotice.value = String(t('pos.exactCash.rowDropped'))
  }
})
watch(paymentPanelOpen, (open) => {
  if (!open) {
    collectingScan.value = false
  }
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
      void payment.discoverPending()
      paymentPanelOpen.value = false
      cartSheetOpen.value = false
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
  releaseCatalogChanges?.()
})

let releaseCatalogChanges: (() => void) | null = null

// Permissions change with every bootstrap (main pushes quick-create changes then): re-read refund access.
watch(
  () => quickCreateStore.access,
  () => void loadRefundAccess(),
  { deep: true }
)

onMounted(async () => {
  void loadRefundAccess()
  synchronizationAgeTimer = window.setInterval(() => {
    synchronizationReferenceTime.value = Date.now()
  }, 60_000)
  releaseCatalogChanges = catalog.subscribeToChanges()
  await Promise.all([
    shift.loadCurrent(),
    catalog.initialize(),
    payment.discoverPending(),
    // Subscribes before its first read, so an upload finishing during startup is not missed.
    sync.initialize()
  ])
  // Discovery can fail before the shift authority context exists; ask again once it does, so a
  // claimed attempt is never invisible after a reload.
  await payment.discoverPending()

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
      :abandon-warning="
        blockingRecovery?.legacyDispatchUnknown
          ? t('pos.recovery.legacyCancelWarning')
          : t('pos.payment.completion.abandonWarning')
      "
      :confirm-abandon-label="t('pos.payment.completion.confirmAbandon')"
      :cancel-confirm-label="t('common.cancel')"
      :retry-available="blockingRecovery?.needsSupport !== true"
      :blocked-detail="recoveryDetail(blockingRecovery) ?? null"
      @retry="handleRetryAttempt"
      @abandon="handleAbandonAttempt"
      @acknowledge="handleAcknowledgeAttempt"
    />

    <PosWorkspaceShell
      :sheet-open="cartSheetOpen"
      :catalog-label="t('pos.catalogLabel')"
      :cart-label="t('pos.cart.title')"
      :resize-label="t('pos.layout.resizeCart')"
      :reset-width-label="t('pos.layout.resetCartWidth')"
      :width-value-text="(value: number) => t('pos.layout.cartWidthValue', { value })"
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
          :show-action="false"
          @refresh="handleRefreshCatalog"
        >
          <template v-if="cartState.kind === 'invalid' && catalogUsableForDraft" #revision-action>
            <AppButton variant="secondary" size="sm" @click="prepareCartRebuild">
              {{ t('pos.notices.reviewRebuild') }}
            </AppButton>
          </template>
        </CatalogRefreshPanel>
        <PhysicalPresenceNotice />
        <AutoPrintNotices />

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
                :loading="isRefreshingCatalog || catalogRefreshing"
                @click="handleRefreshCatalog"
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
              :disabled="!canAddToCart"
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
              :disabled="lines.length === 0 || attemptProtected"
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

          <div class="flex flex-none flex-col gap-2.5 pt-3">
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
            <div v-if="touchMode" class="pos-page__touch-bar" data-testid="touch-action-bar">
              <QuickActionsBar
                :actions="touchActions"
                layout="wrap"
                :label="t('touch.actions.label')"
                @action="handleTouchAction"
              />
            </div>
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

          <p
            v-if="lastSale && lines.length === 0"
            class="pos-page__last-sale mx-4 mt-2 flex flex-wrap gap-x-2 text-sm text-muted"
            role="status"
          >
            <span>{{ t('pos.lastSale.total', { total: lastSale.total }) }}</span>
            <span v-if="lastSale.change"
              >· {{ t('pos.lastSale.change', { change: lastSale.change }) }}</span
            >
          </p>
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
              :disabled="!canEdit || !attemptSettled"
              :edit-quantity-label="
                touchMode ? t('touch.quantity.editOf', { name: line.name }) : null
              "
              @edit-quantity="openQuantityKeypad(line.id)"
              @decrease="cart.decrementQuantity(line.id)"
              @increase="cart.incrementQuantity(line.id)"
              @remove="cart.remove(line.id)"
            />
            <template v-if="!paymentPanelOpen" #footer>
              <OrderTotals
                class="mx-4 mt-3"
                framed
                :subtotal-label="summaryFirstLabel"
                :subtotal="money(summaryFirstAmount)"
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
                  aria-keyshortcuts="F9"
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
          <PaymentPanel
            ref="paymentPanelRef"
            :keypad-labels="keypadLabels"
            class="pos-page__payment"
            :open="paymentPanelOpen"
            :title="t('pos.payment.title')"
            :status-chip-label="t('pos.tender.statusChip')"
            :close-label="t('common.close')"
            :subtotal-label="summaryFirstLabel"
            :subtotal="money(summaryFirstAmount)"
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
            :draft-amount-error="
              draftErrorCode ? t(`pos.payment.errors.${draftErrorCode}`) : undefined
            "
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
            :confirm-abandon-label="t('pos.payment.completion.confirmAbandon')"
            :cancel-confirm-label="t('common.cancel')"
            :print-receipt-label="t('pos.payment.printReceipt')"
            :quick-tenders="quickTenders"
            :quick-tenders-label="t('pos.quickSale.quickCash')"
            :exact-cash="exactCashAction"
            :add-remaining="addRemainingAction"
            :scanner-notice="scannerNotice"
            :large-change-warning="largeChangeWarning"
            :collecting-hint="collectingScan ? t('pos.scanner.collecting') : null"
            :held-scans-notice="
              heldScansAckFailed && heldScans.length > 0
                ? t('pos.scanner.heldScans', { count: heldScans.length })
                : null
            "
            primary-key-hint="F9"
            print-key-hint="Ctrl+P"
            :key-descriptions="{
              complete: t('pos.keys.complete'),
              'exact-cash': t('pos.keys.exactCash'),
              retry: t('pos.keys.retry'),
              'confirm-abandon': t('pos.keys.confirmAbandon'),
              print: t('pos.keys.print'),
              acknowledge: t('pos.keys.acknowledge')
            }"
            :abandon-warning="
              attemptRecovery?.legacyDispatchUnknown || blockingRecovery?.legacyDispatchUnknown
                ? t('pos.recovery.legacyCancelWarning')
                : t('pos.payment.completion.abandonWarning')
            "
            @exact-cash="handleExactCash"
            @add-remaining="handleAddRemaining"
            @close="closePaymentPanel"
            @select-method="selectPaymentMethod"
            @edit-row="editPaymentRow"
            @remove-row="payment.removeRow"
            @update:draft-amount="payment.setDraftAmountText"
            @update:draft-reference="payment.setDraftReferenceText"
            @commit-draft="commitPaymentDraft"
            @cancel-draft="payment.cancelDraftRow"
            @fill-due="fillDue"
            @quick-tender="handleQuickTender"
            @complete="handleComplete"
            @refresh-workstation="handleRefreshCatalog"
            @retry="handleRetryAttempt"
            @abandon="handleAbandonAttempt"
            @acknowledge="handleAcknowledgeAttempt"
            @print="handlePrintReceipt"
          >
            <template v-if="completedInvoiceUuid" #done-extra>
              <AutoPrintSaleStatus :invoice-local-uuid="completedInvoiceUuid" />
            </template>
            <template #actions>
              <AppButton
                v-if="paymentPanelRecoveryState.kind === 'clear'"
                variant="ghost"
                size="lg"
                :disabled="completionPending"
                @click="closePaymentPanel"
              >
                {{ t('pos.quickSale.backToCart') }}
              </AppButton>
            </template>
          </PaymentPanel>
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
      :size="
        dialogMode === 'rebuild'
          ? 'lg'
          : dialogMode === 'customers' || dialogMode === 'held'
            ? 'md'
            : 'sm'
      "
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
          <div
            v-for="shortcut in [
              ['F3', t('pos.quickSale.shortcutScan')],
              ['F4', t('pos.quickSale.hold')],
              ['F6', t('pos.quickSale.recall')],
              ['F7', t('pos.quickSale.customer')],
              ['F8', t('pos.discount')],
              ['F9', t('pos.quickSale.shortcutPay')],
              ['Shift+F9', t('pos.exactCash.shortcut')],
              ['F10', t('pos.quickSale.refund')],
              ['Ctrl+P', t('pos.keys.print')],
              ['3*', t('pos.quickSale.shortcutMultiplier')]
            ]"
            :key="shortcut[0]"
            class="flex items-center gap-3.5 border-b border-line py-2.5"
          >
            <dt>
              <AppKbd class="min-w-14">{{ shortcut[0] }}</AppKbd>
            </dt>
            <dd>{{ shortcut[1] }}</dd>
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
              :class="
                row.oldPrice === row.newPrice &&
                !row.taxChanged &&
                !row.removed &&
                !row.nameChanged &&
                !row.trackingChanged
                  ? 'text-ok'
                  : 'text-warn'
              "
            >
              <AppIcon
                :name="
                  row.oldPrice === row.newPrice &&
                  !row.taxChanged &&
                  !row.removed &&
                  !row.nameChanged &&
                  !row.trackingChanged
                    ? 'check'
                    : 'published_with_changes'
                "
                :size="18"
              />
              <template v-if="row.removed">{{ t('pos.rebuildTable.removed') }}</template>
              <template v-else>
                {{ row.oldPrice === row.newPrice ? t('pos.rebuildTable.same') : row.newPrice }}
              </template>
              <span v-if="row.taxChanged">· {{ t('pos.rebuildTaxChanged') }}</span>
              <span v-if="row.nameChanged">· {{ t('pos.rebuildTable.nameChanged') }}</span>
              <span v-if="row.trackingChanged">· {{ t('pos.rebuildTable.trackingChanged') }}</span>
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
        <!-- Stage 5: touch keypad for the discount (pointer presses keep the field focused). -->
        <NumericKeypad
          v-if="touchMode && invoiceDiscountSelection !== 'none'"
          :backspace-label="t('touch.keypad.backspace')"
          :clear-label="t('touch.keypad.clear')"
          :decimal-label="t('touch.keypad.decimal')"
          @press="
            (key) => {
              invoiceDiscountDraft = applyKeypadKey(
                invoiceDiscountDraft,
                key,
                invoiceDiscountSelection === 'fixed' ? currencyExponent : 2
              )
              invoiceDiscountError = null
            }
          "
        />
      </template>
      <template v-if="dialogMode === 'customers'" #actions>
        <AppButton variant="secondary" class="me-auto" @click="useWalkInCustomer">
          {{ t('pos.customerDialog.useWalkIn') }}
        </AppButton>
        <AppButton
          v-if="quickCreateStore.access.customer"
          variant="secondary"
          icon="person_add"
          data-testid="customer-dialog-new"
          @click="openNewCustomerFromSelector"
        >
          {{ t('pos.customerDialog.newCustomer') }}
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

    <!-- POS improvements, Stage 3: More actions (register quick-create). -->
    <AppDialog
      :open="moreActionsOpen"
      size="sm"
      :close-label="t('common.close')"
      data-testid="more-actions-dialog"
      @close="closeOverlay(() => (moreActionsOpen = false))"
    >
      <template #title>{{ t('pos.moreActions.title') }}</template>
      <div class="flex flex-col gap-2">
        <AppButton
          v-for="kind in moreActions"
          :key="kind"
          variant="secondary"
          size="lg"
          full-width
          :icon="
            kind === 'customer' ? 'person_add' : kind === 'product' ? 'inventory' : 'storefront'
          "
          :data-testid="`more-actions-${kind}`"
          @click="chooseMoreAction(kind)"
        >
          {{ t(`quickCreate.menu.${kind}`) }}
        </AppButton>
      </div>
    </AppDialog>

    <!-- POS improvements, Stage 5: touch quantity keypad for one cart line. -->
    <AppDialog
      :open="quantityKeypadLineId !== null"
      size="sm"
      :close-label="t('common.close')"
      data-testid="quantity-keypad-dialog"
      @close="closeOverlay(() => (quantityKeypadLineId = null))"
    >
      <template #title>{{ t('touch.quantity.title') }}</template>
      <div class="flex flex-col gap-3">
        <output
          class="numeric rounded-md border border-control bg-surf px-3 py-2 text-end text-2xl font-bold"
          data-testid="quantity-keypad-value"
          aria-live="polite"
          >{{ quantityKeypadDraft || '0' }}</output
        >
        <AppInlineError v-if="quantityKeypadError">{{ quantityKeypadError }}</AppInlineError>
        <NumericKeypad
          :backspace-label="t('touch.keypad.backspace')"
          :clear-label="t('touch.keypad.clear')"
          :decimal-label="t('touch.keypad.decimal')"
          @press="pressQuantityKey"
        />
        <AppButton
          size="lg"
          full-width
          data-testid="quantity-keypad-apply"
          @click="applyQuantityKeypad"
          >{{ t('touch.quantity.apply') }}</AppButton
        >
      </div>
    </AppDialog>

    <!-- POS improvements, Stage 3: Return / Refund (choose the original sale, then the refund flow). -->
    <RefundEntryDialog
      v-if="refundEntryOpen"
      :open="refundEntryOpen"
      @close="closeOverlay(() => (refundEntryOpen = false))"
      @select="selectRefundInvoice"
    />
    <RefundDialog
      v-if="refundInvoiceUuid !== null"
      :open="refundInvoiceUuid !== null"
      :invoice-local-uuid="refundInvoiceUuid"
      @close="closeRefund"
    />

    <!-- POS improvements: register quick-create (customer, product, supplier). -->
    <QuickCreateDialog
      v-if="quickCreateKind !== null"
      :open="quickCreateKind !== null"
      :kind="quickCreateKind"
      :initial-name="quickCreateName"
      @close="closeOverlay(() => (quickCreateKind = null))"
      @created="handleQuickCreated"
    />
    <AppToast
      v-if="quickCreateNotice"
      variant="success"
      :dismiss-label="t('common.close')"
      data-testid="quick-create-notice"
      @dismiss="quickCreateNotice = null"
      >{{ quickCreateNotice }}</AppToast
    >
  </section>
</template>
