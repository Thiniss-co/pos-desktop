<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import type { CatalogProduct, PaymentMethodType } from '@shared/contracts/catalog.contract'
import type { CheckoutIntent } from '@shared/contracts/checkout.contract'
import type { LocaleCode } from '@shared/contracts/preferences.contract'
import type {
  DisplayPaymentMethodOption,
  DisplaySplitPayment,
  ShiftPhase
} from '@renderer/shared/components/pos/types'
import { useBootstrapStore } from '@renderer/modules/bootstrap/store'
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
import BarcodeFeedback from '@renderer/shared/components/pos/BarcodeFeedback.vue'
import CartLineItem from '@renderer/shared/components/pos/CartLineItem.vue'
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
import { useCartStore } from '../cart.store'
import { useCatalogStore } from '../catalog.store'
import { usePaymentStore } from '../payment.store'
import { useShiftStore } from '../shift.store'
import { useBarcodeScanner } from '../useBarcodeScanner'
import { usePosShortcuts } from '../usePosShortcuts'

type DialogMode =
  | 'open'
  | 'pause'
  | 'close'
  | 'help'
  | 'customers'
  | 'payment-methods'
  | 'rebuild'
  | 'discount'
  | null

type InvoiceDiscountSelection = 'none' | 'fixed' | 'percentage'

const { t } = useI18n()
const localeStore = useLocaleStore()
const bootstrap = useBootstrapStore()
const catalog = useCatalogStore()
const cart = useCartStore()
const shift = useShiftStore()
const payment = usePaymentStore()
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
  error: catalogError
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
const { currentShift, freshness, mutation, error: shiftError, canSell } = storeToRefs(shift)
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
  previewError
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
const lastBarcode = ref<{
  code: string
  outcome: 'found' | 'not-found' | 'ambiguous' | 'stale-catalog' | 'unavailable-catalog'
} | null>(null)
const paymentPanelOpen = ref(false)
let searchTimer: number | undefined
let customerSearchTimer: number | undefined
let previewTimer: number | undefined
let synchronizationAgeTimer: number | undefined
const synchronizationReferenceTime = ref(Date.now())

const activeCurrency = computed(() => cartContract.value?.currency ?? 'EGP')
const currencyExponent = computed(() => cartContract.value?.currencyExponent ?? 2)
const shiftPhase = computed<ShiftPhase>(
  () => mutation.value ?? currentShift.value?.status ?? 'closed'
)
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
  if (canSell.value && catalogUsableForDraft.value) {
    const currentProduct = await catalog.getProduct(uuid)

    if (currentProduct) {
      cart.addProduct(currentProduct)
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
  } else if (dialogMode.value === 'pause' && currentShift.value) {
    succeeded = await shift.pause({
      uuid: currentShift.value.uuid,
      reason: note.value || null,
      notes: null
    })
  } else if (dialogMode.value === 'close' && currentShift.value && amount !== null) {
    succeeded = await shift.close({
      uuid: currentShift.value.uuid,
      actualCashAmount: amount,
      closeNotes: note.value || null
    })
  }

  if (succeeded) {
    dialogMode.value = null
  }
}

async function resumeShift(): Promise<void> {
  if (currentShift.value) {
    await shift.resume({ uuid: currentShift.value.uuid, resumeNotes: null })
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
  () => currentShift.value?.uuid ?? null,
  (current, previous) => {
    if (previous !== undefined && current !== previous) {
      cart.resetDraft('shift-changed')
      payment.resetPayment()
      paymentPanelOpen.value = false
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
})

onMounted(async () => {
  synchronizationAgeTimer = window.setInterval(() => {
    synchronizationReferenceTime.value = Date.now()
  }, 60_000)
  await Promise.all([shift.loadCurrent(), catalog.initialize()])

  if (catalog.status?.catalogValid && catalog.status.contract) {
    cart.setContract(catalog.status.contract)
  }
})
</script>

<template>
  <section class="pos-page">
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
            <AppStatusChip variant="information">{{ t('pos.syncPlaceholder') }}</AppStatusChip>
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
        <AppInlineError v-if="freshness === 'unknown'">{{
          t('pos.shiftUnknownHelp')
        }}</AppInlineError>
        <AppInlineError v-if="catalogStatus === 'stale'">{{
          t('pos.catalogStaleWarning')
        }}</AppInlineError>
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
        <BarcodeFeedback v-if="lastBarcode" :outcome="lastBarcode.outcome" :code="lastBarcode.code">
          {{ t(`pos.barcode.${lastBarcode.outcome}`) }}
        </BarcodeFeedback>
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
            :disabled="!canSell || !catalogUsableForDraft"
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
            <AppButton variant="ghost" :disabled="lines.length === 0" @click="cart.clear">
              {{ t('pos.clearCart') }}
            </AppButton>
          </div>
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
              :disabled="!canEdit"
              @decrease="cart.decrementQuantity(line.id)"
              @increase="cart.incrementQuantity(line.id)"
              @remove="cart.remove(line.id)"
            />
            <template #footer>
              <AppButton
                variant="ghost"
                :disabled="lines.length === 0 || !canEdit"
                @click="openInvoiceDiscountDialog"
              >
                {{ t('pos.discount') }}
              </AppButton>
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
                @click="openPaymentPanel"
              >
                {{
                  canOpenPaymentPanel
                    ? t('pos.payment.proceedToPayment')
                    : t('pos.checkoutUnavailable')
                }}
              </AppButton>
            </template>
          </CartPanel>
        </div>
      </template>
    </PosWorkspaceShell>

    <PaymentPanel
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
      :draft-amount-error="draftErrorCode ? t(`pos.payment.errors.${draftErrorCode}`) : undefined"
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
      @close="closePaymentPanel"
      @select-method="selectPaymentMethod"
      @edit-row="editPaymentRow"
      @remove-row="payment.removeRow"
      @update:draft-amount="payment.setDraftAmountText"
      @update:draft-reference="payment.setDraftReferenceText"
      @commit-draft="commitPaymentDraft"
      @cancel-draft="payment.cancelDraftRow"
    >
      <template #actions>
        <AppButton variant="ghost" @click="closePaymentPanel">{{ t('common.close') }}</AppButton>
      </template>
    </PaymentPanel>

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
            dialogMode !== 'help' && dialogMode !== 'customers' && dialogMode !== 'payment-methods'
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
  overflow: hidden;
  border: 1px solid var(--color-outline-variant);
  border-inline-start: 4px solid var(--color-transaction-accent);
  border-radius: var(--radius-lg);
  background: var(--color-surface-container-lowest);
}

.pos-page__cart-heading {
  padding: var(--space-4);
  border-block-end: 1px solid var(--color-divider-subtle);
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
