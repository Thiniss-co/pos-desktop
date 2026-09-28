<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import type { LocaleCode } from '@shared/contracts/preferences.contract'
import { formatMinorCurrency } from '@shared/money/minorUnits'
import { formatDateTime } from '@renderer/shared/utils/format'
import { useRefundsStore } from '../store'
import { useLocaleStore } from '@renderer/modules/preferences/locale.store'
import { useCatalogStore } from '@renderer/modules/pos/catalog.store'
import AppDialog from '@renderer/shared/components/common/AppDialog.vue'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import AppPanel from '@renderer/shared/components/common/AppPanel.vue'
import AppTable from '@renderer/shared/components/common/AppTable.vue'
import AppCheckbox from '@renderer/shared/components/forms/AppCheckbox.vue'
import AppSegmented from '@renderer/shared/components/forms/AppSegmented.vue'
import AppInput from '@renderer/shared/components/forms/AppInput.vue'
import AppTextarea from '@renderer/shared/components/forms/AppTextarea.vue'
import AppBanner from '@renderer/shared/components/feedback/AppBanner.vue'
import AppLoadingSkeleton from '@renderer/shared/components/feedback/AppLoadingSkeleton.vue'
import AppSteps from '@renderer/shared/components/feedback/AppSteps.vue'
import OrderTotals from '@renderer/shared/components/pos/OrderTotals.vue'
import RefundLineRow from '@renderer/shared/components/pos/RefundLineRow.vue'
import ReceiptPreviewDialog from '@renderer/modules/printing/components/ReceiptPreviewDialog.vue'
import type { ReceiptDocumentRef } from '@shared/contracts/printing.contract'
import RefundStatePanel from './RefundStatePanel.vue'

/**
 * Plan §6 -- the refund action, in full. Reached from the sale-detail page's refund button.
 * Steps: select lines/quantities -> review totals, stock-return toggle, refund method ->
 * confirm -> result. Renders in English/Arabic (RTL follows the app-wide `dir` from the locale
 * store), is keyboard-navigable (inherited from `AppDialog`'s focus trap), and uses only shared,
 * already-responsive components.
 *
 * V3 (docs/design/claude-v3, deviation D-07): the prototype's full-page refund screen is composed
 * here as a large modal — same header (title, original invoice, numbered steps), same per-step
 * bodies, and the same pinned footer actions.
 */
const props = defineProps<{ open: boolean; invoiceLocalUuid: string | null }>()
const emit = defineEmits<{ close: [] }>()

