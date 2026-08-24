<script setup lang="ts">
/**
 * Dev-only design gallery for Phase 3 screens that have no production route yet. Renders the
 * shared/components/pos/* library against typed immutable fixtures — no IPC, no HTTP, no SQLite,
 * no business store. Only reachable when `import.meta.env.DEV` is true (see routes.ts); the
 * startupGuard bypass for `meta.devOnly` and the production-build exclusion are both covered by
 * tests (guards.test.ts, devGallery.exclusion.test.ts).
 */
import { ref } from 'vue'
import AppBanner from '@renderer/shared/components/feedback/AppBanner.vue'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppConfirmDialog from '@renderer/shared/components/common/AppConfirmDialog.vue'
import AppEmptyState from '@renderer/shared/components/feedback/AppEmptyState.vue'
import AppInlineError from '@renderer/shared/components/feedback/AppInlineError.vue'
import AppLoadingSkeleton from '@renderer/shared/components/feedback/AppLoadingSkeleton.vue'
import AppPanel from '@renderer/shared/components/common/AppPanel.vue'
import AppToast from '@renderer/shared/components/feedback/AppToast.vue'
import PageHeader from '@renderer/shared/components/layout/PageHeader.vue'
import ActionBar from '@renderer/shared/components/pos/ActionBar.vue'
import BarcodeFeedback from '@renderer/shared/components/pos/BarcodeFeedback.vue'
import CartLineItem from '@renderer/shared/components/pos/CartLineItem.vue'
import CartPanel from '@renderer/shared/components/pos/CartPanel.vue'
import CategorySelector from '@renderer/shared/components/pos/CategorySelector.vue'
import CommercialAccessNotice from '@renderer/shared/components/pos/CommercialAccessNotice.vue'
import CustomerSelector from '@renderer/shared/components/pos/CustomerSelector.vue'
import DiscountControl from '@renderer/shared/components/pos/DiscountControl.vue'
import NumericAmountInput from '@renderer/shared/components/pos/NumericAmountInput.vue'
import OrderTotals from '@renderer/shared/components/pos/OrderTotals.vue'
import PaymentDialog from '@renderer/shared/components/pos/PaymentDialog.vue'
import PaymentMethodTile from '@renderer/shared/components/pos/PaymentMethodTile.vue'
import PermissionNotice from '@renderer/shared/components/pos/PermissionNotice.vue'
import ProductCard from '@renderer/shared/components/pos/ProductCard.vue'
import ProductRow from '@renderer/shared/components/pos/ProductRow.vue'
import ProductSearchBar from '@renderer/shared/components/pos/ProductSearchBar.vue'
import ShiftStatusControl from '@renderer/shared/components/pos/ShiftStatusControl.vue'
import SplitPaymentRow from '@renderer/shared/components/pos/SplitPaymentRow.vue'
import StockStatus from '@renderer/shared/components/pos/StockStatus.vue'
import SyncStateNotice from '@renderer/shared/components/pos/SyncStateNotice.vue'
import type { ShiftPhase, SyncQueueDisplayState } from '@renderer/shared/components/pos/types'
import {
  categoryFixtures,
  customerFixtures,
  emptyCartFixture,
  longCartFixture,
  paymentMethodFixtures,
  populatedCartFixture,
  productFixtures,
  splitPaymentFixtures
} from '../fixtures'

const shiftPhases: readonly ShiftPhase[] = [
  'closed',
  'opening',
  'open',
  'pausing',
  'paused',
  'resuming',
  'closing'
]
const syncStates: readonly SyncQueueDisplayState[] = [
  'pending',
  'uploading',
  'retryable-error',
  'conflict',
  'rejected'
]

const searchQuery = ref('')
const selectedCategory = ref<string | null>(null)
const customerQuery = ref('')
const discountValue = ref('')
const confirmOpen = ref(false)
const paymentDialogOpen = ref(false)
const selectedPaymentMethod = ref<string | null>('cash')
const cashAmount = ref('20.00')
const toastVisible = ref(true)
</script>

