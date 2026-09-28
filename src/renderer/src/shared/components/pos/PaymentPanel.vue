<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppDialog from '@renderer/shared/components/common/AppDialog.vue'
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import AppSpinner from '@renderer/shared/components/common/AppSpinner.vue'
import AppEmptyState from '@renderer/shared/components/feedback/AppEmptyState.vue'
import AppInlineError from '@renderer/shared/components/feedback/AppInlineError.vue'
import AppStatusChip from '@renderer/shared/components/feedback/AppStatusChip.vue'
import NumericAmountInput from './NumericAmountInput.vue'
import PaymentMethodTile from './PaymentMethodTile.vue'
import SplitPaymentRow from './SplitPaymentRow.vue'
import type {
  DisplayPaymentMethodOption,
  DisplaySplitPayment,
  PaymentPanelRecoveryState
} from './types'

/**
 * Pure presentation: every value here is already computed and formatted upstream. This panel
 * never reads a store and never calls the preload bridge directly — every action is a bare emit
 * the parent page resolves against the real attempt key.
 */
const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    statusChipLabel: string
    subtotalLabel: string
    subtotal: string
    discountLabel?: string
    discount?: string
    taxLabel: string
    tax: string
    totalLabel: string
    total: string
    methodOptions: readonly DisplayPaymentMethodOption[]
    noMethodsTitle: string
    noMethodsDescription: string
    rows: readonly DisplaySplitPayment[]
    editRowLabel: string
    removeRowLabel: string
    isEditingDraft: boolean
    draftMethodLabel?: string
    draftAmountLabel: string
    draftAmount: string
    draftAmountError?: string
    draftReferenceLabel: string
    draftReference: string
    requiresReference: boolean
    cancelDraftLabel: string
    commitDraftLabel: string
    paidTotalLabel: string
    paidTotal: string
    changeDueLabel?: string
    changeDue?: string
    dueLabel?: string
    due?: string
    previewPending: boolean
    previewPendingLabel: string
    previewMessage?: string
    previewIsError: boolean
    completionLabel: string
    completionEnabled: boolean
    completionPending: boolean
    completionPendingLabel: string
    completionMessage?: string
    completionIsError: boolean
    completionRefreshAvailable: boolean
    completionRefreshPending: boolean
    refreshWorkstationLabel: string
    recoveryState: PaymentPanelRecoveryState
    retryLabel: string
    abandonLabel: string
    acknowledgeLabel: string
    abandonWarning: string
    confirmAbandonLabel: string
    cancelConfirmLabel: string
    printReceiptLabel?: string
    /** V3 chrome (all optional; the panel degrades to the bare values without them). */
    closeLabel?: string
    methodsLabel?: string
    currencyLabel?: string
    fillDueLabel?: string
    enterHint?: string
    rowsTitle?: string
    rowsLimitNote?: string
    noRowsLabel?: string
    removeRowText?: string
    completingTitle?: string
    completingBody?: string
    completedTitle?: string
    completedTotal?: string
    completedNote?: string
    failedTitle?: string
  }>(),
  {
    discountLabel: undefined,
    discount: undefined,
    draftMethodLabel: undefined,
    draftAmountError: undefined,
    changeDueLabel: undefined,
    changeDue: undefined,
    dueLabel: undefined,
    due: undefined,
    previewMessage: undefined,
    completionMessage: undefined,
    printReceiptLabel: undefined,
    closeLabel: undefined,
    methodsLabel: undefined,
    currencyLabel: undefined,
    fillDueLabel: undefined,
    enterHint: undefined,
    rowsTitle: undefined,
    rowsLimitNote: undefined,
    noRowsLabel: undefined,
    removeRowText: undefined,
    completingTitle: undefined,
    completingBody: undefined,
    completedTitle: undefined,
    completedTotal: undefined,
    completedNote: undefined,
    failedTitle: undefined
  }
)