const store = useRefundsStore()
const {
  refundable,
  isLoadingRefundable,
  selection,
  selectedLines,
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

const steps = computed(() => [
  { label: t('refunds.step.select') },
  { label: t('refunds.step.review') },
  { label: t('refunds.step.result') }
])
const stepIndex = computed(() => (step.value === 'select' ? 0 : step.value === 'review' ? 1 : 2))

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

/** "3.000" → "3", "1.500" → "1.5" — display only; the selection itself stays in milli-units. */
function quantityLabel(value: string): string {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? String(parsed) : value
}

function quantityMilliLabel(quantityMilli: number): string {
  return String(Number((quantityMilli / 1000).toFixed(3)))
}

function quantityMilliFor(value: string): number {
  const [whole, fraction = ''] = value.split('.')
  return Number(whole) * 1000 + Number(fraction.padEnd(3, '0').slice(0, 3))
}

function feasibilityBadge(tier: 'ok' | 'soft' | 'hard'): string {
  return tier === 'soft' ? t('refunds.tierBadgeSoft') : t('refunds.tierBadgeHard')
}

const soldAtLabel = computed(() => {
  const value = refundable.value?.soldAt
  if (!value) {
    return ''
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return formatDateTime(date, localeStore.locale as LocaleCode, {
    dateStyle: 'medium',
    timeStyle: 'short',
    numberingSystem: 'latn'
  })
})

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

const receiptDialogOpen = ref(false)
const receiptDocument = ref<ReceiptDocumentRef | null>(null)

function printRefundReceipt(): void {
  if (!outcome.value || outcome.value.state !== 'accepted') return
  receiptDocument.value = { kind: 'refund', refundLocalUuid: outcome.value.localRefundUuid }
  receiptDialogOpen.value = true
}

function closeReceiptDialog(): void {
  receiptDialogOpen.value = false
}
</script>

<template>
  <AppDialog
    :open="open"
    size="xl"
    :close-label="t('refunds.close')"
    :persistent="isSubmitting"
    @close="close"
  >
    <template #title>
      <span class="block">{{ t('refunds.dialogTitle') }}</span>
      <span v-if="refundable" class="mt-0.5 block text-sm font-medium text-muted">
        {{ t('refunds.originalInvoice') }}:
        <span class="code font-semibold text-ink">{{ refundable.displayNumber }}</span>
        <template v-if="soldAtLabel">
          · {{ t('refunds.soldAt') }}: <span class="numeric">{{ soldAtLabel }}</span>
        </template>
      </span>
    </template>

    <template #header-extra>
      <div class="hidden self-center wide:block">
        <AppSteps :steps="steps" :current="stepIndex" :label="t('refunds.stepsLabel')" />
      </div>
    </template>

    <AppLoadingSkeleton v-if="isLoadingRefundable" :label="t('common.loading')" :lines="5" />

    <RefundStatePanel
      v-else-if="error && step === 'select'"
      role="alert"
      tone="err"
      icon="error"
      :title="error"
    />

    <RefundStatePanel
      v-else-if="refundable && !refundable.refundCapable && step === 'select'"
      role="alert"
      tone="neutral"
      icon="cloud_off"
      :title="t('refunds.capabilityUnavailable')"
      :body="t('refunds.capabilityUnavailableDetail')"
    />

    <template v-else-if="refundable && step === 'select'">
      <RefundStatePanel
        v-if="refundable.lines.length === 0"
        tone="neutral"
        icon="done_all"
        :title="t('refunds.noRefundableQuantity')"
      />

      <template v-else>
        <AppTable :label="t('refunds.step.select')">
          <thead>
            <tr>
              <th scope="col">{{ t('refunds.productName') }}</th>
              <th scope="col" class="text-center!">{{ t('refunds.quantitySold') }}</th>
              <th scope="col" class="text-center!">{{ t('refunds.quantityRefunded') }}</th>
              <th scope="col" class="text-center!">{{ t('refunds.quantityRefundable') }}</th>
              <th scope="col" class="text-center!">{{ t('refunds.quantitySelected') }}</th>
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

        <AppBanner
          v-if="refundable.lines.some((line) => line.feasibility.tier !== 'ok')"
          variant="error"
          role="note"
          icon="block"
        >
          {{ t('refunds.feasibilityBlockedNotice') }}
        </AppBanner>

        <AppCheckbox
          v-model="stockReturned"
          tile
          :label="t('refunds.stockReturned')"
          :description="t('refunds.stockReturnedHint')"
        />
      </template>

      <AppBanner v-if="error" variant="error" role="alert">{{ error }}</AppBanner>
    </template>

    <template v-else-if="preview && step === 'review'">
      <RefundStatePanel
        v-if="isSubmitting"
        busy
        :title="t('refunds.submitting')"
        :body="t('refunds.submittingHint')"
      />

      <template v-else>
        <div
          class="grid grid-cols-[repeat(auto-fit,minmax(min(100%,340px),1fr))] items-start gap-4"
        >
          <AppPanel :title="t('refunds.whatRefunded')">
            <ul class="flex flex-col text-sm">
              <li
                v-for="line in preview.lines"
                :key="line.invoiceItemRemoteUuid"
                class="flex justify-between gap-2.5 border-b border-line py-2"
              >
                <span class="min-w-0">
                  {{ line.productName }}
                  <span class="numeric text-muted"
                    >× {{ quantityMilliLabel(line.quantityMilli) }}</span
                  >
                </span>
                <span class="numeric font-semibold whitespace-nowrap">{{
                  money(line.totalAmount)
                }}</span>
              </li>
            </ul>
            <p class="flex items-center gap-2 text-sm text-muted">
              <AppIcon :name="preview.stockReturned ? 'inventory' : 'block'" :size="18" />
              {{ preview.stockReturned ? t('refunds.toStock') : t('refunds.notToStock') }}
            </p>
            <OrderTotals
              :subtotal-label="t('refunds.subtotal')"
              :subtotal="money(preview.subtotalAmount)"
              :tax-label="t('refunds.tax')"
              :tax="money(preview.taxTotalAmount)"
              :total-label="t('refunds.total')"
              :total="money(preview.grandTotalAmount)"
            />
          </AppPanel>

          <AppPanel :title="t('refunds.howRefunded')" class="gap-3.5!">
            <AppSegmented
              v-model="paymentMethodModel"
              layout="stack"
              :label="t('refunds.paymentMethod')"
              :options="paymentOptions"
            />
            <AppInput
              v-model="reference"
              code
              :label="t('refunds.referenceOptional')"
              :hint="t('refunds.referenceHint')"
            />
            <AppInput
              v-model="reason"
              :label="t('refunds.reasonOptional')"
              :placeholder="t('refunds.reasonPlaceholder')"
            />
            <AppTextarea v-model="notes" :label="t('refunds.notesOptional')" :rows="2" />
            <AppBanner variant="info" role="note">{{ t('refunds.recordedNotice') }}</AppBanner>
          </AppPanel>
        </div>

        <AppBanner v-if="error" variant="error" role="alert">{{ error }}</AppBanner>
      </template>
    </template>

    <template v-else-if="outcome && step === 'result'">
      <RefundStatePanel
        v-if="outcome.state === 'accepted'"
        tone="ok"
        icon="check_circle"
        :title="t('refunds.success')"
        :body="
          t('refunds.successDetail', { number: outcome.refundNumber ?? outcome.localRefundUuid })
        "
      >
        <p v-if="preview" class="numeric text-3xl font-extrabold">
          {{ money(preview.grandTotalAmount) }}
        </p>
      </RefundStatePanel>

      <RefundStatePanel
        v-else-if="outcome.state === 'conflict'"
        role="alert"
        tone="err"
        icon="sync_problem"
        :title="t('refunds.conflictTitle')"
        :body="t('refunds.conflictNotice')"
      >
        <p class="text-sm text-muted">
          {{ t('refunds.supportReference') }}:
          <span class="code font-semibold text-ink">{{ outcome.localRefundUuid }}</span>
        </p>
      </RefundStatePanel>

      <RefundStatePanel
        v-else-if="outcome.state === 'unresolved'"
        role="alert"
        tone="warn"
        icon="help"
        :title="t('refunds.unknownTitle')"
        :body="t('refunds.pendingUnresolved')"
      />

      <RefundStatePanel
        v-else-if="outcome.state === 'rejected'"
        role="alert"
        tone="neutral"
        icon="block"
        :title="t('refunds.rejectedNotice')"
        :body="outcome.errorCode ? t('refunds.errors.' + outcome.errorCode) : undefined"
      />

      <RefundStatePanel v-else tone="info" icon="hourglass_top" :title="t('refunds.submitting')" />

      <AppBanner v-if="error" variant="error" role="alert">{{ error }}</AppBanner>
    </template>

    <RefundStatePanel
      v-else-if="step === 'result' && error"
      role="alert"
      tone="err"
      icon="error"
      :title="error"
    />

    <template #actions>
      <template v-if="refundable && refundable.refundCapable && step === 'select'">
        <div class="me-auto flex min-w-55 flex-1 flex-col gap-0.5">
          <p class="text-base font-bold">
            {{
              hasSelection
                ? t('refunds.selectionCount', { n: selectedLines.length })
                : t('refunds.selectionNone')
            }}
          </p>
          <p class="flex items-center gap-1.5 text-xs text-muted">
            <AppIcon name="wifi" :size="16" />
            {{ t('refunds.needsConnection') }}
          </p>
        </div>
        <AppButton variant="secondary" size="lg" @click="close">{{
          t('refunds.cancelAction')
        }}</AppButton>
        <AppButton
          variant="primary"
          size="lg"
          icon-end="arrow_forward"
          mirror-icon
          :disabled="!hasSelection || isPreviewing"
          :loading="isPreviewing"
          @click="goToReview"
        >
          {{ t('refunds.previewAction') }}
        </AppButton>
      </template>

      <template v-else-if="preview && step === 'review'">
        <AppButton
          variant="secondary"
          size="lg"
          icon="arrow_back"
          mirror-icon
          class="me-auto"
          :disabled="isSubmitting"
          @click="step = 'select'"
        >
          {{ t('common.back') }}
        </AppButton>
        <AppButton
          variant="primary"
          size="xl"
          :disabled="isSubmitting"
          :loading="isSubmitting"
          @click="confirmSubmit"
        >
          {{ t('refunds.confirmActionAmount', { amount: money(preview.grandTotalAmount) }) }}
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
        <AppButton
          v-if="outcome.state === 'accepted'"
          variant="secondary"
          icon="print"
          @click="printRefundReceipt"
        >
          {{ t('sales.printRefundAction') }}
        </AppButton>
        <AppButton variant="primary" @click="close">{{ t('refunds.backToSale') }}</AppButton>
      </template>

      <template v-else>
        <AppButton variant="secondary" @click="close">{{ t('refunds.close') }}</AppButton>
      </template>
    </template>
  </AppDialog>

  <ReceiptPreviewDialog
    :open="receiptDialogOpen"
    :document="receiptDocument"
    @close="closeReceiptDialog"
  />
</template>
