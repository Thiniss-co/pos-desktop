<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import type { LocaleCode } from '@shared/contracts/preferences.contract'
import { formatMinorCurrency } from '@shared/money/minorUnits'
import { useRefundsStore } from '../store'
import { useLocaleStore } from '@renderer/modules/preferences/locale.store'
import { useCatalogStore } from '@renderer/modules/pos/catalog.store'
import AppDialog from '@renderer/shared/components/common/AppDialog.vue'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppTable from '@renderer/shared/components/common/AppTable.vue'
import AppCheckbox from '@renderer/shared/components/forms/AppCheckbox.vue'
import AppSelect from '@renderer/shared/components/forms/AppSelect.vue'
import AppInput from '@renderer/shared/components/forms/AppInput.vue'
import AppBanner from '@renderer/shared/components/feedback/AppBanner.vue'
import AppLoadingSkeleton from '@renderer/shared/components/feedback/AppLoadingSkeleton.vue'
import OrderTotals from '@renderer/shared/components/pos/OrderTotals.vue'
import RefundLineRow from '@renderer/shared/components/pos/RefundLineRow.vue'

/**
 * Plan §6 -- the refund action, in full. Reached from the sale-detail page's "Return / Refund"
 * button. Steps: select lines/quantities -> review totals, stock-return toggle, refund method ->
 * confirm -> result. Renders in English/Arabic (RTL follows the app-wide `dir` from the locale
 * store), is keyboard-navigable (inherited from `AppDialog`'s focus trap), and uses only shared,
 * already-responsive components.
 */
const props = defineProps<{ open: boolean; invoiceLocalUuid: string | null }>()
const emit = defineEmits<{ close: [] }>()

const store = useRefundsStore()
const {
  refundable,
  isLoadingRefundable,
  selection,
  hasSelection,
  stockReturned,
  paymentMethodUuid,
  reference,
  reason,
  notes,
  preview,
  isPreviewing,
  outcome,
  isSubmitting,
  error
} = storeToRefs(store)

const localeStore = useLocaleStore()
const catalogStore = useCatalogStore()
const { paymentMethods } = storeToRefs(catalogStore)
const { t } = useI18n()

type Step = 'select' | 'review' | 'result'
const step = ref<Step>('select')

const refundSupportedMethods = computed(() =>
  paymentMethods.value.filter(
    (method) =>
      method.isActive &&
      (method.type === 'cash' || method.type === 'card' || method.type === 'other')
  )
)

const paymentOptions = computed(() => [
  { value: '', label: t('refunds.paymentMethodCash') },
  ...refundSupportedMethods.value.map((method) => ({ value: method.uuid, label: method.name }))
])

const paymentMethodModel = computed<string>({
  get: () => paymentMethodUuid.value ?? '',
  set: (value: string) => {
    paymentMethodUuid.value = value === '' ? null : value
  }
})

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen && props.invoiceLocalUuid) {
      step.value = 'select'
      void store.openForInvoice(props.invoiceLocalUuid)
    }
  },
  { immediate: true }
)

function money(amount: number): string {
  const currency = refundable.value?.currency
  const exponent = refundable.value?.currencyExponent ?? 2
  if (!currency) {
    return String(amount)
  }
  const formatted = formatMinorCurrency(
    amount,
    localeStore.locale as LocaleCode,
    currency,
    exponent
  )
  return formatted.ok ? formatted.value : '—'
}

function quantityLabel(value: string): string {
  return value
}

function quantityMilliFor(value: string): number {
  const [whole, fraction = ''] = value.split('.')
  return Number(whole) * 1000 + Number(fraction.padEnd(3, '0').slice(0, 3))
}

function feasibilityBadge(tier: 'ok' | 'soft' | 'hard'): string {
  return tier === 'soft' ? t('refunds.tierBadgeSoft') : t('refunds.tierBadgeHard')
}

async function goToReview(): Promise<void> {
  await store.requestPreview()
  if (preview.value) {
    step.value = 'review'
  }
}

async function confirmSubmit(): Promise<void> {
  await store.submit()
  step.value = 'result'
}