const emit = defineEmits<{
  close: []
  selectMethod: [string]
  editRow: [string]
  removeRow: [string]
  'update:draftAmount': [string]
  'update:draftReference': [string]
  commitDraft: []
  cancelDraft: []
  complete: []
  refreshWorkstation: []
  retry: []
  abandon: []
  acknowledge: []
  print: []
  fillDue: []
}>()

const eligibleOptions = computed(() => props.methodOptions.filter((option) => option.eligible))
const ineligibleOptions = computed(() => props.methodOptions.filter((option) => !option.eligible))

/**
 * Plan §1.9: abandoning requires explicit confirmation and the tender warning — a bare click can
 * never fire the actual `abandon` emit. Resets whenever the blocked attempt itself changes (a
 * retry, a fresh abandon elsewhere, or a new blocking attempt) so a stale confirmation can never
 * apply to a different attempt than the one the cashier saw the warning for.
 */
const confirmingAbandon = ref(false)

watch(
  () => props.recoveryState,
  () => {
    confirmingAbandon.value = false
  }
)

function requestAbandon(): void {
  confirmingAbandon.value = true
}

function cancelAbandonConfirmation(): void {
  confirmingAbandon.value = false
}

function confirmAbandon(): void {
  confirmingAbandon.value = false
  emit('abandon')
}

/**
 * `SplitPaymentRow` emits a bare `remove` (no event payload), so its own click already bubbles
 * here. Detecting the button by target, rather than stopping propagation, lets both listeners
 * fire correctly without touching that reused component.
 */
function onRowActivate(event: MouseEvent, rowId: string): void {
  if ((event.target as HTMLElement).closest('button')) {
    return
  }

  emit('editRow', rowId)
}
</script>

