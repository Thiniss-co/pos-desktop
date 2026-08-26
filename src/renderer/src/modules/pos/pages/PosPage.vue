<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import type { CatalogProduct } from '@shared/contracts/catalog.contract'
import type { LocaleCode } from '@shared/contracts/preferences.contract'
import type { ShiftPhase } from '@renderer/shared/components/pos/types'
import { useBootstrapStore } from '@renderer/modules/bootstrap/store'
import { useLocaleStore } from '@renderer/modules/preferences/locale.store'
import {
  formatCurrency,
  formatDateTime,
  formatRelativeDateTime
} from '@renderer/shared/utils/format'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppDialog from '@renderer/shared/components/common/AppDialog.vue'
import AppEmptyState from '@renderer/shared/components/feedback/AppEmptyState.vue'
import AppInlineError from '@renderer/shared/components/feedback/AppInlineError.vue'
import AppLoadingSkeleton from '@renderer/shared/components/feedback/AppLoadingSkeleton.vue'
import AppStatusChip from '@renderer/shared/components/feedback/AppStatusChip.vue'
import AppInput from '@renderer/shared/components/forms/AppInput.vue'
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
import { useCartStore } from '../cart.store'
import { useCatalogStore } from '../catalog.store'
import { useShiftStore } from '../shift.store'
import { useBarcodeScanner } from '../useBarcodeScanner'
import { usePosShortcuts } from '../usePosShortcuts'

type DialogMode = 'open' | 'pause' | 'close' | 'help' | 'customers' | 'payment-methods' | null

/**
 * Phase 3C ships a read-only catalog. Cart line building and total calculation belong to Phase 3D,
 * so every path that would populate or price a draft sale is disabled behind this one constant.
 * The cart store and calculator stay fully implemented and tested; Phase 3D flips this to `true`.
 */
const PHASE_3D_CART_ENABLED = false

const { t } = useI18n()
const localeStore = useLocaleStore()
const bootstrap = useBootstrapStore()
const catalog = useCatalogStore()
const cart = useCartStore()
const shift = useShiftStore()
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
const { lines, calculation, error: cartError } = storeToRefs(cart)
const { currentShift, freshness, mutation, error: shiftError, canSell } = storeToRefs(shift)
const { isRunning: isRefreshingCatalog, error: bootstrapError } = storeToRefs(bootstrap)
const searchRef = ref<InstanceType<typeof ProductSearchBar> | null>(null)
const dialogMode = ref<DialogMode>(null)
const cashAmount = ref('0.00')
const cashError = ref<string | null>(null)
const note = ref('')
const lastBarcode = ref<{
  code: string
  outcome: 'found' | 'not-found' | 'ambiguous' | 'stale-catalog' | 'unavailable-catalog'
} | null>(null)
let searchTimer: number | undefined
let customerSearchTimer: number | undefined
let synchronizationAgeTimer: number | undefined
const synchronizationReferenceTime = ref(Date.now())

const activeCurrency = computed(() => lines.value[0]?.product.price.currency ?? 'EGP')
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
    lineTotal: money(calculation.value.lines[index]?.totalAmount ?? 0, line.product.price.currency)
  }))
)

function money(amount: number, currency = activeCurrency.value): string {
  return formatCurrency(amount / 100, localeStore.locale as LocaleCode, currency)
}

function paymentMethodKind(
  value: string | null
): 'cash' | 'card' | 'wallet' | 'store-credit' | 'other' {
  return value === 'cash' || value === 'card' || value === 'wallet' || value === 'store-credit'
    ? value
    : 'other'
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
  if (PHASE_3D_CART_ENABLED && canSell.value && catalogUsableForDraft.value) {
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

  if (
    PHASE_3D_CART_ENABLED &&
    result.outcome === 'found' &&
    canSell.value &&
    catalogUsableForDraft.value
  ) {
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
    if (PHASE_3D_CART_ENABLED && catalog.status?.catalogValid && catalog.status.contract) {
      cart.setContract(catalog.status.contract)
    }
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

onBeforeUnmount(() => {
  window.clearTimeout(searchTimer)
  window.clearTimeout(customerSearchTimer)
  window.clearInterval(synchronizationAgeTimer)
})

onMounted(async () => {
  synchronizationAgeTimer = window.setInterval(() => {
    synchronizationReferenceTime.value = Date.now()
  }, 60_000)
  await Promise.all([shift.loadCurrent(), catalog.initialize()])

  if (PHASE_3D_CART_ENABLED && catalog.status?.catalogValid && catalog.status.contract) {
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
            <AppButton
              v-if="PHASE_3D_CART_ENABLED"
              variant="ghost"
              :disabled="lines.length === 0"
              @click="cart.clear"
            >
              {{ t('pos.clearCart') }}
            </AppButton>
          </div>
          <AppEmptyState
            v-if="!PHASE_3D_CART_ENABLED"
            :title="t('pos.cartPhaseFour')"
            :description="t('pos.cartPhaseFourDescription')"
          />
          <template v-else>
            <AppInlineError v-if="cartError">{{ cartError }}</AppInlineError>
            <p v-if="!canSell" class="pos-page__cart-guard">{{ t('pos.openShiftToSell') }}</p>
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
                @decrease="cart.changeQuantity(line.id, -1000n)"
                @increase="cart.changeQuantity(line.id, 1000n)"
                @remove="cart.remove(line.id)"
              />
              <template #footer>
                <OrderTotals
                  :subtotal-label="t('pos.subtotal')"
                  :subtotal="money(calculation.subtotalAmount)"
                  :tax-label="t('pos.tax')"
                  :tax="money(calculation.taxTotalAmount)"
                  :total-label="t('pos.total')"
                  :total="money(calculation.grandTotalAmount)"
                />
                <AppButton
                  class="pos-page__future-action"
                  variant="transaction"
                  full-width
                  disabled
                >
                  {{ t('pos.checkoutPhaseFour') }}
                </AppButton>
              </template>
            </CartPanel>
          </template>
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
          :loading="mutation !== null"
          @click="submitDialog"
        >
          {{ t('common.confirm') }}
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