function close(): void {
  store.reset()
  step.value = 'select'
  emit('close')
}

async function resumeOutcome(): Promise<void> {
  if (!outcome.value) return
  await store.resume(outcome.value.localRefundUuid)
}
</script>

<template>
  <AppDialog :open="open" @close="close">
    <template #title>{{ t('refunds.dialogTitle') }}</template>

    <div v-if="isLoadingRefundable">
      <AppLoadingSkeleton :label="t('common.loading')" :lines="4" />
    </div>

    <div v-else-if="error && step === 'select'">
      <AppBanner variant="error" role="alert">{{ error }}</AppBanner>
    </div>

    <div v-else-if="refundable && !refundable.refundCapable && step === 'select'">
      <AppBanner variant="warning" role="alert">
        <strong>{{ t('refunds.capabilityUnavailable') }}</strong>
        <p>{{ t('refunds.capabilityUnavailableDetail') }}</p>
      </AppBanner>
    </div>

    <div v-else-if="refundable && step === 'select'" class="refund-dialog__select">
      <p class="refund-dialog__meta numeric">
        {{ t('refunds.originalInvoice') }}: {{ refundable.displayNumber }} ·
        {{ t('refunds.soldAt') }}: {{ refundable.soldAt }}
      </p>

      <p v-if="refundable.lines.length === 0">{{ t('refunds.noRefundableQuantity') }}</p>

      <AppTable v-else>
        <thead>
          <tr>
            <th scope="col">{{ t('refunds.productName') }}</th>
            <th scope="col">{{ t('refunds.quantitySold') }}</th>
            <th scope="col">{{ t('refunds.quantityRefunded') }}</th>
            <th scope="col">{{ t('refunds.quantityRefundable') }}</th>
            <th scope="col">{{ t('refunds.quantitySelected') }}</th>
          </tr>
        </thead>
        <tbody>
          <RefundLineRow
            v-for="line in refundable.lines"
            :key="line.invoiceItemRemoteUuid"
            :product-name="line.productName"
            :quantity-sold-label="quantityLabel(line.quantitySold)"
            :quantity-refunded-label="quantityLabel(line.quantityRefunded)"
            :quantity-refundable-label="quantityLabel(line.quantityRefundable)"
            :feasibility-tier="line.feasibility.tier"
            :feasibility-badge-label="feasibilityBadge(line.feasibility.tier)"
            :quantity-milli="selection.get(line.invoiceItemRemoteUuid) ?? 0"
            :max-quantity-milli="quantityMilliFor(line.quantityRefundable)"
            :decrease-label="t('refunds.decreaseQuantity')"
            :increase-label="t('refunds.increaseQuantity')"
            :disabled="isPreviewing"
            @update:quantity-milli="
              (value) => store.setLineQuantity(line.invoiceItemRemoteUuid, value)
            "
          />
        </tbody>
      </AppTable>

      <p
        v-if="refundable.lines.some((line) => line.feasibility.tier !== 'ok')"
        class="refund-dialog__feasibility-note"
      >
        {{ t('refunds.feasibilityBlockedNotice') }}
      </p>

      <AppCheckbox
        v-model="stockReturned"
        :label="t('refunds.stockReturned')"
        :description="t('refunds.stockReturnedHint')"
      />

      <AppBanner v-if="error" variant="error" role="alert">{{ error }}</AppBanner>
    </div>

    <div v-else-if="preview && step === 'review'" class="refund-dialog__review">
      <AppTable>
        <thead>
          <tr>
            <th scope="col">{{ t('refunds.productName') }}</th>
            <th scope="col">{{ t('refunds.quantitySelected') }}</th>
            <th scope="col">{{ t('refunds.total') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="line in preview.lines" :key="line.invoiceItemRemoteUuid">
            <td>{{ line.productName }}</td>
            <td class="numeric">{{ (line.quantityMilli / 1000).toFixed(3) }}</td>
            <td class="numeric">{{ money(line.totalAmount) }}</td>
          </tr>
        </tbody>
      </AppTable>

      <OrderTotals
        :subtotal-label="t('refunds.subtotal')"
        :subtotal="money(preview.subtotalAmount)"
        :tax-label="t('refunds.tax')"
        :tax="money(preview.taxTotalAmount)"
        :total-label="t('refunds.total')"
        :total="money(preview.grandTotalAmount)"
      />

      <AppSelect
        v-model="paymentMethodModel"
        :label="t('refunds.paymentMethod')"
        :options="paymentOptions"
      />
      <AppInput
        v-model="reference"
        :label="t('refunds.reference')"
        :hint="t('refunds.referenceHint')"
      />
      <AppInput v-model="reason" :label="t('refunds.reason')" />
      <AppInput v-model="notes" :label="t('refunds.notes')" />

      <AppBanner variant="info">{{ t('refunds.recordedNotice') }}</AppBanner>
      <AppBanner v-if="error" variant="error" role="alert">{{ error }}</AppBanner>
    </div>

    <div v-else-if="outcome && step === 'result'" class="refund-dialog__result">
      <AppBanner v-if="outcome.state === 'accepted'" variant="success">
        <strong>{{ t('refunds.success') }}</strong>
        <p>
          {{
            t('refunds.successDetail', { number: outcome.refundNumber ?? outcome.localRefundUuid })
          }}
        </p>
      </AppBanner>

      <AppBanner v-else-if="outcome.state === 'conflict'" variant="error" role="alert">
        <strong>{{ t('refunds.conflictNotice') }}</strong>
        <p class="numeric">{{ outcome.localRefundUuid }}</p>
      </AppBanner>

      <AppBanner v-else-if="outcome.state === 'unresolved'" variant="warning" role="alert">
        <strong>{{ t('refunds.pendingUnresolved') }}</strong>
      </AppBanner>

      <AppBanner v-else-if="outcome.state === 'rejected'" variant="error" role="alert">
        <strong>{{ t('refunds.rejectedNotice') }}</strong>
        <p>{{ outcome.errorCode ? t('refunds.errors.' + outcome.errorCode) : '' }}</p>
      </AppBanner>

      <AppBanner v-else variant="info">{{ t('refunds.submitting') }}</AppBanner>
    </div>
    <template #actions>
      <template v-if="refundable && refundable.refundCapable && step === 'select'">
        <AppButton variant="ghost" @click="close">{{ t('refunds.cancelAction') }}</AppButton>
        <AppButton
          variant="primary"
          :disabled="!hasSelection || isPreviewing"
          :loading="isPreviewing"
          @click="goToReview"
        >
          {{ t('refunds.previewAction') }}
        </AppButton>
      </template>

      <template v-else-if="preview && step === 'review'">
        <AppButton variant="ghost" :disabled="isSubmitting" @click="step = 'select'">
          {{ t('common.back') }}
        </AppButton>
        <AppButton
          variant="primary"
          :disabled="isSubmitting"
          :loading="isSubmitting"
          @click="confirmSubmit"
        >
          {{ t('refunds.confirmAction') }}
        </AppButton>
      </template>

      <template v-else-if="outcome && step === 'result'">
        <AppButton
          v-if="outcome.state === 'unresolved'"
          variant="secondary"
          :disabled="isSubmitting"
          :loading="isSubmitting"
          @click="resumeOutcome"
        >
          {{ t('refunds.resumeAction') }}
        </AppButton>
        <AppButton variant="primary" @click="close">{{ t('refunds.close') }}</AppButton>
      </template>

      <template v-else>
        <AppButton variant="ghost" @click="close">{{ t('refunds.close') }}</AppButton>
      </template>
    </template>
  </AppDialog>
</template>

<style scoped>
.refund-dialog__select,
.refund-dialog__review,
.refund-dialog__result {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.refund-dialog__meta {
  color: var(--color-on-surface-variant);
  font-size: var(--text-body-sm-size);
}

.refund-dialog__feasibility-note {
  color: var(--color-on-error-container);
  font-size: var(--text-body-sm-size);
}

@media (max-width: 480px) {
  .refund-dialog__select,
  .refund-dialog__review {
    gap: var(--space-3);
  }
}
</style>