<template>
  <AppDialog
    :open="open"
    size="xl"
    :close-label="closeLabel"
    :persistent="completionPending"
    @close="emit('close')"
  >
    <template #title>{{ title }}</template>
    <template #header-extra>
      <AppStatusChip
        v-if="recoveryState.kind === 'clear'"
        variant="information"
        icon="info"
        class="payment-panel__status self-center"
      >
        {{ statusChipLabel }}
      </AppStatusChip>
    </template>

    <!-- Blocked: an earlier attempt must be retried or explicitly abandoned (V3 "payfail"). -->
    <div v-if="recoveryState.kind === 'blocked'" class="flex flex-col gap-3 py-2" role="alert">
      <div class="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          class="flex size-10 flex-none items-center justify-center rounded-full bg-err-bg text-err"
          ><AppIcon name="error" :size="24"
        /></span>
        <h3 v-if="failedTitle" class="text-2xl font-bold">{{ failedTitle }}</h3>
      </div>
      <AppInlineError class="payment-panel__recovery-message">
        {{ recoveryState.message }}
      </AppInlineError>
      <template v-if="confirmingAbandon">
        <div
          class="payment-panel__recovery-message flex items-start gap-2.5 rounded-notice bg-warn-bg px-3.5 py-3 text-sm"
          role="note"
        >
          <AppIcon name="warning" :size="20" class="mt-px text-warn" />
          <span>{{ abandonWarning }}</span>
        </div>
        <div class="payment-panel__recovery-actions flex flex-wrap justify-end gap-2.5">
          <AppButton variant="secondary" data-autofocus @click="cancelAbandonConfirmation">
            {{ cancelConfirmLabel }}
          </AppButton>
          <AppButton variant="danger" @click="confirmAbandon">{{ confirmAbandonLabel }}</AppButton>
        </div>
      </template>
      <div v-else class="payment-panel__recovery-actions flex flex-wrap justify-end gap-2.5">
        <AppButton variant="danger-outline" @click="requestAbandon">{{ abandonLabel }}</AppButton>
        <AppButton variant="primary" icon="refresh" data-autofocus @click="emit('retry')">
          {{ retryLabel }}
        </AppButton>
      </div>
    </div>

    <!-- Committed: the sale is saved on this workstation; the cashier acknowledges (V3 "done"). -->
    <div
      v-else-if="recoveryState.kind === 'awaiting-acknowledgment'"
      class="mx-auto flex w-full max-w-[520px] flex-col gap-3 py-2"
    >
      <div class="flex flex-col items-center gap-2 text-center">
        <span
          aria-hidden="true"
          class="flex size-14 items-center justify-center rounded-full bg-ok-bg text-ok"
          ><AppIcon name="check" :size="32"
        /></span>
        <h3 v-if="completedTitle" class="text-2xl font-extrabold">{{ completedTitle }}</h3>
        <div v-if="completedTotal" class="numeric text-6xl font-extrabold">
          {{ completedTotal }}
        </div>
        <p
          class="payment-panel__recovery-message max-w-[420px] text-sm text-pretty text-muted"
          role="status"
        >
          {{ recoveryState.message }}
        </p>
      </div>
      <p
        v-if="completedNote"
        class="flex items-center gap-2 rounded-notice border border-line px-3.5 py-3 text-sm"
      >
        <AppIcon name="save" :size="20" class="text-ok" /><span class="font-semibold">{{
          completedNote
        }}</span>
      </p>
      <div
        v-if="rows.length > 0"
        class="numeric flex flex-col gap-1.5 rounded-notice border border-line px-3.5 py-3 text-sm"
      >
        <span v-if="paidTotalLabel" class="font-bold">{{ paidTotalLabel }}</span>
        <div v-for="row in rows" :key="row.id" class="flex justify-between gap-2">
          <span>{{ row.methodLabel }}</span
          ><span class="font-semibold">{{ row.amount }}</span>
        </div>
      </div>
      <div
        v-if="changeDueLabel && changeDue"
        class="numeric flex items-center gap-2.5 rounded-notice bg-ok-bg p-3.5 text-md font-bold"
        role="status"
      >
        <AppIcon name="payments" :size="22" class="text-ok" />{{ changeDueLabel }} · {{ changeDue }}
      </div>
    </div>

    <!-- Completing: the durable local write is in flight. -->
    <div
      v-else-if="completionPending"
      class="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center"
      role="status"
    >
      <span class="text-pri-text"><AppSpinner :size="32" /></span>
      <p class="payment-panel__pending text-xl font-bold">{{ completionPendingLabel }}</p>
      <p v-if="completingBody" class="text-muted">{{ completingBody }}</p>
    </div>

    <!-- Tendering (V3 "payment_tender_split"). -->
    <div v-else class="grid grid-cols-1 gap-5 wide:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      <div class="flex min-w-0 flex-col gap-4">
        <div
          class="numeric flex flex-wrap items-center gap-4 rounded-lg border border-line px-4 py-3.5"
        >
          <dl class="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 text-sm">
            <dt class="text-muted">{{ subtotalLabel }}</dt>
            <dd>{{ subtotal }}</dd>
            <template v-if="discountLabel && discount">
              <dt class="text-muted">{{ discountLabel }}</dt>
              <dd class="font-semibold text-ok">−{{ discount }}</dd>
            </template>
            <dt class="text-muted">{{ taxLabel }}</dt>
            <dd>{{ tax }}</dd>
          </dl>
          <div class="flex-1" />
          <div class="text-end">
            <div class="text-sm text-muted">{{ totalLabel }}</div>
            <div class="text-5xl font-extrabold whitespace-nowrap">{{ total }}</div>
          </div>
        </div>

        <AppEmptyState
          v-if="methodOptions.length === 0"
          compact
          icon="credit_card"
          :title="noMethodsTitle"
          :description="noMethodsDescription"
        />
        <div
          v-else
          class="payment-panel__methods flex flex-col gap-2"
          role="group"
          :aria-label="methodsLabel"
        >
          <span v-if="methodsLabel" class="text-sm font-semibold" aria-hidden="true">{{
            methodsLabel
          }}</span>
          <div v-if="eligibleOptions.length" class="grid grid-cols-3 gap-2">
            <PaymentMethodTile
              v-for="option in eligibleOptions"
              :key="option.method.id"
              :method="option.method"
              :selected="isEditingDraft && draftMethodLabel === option.method.label"
              @select="emit('selectMethod', option.method.id)"
            />
          </div>
          <div v-if="ineligibleOptions.length" class="grid grid-cols-3 gap-2">
            <PaymentMethodTile
              v-for="option in ineligibleOptions"
              :key="option.method.id"
              :method="option.method"
              disabled
              :reason="option.ineligibleReason"
              :title="option.ineligibleReason"
            />
          </div>
        </div>

        <div
          v-if="isEditingDraft"
          class="payment-panel__draft flex flex-col gap-3 rounded-lg border border-line bg-pri-soft p-4"
        >
          <p
            v-if="draftMethodLabel"
            class="payment-panel__draft-heading flex items-center gap-2 font-bold"
          >
            <AppIcon name="payments" :size="20" class="text-pri-text" />{{ draftMethodLabel }}
          </p>
          <NumericAmountInput
            :label="draftAmountLabel"
            :model-value="draftAmount"
            :error="draftAmountError"
            :prefix="currencyLabel"
            autofocus
            @update:model-value="emit('update:draftAmount', $event)"
            @keydown.enter.prevent="emit('commitDraft')"
            @keydown.esc.prevent="emit('cancelDraft')"
          >
            <template v-if="fillDueLabel" #label-action>
              <button
                type="button"
                class="text-xs font-semibold text-pri-text hover:underline"
                @click="emit('fillDue')"
              >
                {{ fillDueLabel }}
              </button>
            </template>
          </NumericAmountInput>
          <label v-if="requiresReference" class="payment-panel__reference flex flex-col gap-1.5">
            <span class="payment-panel__reference-label text-sm font-semibold">{{
              draftReferenceLabel
            }}</span>
            <input
              type="text"
              dir="ltr"
              class="payment-panel__reference-input code h-11 w-full rounded-md border border-control bg-surf px-3 text-base text-ink"
              :value="draftReference"
              @input="emit('update:draftReference', ($event.target as HTMLInputElement).value)"
              @keydown.enter.prevent="emit('commitDraft')"
              @keydown.esc.prevent="emit('cancelDraft')"
            />
          </label>
          <div class="payment-panel__draft-actions flex flex-wrap items-center justify-end gap-2.5">
            <span v-if="enterHint" class="me-auto text-xs text-muted">{{ enterHint }}</span>
            <AppButton variant="ghost" @click="emit('cancelDraft')">{{
              cancelDraftLabel
            }}</AppButton>
            <AppButton variant="outline" icon="add" @click="emit('commitDraft')">
              {{ commitDraftLabel }}
            </AppButton>
          </div>
        </div>
      </div>

      <div class="flex min-w-0 flex-col gap-3.5">
        <div class="flex items-center gap-2 border-b border-line pb-2">
          <h3 v-if="rowsTitle" class="text-md font-bold">{{ rowsTitle }}</h3>
          <span
            class="numeric flex min-h-6 min-w-6 items-center justify-center rounded-full border border-line bg-subtle px-2 text-xs font-bold"
            >{{ rows.length }}</span
          >
          <span v-if="rowsLimitNote" class="ms-auto text-xs text-muted">{{ rowsLimitNote }}</span>
        </div>
        <p
          v-if="rows.length === 0 && noRowsLabel"
          class="rounded-notice border border-dashed border-line-strong p-4 text-center text-sm text-muted"
        >
          {{ noRowsLabel }}
        </p>
        <ul v-if="rows.length > 0" class="payment-panel__rows flex flex-col gap-2">
          <li
            v-for="row in rows"
            :key="row.id"
            class="payment-panel__row cursor-pointer rounded-notice"
            tabindex="0"
            role="button"
            :aria-label="`${editRowLabel}: ${row.methodLabel} ${row.amount}`"
            @click="onRowActivate($event, row.id)"
            @keydown.enter="emit('editRow', row.id)"
          >
            <SplitPaymentRow
              :payment="row"
              :remove-label="removeRowLabel"
              :remove-text="removeRowText"
              @remove="emit('removeRow', row.id)"
            />
          </li>
        </ul>

        <dl
          class="payment-panel__summary numeric flex flex-col gap-2 rounded-lg border border-line p-4"
        >
          <div class="payment-panel__summary-row flex justify-between">
            <dt class="text-muted">{{ paidTotalLabel }}</dt>
            <dd class="font-semibold">{{ paidTotal }}</dd>
          </div>
          <div
            v-if="changeDueLabel && changeDue"
            class="payment-panel__summary-row flex items-baseline justify-between gap-2 text-ok"
          >
            <dt class="font-bold">{{ changeDueLabel }}</dt>
            <dd class="text-4xl font-extrabold whitespace-nowrap">{{ changeDue }}</dd>
          </div>
          <div
            v-if="dueLabel && due"
            class="payment-panel__summary-row flex items-baseline justify-between gap-2 text-warn"
          >
            <dt class="font-bold">{{ dueLabel }}</dt>
            <dd class="text-4xl font-extrabold whitespace-nowrap">{{ due }}</dd>
          </div>
        </dl>

        <p
          v-if="previewPending"
          class="payment-panel__pending flex items-center gap-2 rounded-notice bg-info-bg px-3.5 py-3 text-sm font-semibold"
          role="status"
        >
          <AppSpinner :size="18" class="text-info" />{{ previewPendingLabel }}
        </p>
        <AppInlineError v-else-if="previewMessage && previewIsError">
          {{ previewMessage }}
        </AppInlineError>
        <p
          v-else-if="previewMessage"
          class="payment-panel__hint flex items-start gap-2.5 rounded-notice bg-info-bg px-3.5 py-3 text-sm"
          role="status"
        >
          <AppIcon name="info" :size="20" class="mt-px text-info" />{{ previewMessage }}
        </p>

        <AppInlineError v-if="completionMessage && completionIsError">
          {{ completionMessage }}
        </AppInlineError>
        <p v-else-if="completionMessage" class="payment-panel__hint text-sm">
          {{ completionMessage }}
        </p>

        <AppButton
          v-if="completionRefreshAvailable"
          variant="secondary"
          icon="refresh"
          full-width
          :loading="completionRefreshPending"
          @click="emit('refreshWorkstation')"
        >
          {{ refreshWorkstationLabel }}
        </AppButton>
      </div>
    </div>

    <template #actions>
      <slot name="actions" />
      <div class="flex-1" />
      <template v-if="recoveryState.kind === 'awaiting-acknowledgment'">
        <AppButton
          v-if="printReceiptLabel"
          class="payment-panel__print"
          variant="secondary"
          size="lg"
          icon="print"
          @click="emit('print')"
        >
          {{ printReceiptLabel }}
        </AppButton>
        <AppButton
          class="payment-panel__complete"
          variant="primary"
          size="lg"
          data-autofocus
          @click="emit('acknowledge')"
        >
          {{ acknowledgeLabel }}
        </AppButton>
      </template>
      <AppButton
        v-else-if="recoveryState.kind === 'clear'"
        class="payment-panel__complete"
        variant="primary"
        size="xl"
        icon="task_alt"
        :disabled="!completionEnabled || completionPending"
        :aria-disabled="!completionEnabled || completionPending ? 'true' : undefined"
        @click="emit('complete')"
      >
        {{ completionLabel }}
      </AppButton>
    </template>
  </AppDialog>
</template>