<template>
  <div class="dev-gallery">
    <PageHeader
      eyebrow="Development only — never routed in production"
      title="Modern Ledger design gallery"
      description="Phase 3 presentational components rendered against fixed fixtures. Nothing on this page reads or writes real business state."
    />

    <section class="dev-gallery__section">
      <h3>Shift lifecycle</h3>
      <AppPanel class="dev-gallery__grid">
        <ShiftStatusControl
          v-for="phase in shiftPhases"
          :key="phase"
          :phase="phase"
          :phase-label="phase"
          open-label="Open shift"
          pause-label="Pause"
          resume-label="Resume"
          close-label="Close shift"
        />
      </AppPanel>
    </section>

    <section class="dev-gallery__section">
      <h3>Product search, categories, stock</h3>
      <AppPanel class="dev-gallery__stack">
        <ProductSearchBar
          v-model="searchQuery"
          label="Search products"
          placeholder="Scan or type…"
        />
        <CategorySelector
          :categories="categoryFixtures"
          :selected-id="selectedCategory"
          all-label="All categories"
          @select="(id) => (selectedCategory = id)"
        />
        <div class="dev-gallery__grid">
          <ProductCard
            v-for="product in productFixtures"
            :key="product.id"
            :product="product"
            stock-label="Stock"
          />
        </div>
        <ProductRow
          v-for="product in productFixtures"
          :key="`row-${product.id}`"
          :product="product"
          stock-label="Stock"
        />
        <AppEmptyState
          title="No products match this search"
          description="Try a different name, SKU, or category."
        />
        <div class="dev-gallery__row">
          <StockStatus level="in-stock" label="In stock" />
          <StockStatus level="low-stock" label="Low stock" />
          <StockStatus level="out-of-stock" label="Out of stock" />
        </div>
      </AppPanel>
    </section>

    <section class="dev-gallery__section">
      <h3>Barcode feedback</h3>
      <AppPanel class="dev-gallery__stack">
        <BarcodeFeedback outcome="found" code="6291041500123">Added to cart</BarcodeFeedback>
        <BarcodeFeedback outcome="not-found" code="0000000000000"
          >No matching product</BarcodeFeedback
        >
      </AppPanel>
    </section>

    <section class="dev-gallery__section">
      <h3>Cart — empty, populated, long</h3>
      <div class="dev-gallery__row dev-gallery__row--carts">
        <AppPanel :padded="false" class="dev-gallery__cart-demo">
          <CartPanel
            :lines="emptyCartFixture"
            empty-title="Cart is empty"
            empty-description="Scan a product to begin."
          />
        </AppPanel>
        <AppPanel :padded="false" class="dev-gallery__cart-demo">
          <CartPanel :lines="populatedCartFixture" empty-title="Cart is empty">
            <CartLineItem
              v-for="line in populatedCartFixture"
              :key="line.id"
              :line="line"
              decrease-label="Decrease quantity"
              increase-label="Increase quantity"
              remove-label="Remove line"
            />
            <template #footer>
              <OrderTotals
                subtotal-label="Subtotal"
                subtotal="$21.25"
                tax-label="Tax"
                tax="$1.06"
                total-label="Total"
                total="$22.31"
              />
            </template>
          </CartPanel>
        </AppPanel>
        <AppPanel :padded="false" class="dev-gallery__cart-demo dev-gallery__cart-demo--scroll">
          <CartPanel :lines="longCartFixture" empty-title="Cart is empty">
            <CartLineItem
              v-for="line in longCartFixture"
              :key="line.id"
              :line="line"
              decrease-label="Decrease quantity"
              increase-label="Increase quantity"
              remove-label="Remove line"
            />
          </CartPanel>
        </AppPanel>
      </div>
    </section>

    <section class="dev-gallery__section">
      <h3>Discount, tax, clear-cart confirmation</h3>
      <AppPanel class="dev-gallery__stack">
        <DiscountControl v-model="discountValue" label="Discount code" apply-label="Apply" />
        <OrderTotals
          subtotal-label="Subtotal"
          subtotal="$21.25"
          discount-label="Discount"
          discount="$2.00"
          tax-label="Tax"
          tax="$0.96"
          total-label="Total"
          total="$20.21"
        />
        <AppButton variant="danger" @click="confirmOpen = true">Clear cart…</AppButton>
        <AppConfirmDialog
          :open="confirmOpen"
          title="Clear cart?"
          message="This removes every line from the current sale. This cannot be undone."
          confirm-label="Clear cart"
          cancel-label="Cancel"
          @confirm="confirmOpen = false"
          @cancel="confirmOpen = false"
        />
      </AppPanel>
    </section>

    <section class="dev-gallery__section">
      <h3>Customer selection</h3>
      <AppPanel class="dev-gallery__stack">
        <CustomerSelector
          v-model:query="customerQuery"
          search-label="Find a customer"
          :results="customerFixtures"
          :selected-id="null"
          empty-title="No customers match this search"
        />
      </AppPanel>
    </section>

    <section class="dev-gallery__section">
      <h3>Payment — method, cash, split, validation</h3>
      <AppPanel class="dev-gallery__stack">
        <AppButton @click="paymentDialogOpen = true">Open payment dialog</AppButton>
        <PaymentDialog
          :open="paymentDialogOpen"
          title="Take payment"
          :methods="paymentMethodFixtures"
          :selected-method-id="selectedPaymentMethod"
          @close="paymentDialogOpen = false"
          @select-method="(id) => (selectedPaymentMethod = id)"
        >
          <NumericAmountInput v-model="cashAmount" label="Cash received" />
          <template #actions>
            <AppButton variant="ghost" @click="paymentDialogOpen = false">Cancel</AppButton>
            <AppButton variant="transaction" @click="paymentDialogOpen = false"
              >Complete sale</AppButton
            >
          </template>
        </PaymentDialog>

        <div class="dev-gallery__grid">
          <PaymentMethodTile
            v-for="method in paymentMethodFixtures"
            :key="method.id"
            :method="method"
            :selected="method.id === selectedPaymentMethod"
            @select="selectedPaymentMethod = method.id"
          />
        </div>

        <NumericAmountInput v-model="cashAmount" label="Exact cash" />
        <NumericAmountInput
          model-value="5.00"
          label="Cash received"
          error="Insufficient — sale total is $22.31"
        />

        <SplitPaymentRow
          v-for="payment in splitPaymentFixtures"
          :key="payment.id"
          :payment="payment"
          remove-label="Remove payment"
        />

        <ActionBar>
          <template #info>
            <span class="numeric">Balance due: $0.00</span>
          </template>
          <AppButton variant="ghost">Cancel sale</AppButton>
          <AppButton variant="transaction" loading>Processing…</AppButton>
        </ActionBar>
      </AppPanel>
    </section>

    <section class="dev-gallery__section">
      <h3>Checkout outcome</h3>
      <AppPanel class="dev-gallery__stack">
        <AppBanner variant="success" role="status">Sale completed and saved locally.</AppBanner>
        <AppBanner variant="error" role="alert"
          >The sale could not be saved locally. Try again.</AppBanner
        >
      </AppPanel>
    </section>

    <section class="dev-gallery__section">
      <h3>Sync queue states</h3>
      <AppPanel class="dev-gallery__stack">
        <SyncStateNotice v-for="state in syncStates" :key="state" :state="state">
          {{ state }} — 3 records
        </SyncStateNotice>
      </AppPanel>
    </section>

    <section class="dev-gallery__section">
      <h3>Access, license, and permission notices</h3>
      <AppPanel class="dev-gallery__stack">
        <CommercialAccessNotice severity="warning">
          License grace period — 4 days remaining.
        </CommercialAccessNotice>
        <CommercialAccessNotice severity="error"
          >License expired. Contact your administrator.</CommercialAccessNotice
        >
        <CommercialAccessNotice severity="error"
          >This company's subscription is inactive.</CommercialAccessNotice
        >
        <PermissionNotice
          >Your session was ended by an administrator. Sign in again.</PermissionNotice
        >
        <PermissionNotice
          >This device is no longer authorized. Contact your administrator.</PermissionNotice
        >
        <PermissionNotice>You do not have permission to perform this action.</PermissionNotice>
      </AppPanel>
    </section>

    <section class="dev-gallery__section">
      <h3>Loading, empty, validation, disabled, toast</h3>
      <AppPanel class="dev-gallery__stack">
        <AppLoadingSkeleton label="Loading" />
        <AppEmptyState
          title="Nothing here yet"
          description="Results will appear as they become available."
        />
        <AppInlineError>This field is required.</AppInlineError>
        <AppButton disabled>Disabled action</AppButton>
        <AppButton v-if="toastVisible" variant="ghost" @click="toastVisible = false"
          >Show toast dismissed</AppButton
        >
        <AppToast
          v-if="toastVisible"
          variant="warning"
          dismiss-label="Dismiss"
          @dismiss="toastVisible = false"
        >
          Your theme choice could not be saved.
        </AppToast>
      </AppPanel>
    </section>
  </div>
</template>

<style scoped>
.dev-gallery {
  display: flex;
  flex-direction: column;
  gap: var(--space-8);
  padding-block-end: var(--space-8);
}

.dev-gallery__section h3 {
  margin-block-end: var(--space-3);
  font-size: var(--text-headline-sm-size);
  color: var(--color-on-surface);
}

.dev-gallery__stack {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.dev-gallery__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
  gap: var(--space-3);
}

.dev-gallery__row {
  display: flex;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.dev-gallery__row--carts {
  align-items: stretch;
}

.dev-gallery__cart-demo {
  flex: 1;
  min-width: 16rem;
  height: 20rem;
}

.dev-gallery__cart-demo--scroll {
  overflow: hidden;
}
</style>
