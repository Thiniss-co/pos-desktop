<script setup lang="ts">
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppDialog from '@renderer/shared/components/common/AppDialog.vue'
import AppEmptyState from '@renderer/shared/components/feedback/AppEmptyState.vue'
import AppInlineError from '@renderer/shared/components/feedback/AppInlineError.vue'
import AppStatusChip from '@renderer/shared/components/feedback/AppStatusChip.vue'
import NumericAmountInput from './NumericAmountInput.vue'
import OrderTotals from './OrderTotals.vue'
import PaymentMethodTile from './PaymentMethodTile.vue'
import SplitPaymentRow from './SplitPaymentRow.vue'
import type { DisplayPaymentMethodOption, DisplaySplitPayment } from './types'

/**
 * Pure presentation: every value here is already computed and formatted upstream. This panel
 * never reads a store, never calls the preload bridge, and the completion control below has no
 * `@click` binding anywhere in this file — enabling it is out of scope for this phase, and no prop
 * here can turn it on.
 */
withDefaults(
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
    previewMessage: undefined
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
}>()

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
  <AppDialog :open="open" @close="emit('close')">
    <template #title>{{ title }}</template>

    <AppStatusChip variant="information" class="payment-panel__status">
      {{ statusChipLabel }}
    </AppStatusChip>

    <OrderTotals
      :subtotal-label="subtotalLabel"
      :subtotal="subtotal"
      :discount-label="discountLabel"
      :discount="discount"
      :tax-label="taxLabel"
      :tax="tax"
      :total-label="totalLabel"
      :total="total"
    />

    <AppEmptyState
      v-if="methodOptions.length === 0"
      :title="noMethodsTitle"
      :description="noMethodsDescription"
    />
    <div v-else class="payment-panel__methods">
      <PaymentMethodTile
        v-for="option in methodOptions"
        :key="option.method.id"
        :method="option.method"
        :disabled="!option.eligible"
        :title="option.ineligibleReason"
        @select="emit('selectMethod', option.method.id)"
      />
    </div>

    <div v-if="isEditingDraft" class="payment-panel__draft">
      <p v-if="draftMethodLabel" class="payment-panel__draft-heading">{{ draftMethodLabel }}</p>
      <NumericAmountInput
        :label="draftAmountLabel"
        :model-value="draftAmount"
        :error="draftAmountError"
        @update:model-value="emit('update:draftAmount', $event)"
        @keydown.enter.prevent="emit('commitDraft')"
        @keydown.esc.prevent="emit('cancelDraft')"
      />
      <label v-if="requiresReference" class="payment-panel__reference">
        <span class="payment-panel__reference-label">{{ draftReferenceLabel }}</span>
        <input
          type="text"
          class="payment-panel__reference-input"
          :value="draftReference"
          @input="emit('update:draftReference', ($event.target as HTMLInputElement).value)"
          @keydown.enter.prevent="emit('commitDraft')"
          @keydown.esc.prevent="emit('cancelDraft')"
        />
      </label>
      <div class="payment-panel__draft-actions">
        <AppButton variant="ghost" @click="emit('cancelDraft')">{{ cancelDraftLabel }}</AppButton>
        <AppButton variant="secondary" @click="emit('commitDraft')">
          {{ commitDraftLabel }}
        </AppButton>
      </div>
    </div>

    <ul v-if="rows.length > 0" class="payment-panel__rows">
      <li
        v-for="row in rows"
        :key="row.id"
        class="payment-panel__row"
        tabindex="0"
        role="button"
        @click="onRowActivate($event, row.id)"
        @keydown.enter="emit('editRow', row.id)"
      >
        <SplitPaymentRow
          :payment="row"
          :remove-label="removeRowLabel"
          @remove="emit('removeRow', row.id)"
        />
      </li>
    </ul>

    <dl class="payment-panel__summary">
      <div class="payment-panel__summary-row">
        <dt>{{ paidTotalLabel }}</dt>
        <dd class="numeric">{{ paidTotal }}</dd>
      </div>
      <div v-if="changeDueLabel && changeDue" class="payment-panel__summary-row">
        <dt>{{ changeDueLabel }}</dt>
        <dd class="numeric">{{ changeDue }}</dd>
      </div>
      <div v-if="dueLabel && due" class="payment-panel__summary-row">
        <dt>{{ dueLabel }}</dt>
        <dd class="numeric">{{ due }}</dd>
      </div>
    </dl>

    <p v-if="previewPending" class="payment-panel__pending" role="status">
      {{ previewPendingLabel }}
    </p>
    <AppInlineError v-else-if="previewMessage && previewIsError">
      {{ previewMessage }}
    </AppInlineError>
    <p v-else-if="previewMessage" class="payment-panel__hint">{{ previewMessage }}</p>

    <AppButton
      class="payment-panel__complete"
      variant="transaction"
      full-width
      disabled
      aria-disabled="true"
    >
      {{ completionLabel }}
    </AppButton>

    <template #actions>
      <slot name="actions" />
    </template>
  </AppDialog>
</template>

<style scoped>
.payment-panel__status {
  margin-block-end: var(--space-3);
}

.payment-panel__methods {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(8rem, 1fr));
  gap: var(--space-3);
  margin-block: var(--space-4);
}

.payment-panel__draft {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  margin-block-end: var(--space-4);
  border: 1px solid var(--color-outline-variant);
  border-radius: var(--radius-md);
  background: var(--color-surface-container);
}

.payment-panel__draft-heading {
  font-weight: 600;
  color: var(--color-on-surface);
}

.payment-panel__reference {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.payment-panel__reference-label {
  font-size: var(--text-body-sm-size);
  font-weight: 600;
  color: var(--color-on-surface-variant);
}

.payment-panel__reference-input {
  min-height: calc(var(--size-target-min) * 1.2);
  padding-inline: var(--space-3);
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-outline);
  background: var(--color-surface-container-lowest);
  color: var(--color-on-surface);
}

.payment-panel__draft-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
}

.payment-panel__rows {
  list-style: none;
  margin: 0 0 var(--space-4);
  padding: 0;
}

.payment-panel__row {
  cursor: pointer;
  border-radius: var(--radius-sm);
}

.payment-panel__row:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: 2px;
}

.payment-panel__summary {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-block-end: var(--space-4);
}

.payment-panel__summary-row {
  display: flex;
  justify-content: space-between;
  font-size: var(--text-numeric-lg-size);
  font-weight: var(--text-numeric-lg-weight);
  color: var(--color-on-surface);
}

.payment-panel__pending,
.payment-panel__hint {
  font-size: var(--text-body-sm-size);
  color: var(--color-on-surface-variant);
  margin-block-end: var(--space-3);
}

.payment-panel__complete {
  margin-block-start: var(--space-2);
}
</style>
