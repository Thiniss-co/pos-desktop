<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppDialog from '@renderer/shared/components/common/AppDialog.vue'
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import AppKbd from '@renderer/shared/components/common/AppKbd.vue'
import AppSpinner from '@renderer/shared/components/common/AppSpinner.vue'
import AppEmptyState from '@renderer/shared/components/feedback/AppEmptyState.vue'
import AppInlineError from '@renderer/shared/components/feedback/AppInlineError.vue'
import AppStatusChip from '@renderer/shared/components/feedback/AppStatusChip.vue'
import NumericAmountInput from './NumericAmountInput.vue'
import PaymentMethodTile from './PaymentMethodTile.vue'
import SplitPaymentRow from './SplitPaymentRow.vue'
import type {
  DisplayAddRemainingAction,
  DisplayExactCashAction,
  DisplayPaymentMethodOption,
  DisplayQuickTender,
  DisplaySplitPayment,
  PaymentCommitAction,
  PaymentCommitKeyDescriptions,
  PaymentPanelRecoveryState
} from './types'

/**
 * Pure presentation: every value here is already computed and formatted upstream. This panel
 * never reads a store and never calls the preload bridge directly — every action is a bare emit
 * the parent page resolves against the real attempt key.
 *
 * Always a modal (`AppDialog` xl, `sheet="compact"`): the Total due is pinned in the header, the
 * body is the only scrolling region, and the footer holds the primary actions.
 *
 * Keyboard safety (docs/architecture/pos-ux-architecture.md, "Scanner and payment keyboard
 * model"): every control that commits or finalises something carries `data-commit-action`, so the
 * page's scan-input router suppresses keyboard (Enter/Space) activation on it — a scanner suffix
 * can never complete a sale. The keyboard path is the visible key hint (F9 / Shift+F9 / Ctrl+P).
 * Initial focus in the tender step is the Total due heading — never the amount field, never the
 * Complete button.
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
    quickTenders?: readonly DisplayQuickTender[]
    quickTendersLabel?: string
    /** "Complete · Exact cash · {method} · {amount}" (tender step only); `null` hides it. */
    exactCash?: DisplayExactCashAction | null
    /** "Add remaining" — adds a tender row only; `null` hides it. */
    addRemaining?: DisplayAddRemainingAction | null
    /** Footer notices, already localized; `null` hides each one. */
    scannerNotice?: string | null
    largeChangeWarning?: string | null
    collectingHint?: string | null
    heldScansNotice?: string | null
    /** Visible key hints, e.g. "F9" and "Ctrl+P" (exposed through `aria-keyshortcuts` too). */
    primaryKeyHint?: string
    printKeyHint?: string
    /** `aria-describedby` text per commit-class control, e.g. "Press F9 to complete the sale". */
    keyDescriptions?: PaymentCommitKeyDescriptions
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
    failedTitle: undefined,
    quickTenders: () => [],
    quickTendersLabel: undefined,
    exactCash: null,
    addRemaining: null,
    scannerNotice: null,
    largeChangeWarning: null,
    collectingHint: null,
    heldScansNotice: null,
    primaryKeyHint: 'F9',
    printKeyHint: 'Ctrl+P',
    keyDescriptions: () => ({})
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
  quickTender: [string]
  exactCash: []
  addRemaining: []
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

type PanelView = 'tender' | 'completing' | 'blocked' | 'confirming-abandon' | 'done'

const view = computed<PanelView>(() => {
  if (props.recoveryState.kind === 'blocked') {
    return confirmingAbandon.value ? 'confirming-abandon' : 'blocked'
  }
  if (props.recoveryState.kind === 'awaiting-acknowledgment') {
    return 'done'
  }
  return props.completionPending ? 'completing' : 'tender'
})

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

/**
 * Enter in the amount/reference field adds or updates the tender row — it never completes the
 * sale. An IME composition, an auto-repeat, and an Enter the scan-input router already consumed
 * (a scanner burst it reverted) are ignored. Escape cancels the draft only; it is stopped here so
 * the dialog does not also close.
 */
function onDraftFieldKeydown(event: KeyboardEvent): void {
  if (!(event.target instanceof HTMLInputElement) || event.isComposing || event.keyCode === 229) {
    return
  }

  if (event.key === 'Enter') {
    const alreadyHandled = event.defaultPrevented
    event.preventDefault()
    if (!alreadyHandled && !event.repeat) {
      emit('commitDraft')
    }
  } else if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    if (!event.repeat) {
      emit('cancelDraft')
    }
  }
}

/* ---- Focus ------------------------------------------------------------------------------- */

const headingRef = ref<HTMLElement | null>(null)
const amountInputRef = ref<InstanceType<typeof NumericAmountInput> | null>(null)
const retryRef = ref<InstanceType<typeof AppButton> | null>(null)
const cancelAbandonRef = ref<InstanceType<typeof AppButton> | null>(null)
const acknowledgeRef = ref<InstanceType<typeof AppButton> | null>(null)

/** Set by a method-tile activation: the amount field takes focus once the draft editor shows. */
let focusAmountWhenDrafting = false

function focusPendingAmount(): void {
  if (focusAmountWhenDrafting && props.isEditingDraft && amountInputRef.value) {
    focusAmountWhenDrafting = false
    amountInputRef.value.focus()
  }
}

function onSelectMethod(methodId: string): void {
  focusAmountWhenDrafting = true
  emit('selectMethod', methodId)
  void nextTick(focusPendingAmount)
}

watch(() => [props.isEditingDraft, props.draftMethodLabel], focusPendingAmount, {
  flush: 'post'
})

function focusIsLost(): boolean {
  const active = document.activeElement
  return !active || active === document.body || !active.isConnected
}

// Adding/cancelling the draft removes the focused field; return focus to the Total due heading.
watch(
  () => props.isEditingDraft,
  (editing, wasEditing) => {
    if (!editing && wasEditing && props.open && focusIsLost()) {
      headingRef.value?.focus()
    }
  },
  { flush: 'post' }
)

function elementOf(button: InstanceType<typeof AppButton> | null): HTMLElement | null {
  return (button?.$el as HTMLElement | undefined) ?? null
}

// The dialog stays open across tender → completing → done/blocked; each step gets its own focus
// target (AppDialog only places focus when it opens).
watch(
  view,
  (next, previous) => {
    if (!props.open || next === previous) {
      return
    }
    const target =
      next === 'tender' || next === 'completing'
        ? headingRef.value
        : next === 'done'
          ? elementOf(acknowledgeRef.value)
          : next === 'blocked'
            ? elementOf(retryRef.value)
            : elementOf(cancelAbandonRef.value)
    target?.focus()
  },
  { flush: 'post' }
)

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) {
      focusAmountWhenDrafting = false
    }
  }
)

/* ---- Commit-class controls: key hints and descriptions ---------------------------------- */

/** Label + key hint inside a commit-class button; wraps (long AR labels) instead of clipping. */
const COMMIT_LABEL_CLASS =
  'inline-flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 whitespace-normal'

const ARIA_KEY_NAMES: Readonly<Record<string, string>> = {
  ctrl: 'Control',
  control: 'Control',
  cmd: 'Meta',
  meta: 'Meta',
  alt: 'Alt',
  shift: 'Shift',
  esc: 'Escape'
}

/** "Ctrl+P" → "Control+P" (the `aria-keyshortcuts` key names). */
function toAriaKeyShortcuts(hint: string): string {
  return hint
    .split('+')
    .map((part) => ARIA_KEY_NAMES[part.trim().toLowerCase()] ?? part.trim())
    .join('+')
}

const descriptionIds: Readonly<Record<PaymentCommitAction, string>> = {
  complete: useId(),
  'exact-cash': useId(),
  retry: useId(),
  'confirm-abandon': useId(),
  print: useId(),
  acknowledge: useId()
}

function describedBy(action: PaymentCommitAction): string | undefined {
  return props.keyDescriptions[action] ? descriptionIds[action] : undefined
}

/**
 * The keyboard path for the page's scan-input router: each performs exactly what activating the
 * visible control would, and nothing when that control is absent or disabled. Returns the action
 * taken (`null` = nothing).
 */
function activatePrimary(): PaymentCommitAction | null {
  switch (view.value) {
    case 'tender':
      if (props.completionEnabled) {
        emit('complete')
        return 'complete'
      }
      return null
    case 'blocked':
      if (props.recoveryState.kind === 'blocked' && props.recoveryState.retryAvailable === false) {
        return null
      }
      emit('retry')
      return 'retry'
    case 'confirming-abandon':
      confirmAbandon()
      return 'confirm-abandon'
    case 'done':
      emit('acknowledge')
      return 'acknowledge'
    default:
      return null
  }
}

function activateExactCash(): PaymentCommitAction | null {
  if (view.value === 'tender' && props.exactCash) {
    emit('exactCash')
    return 'exact-cash'
  }
  return null
}

function activatePrint(): PaymentCommitAction | null {
  if (view.value === 'done' && props.printReceiptLabel) {
    emit('print')
    return 'print'
  }
  return null
}

defineExpose({ activatePrimary, activateExactCash, activatePrint })
</script>

<template>
  <AppDialog
    class="payment-panel"
    :open="open"
    size="xl"
    sheet="compact"
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
        class="payment-panel__status min-w-0 self-center"
      >
        {{ statusChipLabel }}
      </AppStatusChip>
    </template>
    <template v-if="recoveryState.kind === 'clear'" #header-end>
      <!-- Pinned Total due; the tender step's initial focus target (never an input or Complete). -->
      <h3
        ref="headingRef"
        class="payment-panel__total-heading flex min-w-0 flex-wrap items-baseline justify-end gap-x-2.5 self-center rounded-md text-end"
        tabindex="-1"
        data-autofocus
      >
        <span class="text-sm font-semibold text-muted">{{ totalLabel }}</span>
        <span
          class="payment-panel__total numeric text-4xl font-extrabold whitespace-nowrap wide:text-5xl"
          >{{ total }}</span
        >
      </h3>
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
      <p
        v-if="recoveryState.detail"
        class="payment-panel__recovery-detail text-sm text-muted [overflow-wrap:anywhere]"
      >
        {{ recoveryState.detail }}
      </p>
      <template v-if="confirmingAbandon">
        <div
          class="payment-panel__recovery-message flex items-start gap-2.5 rounded-notice bg-warn-bg px-3.5 py-3 text-sm"
          role="note"
        >
          <AppIcon name="warning" :size="20" class="mt-px text-warn" />
          <span>{{ abandonWarning }}</span>
        </div>
        <div class="payment-panel__recovery-actions flex flex-wrap justify-end gap-2.5">
          <AppButton
            ref="cancelAbandonRef"
            variant="secondary"
            data-autofocus
            @click="cancelAbandonConfirmation"
          >
            {{ cancelConfirmLabel }}
          </AppButton>
          <AppButton
            class="max-w-full"
            variant="danger"
            data-commit-action="confirm-abandon"
            :aria-keyshortcuts="toAriaKeyShortcuts(primaryKeyHint)"
            :aria-describedby="describedBy('confirm-abandon')"
            @click="confirmAbandon"
          >
            <span :class="COMMIT_LABEL_CLASS">
              <span>{{ confirmAbandonLabel }}</span>
              <AppKbd aria-hidden="true">{{ primaryKeyHint }}</AppKbd>
            </span>
          </AppButton>
          <span
            v-if="keyDescriptions['confirm-abandon']"
            :id="descriptionIds['confirm-abandon']"
            class="sr-only"
            >{{ keyDescriptions['confirm-abandon'] }}</span
          >
        </div>
      </template>
      <div v-else class="payment-panel__recovery-actions flex flex-wrap justify-end gap-2.5">
        <AppButton variant="danger-outline" @click="requestAbandon">{{ abandonLabel }}</AppButton>
        <AppButton
          v-if="recoveryState.retryAvailable !== false"
          ref="retryRef"
          class="max-w-full"
          variant="primary"
          icon="refresh"
          data-autofocus
          data-commit-action="retry"
          :aria-keyshortcuts="toAriaKeyShortcuts(primaryKeyHint)"
          :aria-describedby="describedBy('retry')"
          @click="emit('retry')"
        >
          <span :class="COMMIT_LABEL_CLASS">
            <span>{{ retryLabel }}</span>
            <AppKbd aria-hidden="true">{{ primaryKeyHint }}</AppKbd>
          </span>
        </AppButton>
        <span
          v-if="keyDescriptions.retry && recoveryState.retryAvailable !== false"
          :id="descriptionIds.retry"
          class="sr-only"
          >{{ keyDescriptions.retry }}</span
        >
      </div>
    </div>

    <!-- Committed: the sale is saved on this workstation; the cashier acknowledges (V3 "done").
         No editable field lives in this step, so the scan-input router can collect codes here. -->
    <div
      v-else-if="recoveryState.kind === 'awaiting-acknowledgment'"
      class="payment-panel__done mx-auto flex w-full max-w-[520px] min-w-0 flex-col gap-3 py-2"
    >
      <div class="flex flex-col items-center gap-2 text-center">
        <span
          aria-hidden="true"
          class="flex size-14 items-center justify-center rounded-full bg-ok-bg text-ok"
          ><AppIcon name="check" :size="32"
        /></span>
        <h3 v-if="completedTitle" class="text-2xl font-extrabold text-balance">
          {{ completedTitle }}
        </h3>
        <div v-if="completedTotal" class="numeric max-w-full text-6xl font-extrabold break-words">
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
        <AppIcon name="save" :size="20" class="flex-none text-ok" /><span class="font-semibold">{{
          completedNote
        }}</span>
      </p>
      <div
        v-if="rows.length > 0"
        class="numeric flex flex-col gap-1.5 rounded-notice border border-line px-3.5 py-3 text-sm"
      >
        <span v-if="paidTotalLabel" class="font-bold">{{ paidTotalLabel }}</span>
        <div v-for="row in rows" :key="row.id" class="flex flex-wrap justify-between gap-x-2">
          <span class="min-w-0">{{ row.methodLabel }}</span
          ><span class="ms-auto font-semibold whitespace-nowrap">{{ row.amount }}</span>
        </div>
      </div>
      <div
        v-if="changeDueLabel && changeDue"
        class="numeric flex flex-wrap items-center gap-2.5 rounded-notice bg-ok-bg p-3.5 text-md font-bold"
        role="status"
      >
        <AppIcon name="payments" :size="22" class="flex-none text-ok" /><span class="min-w-0"
          >{{ changeDueLabel }} · <span class="whitespace-nowrap">{{ changeDue }}</span></span
        >
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

    <!-- Tendering (V3 "payment_tender_split"). The Total due itself is pinned in the header. -->
    <div
      v-else
      class="payment-panel__tender grid min-w-0 grid-cols-1 gap-5 wide:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]"
    >
      <div class="flex min-w-0 flex-col gap-4">
        <dl
          class="payment-panel__breakdown numeric flex flex-wrap gap-x-5 gap-y-1 rounded-lg border border-line px-4 py-3 text-sm"
        >
          <div class="flex gap-2">
            <dt class="text-muted">{{ subtotalLabel }}</dt>
            <dd class="whitespace-nowrap">{{ subtotal }}</dd>
          </div>
          <div v-if="discountLabel && discount" class="flex gap-2">
            <dt class="text-muted">{{ discountLabel }}</dt>
            <dd class="font-semibold whitespace-nowrap text-ok">−{{ discount }}</dd>
          </div>
          <div class="flex gap-2">
            <dt class="text-muted">{{ taxLabel }}</dt>
            <dd class="whitespace-nowrap">{{ tax }}</dd>
          </div>
        </dl>

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
              @select="onSelectMethod(option.method.id)"
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
          v-if="quickTenders.length > 0"
          class="payment-panel__quick flex flex-col gap-2"
          role="group"
          :aria-label="quickTendersLabel"
        >
          <span v-if="quickTendersLabel" class="text-sm font-semibold" aria-hidden="true">{{
            quickTendersLabel
          }}</span>
          <div class="grid grid-cols-3 gap-2">
            <button
              v-for="tender in quickTenders"
              :key="tender.id"
              type="button"
              class="payment-panel__quick-tender numeric min-h-12 min-w-0 rounded-notice border px-2 py-1.5 text-md font-bold break-words disabled:cursor-not-allowed disabled:opacity-50"
              :class="
                tender.exact
                  ? 'payment-panel__quick-tender--exact col-span-3 border-pri bg-pri-soft text-pri-text hover:bg-pri hover:text-on-pri'
                  : 'border-control bg-surf text-ink hover:bg-subtle'
              "
              :disabled="tender.disabled"
              @click="emit('quickTender', tender.id)"
            >
              {{ tender.label }}
            </button>
          </div>
        </div>

        <div
          v-if="isEditingDraft"
          class="payment-panel__draft flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-pri-soft p-4"
        >
          <p
            v-if="draftMethodLabel"
            class="payment-panel__draft-heading flex items-center gap-2 font-bold"
          >
            <AppIcon name="payments" :size="20" class="flex-none text-pri-text" />{{
              draftMethodLabel
            }}
          </p>
          <NumericAmountInput
            ref="amountInputRef"
            :label="draftAmountLabel"
            :model-value="draftAmount"
            :error="draftAmountError"
            :prefix="currencyLabel"
            @update:model-value="emit('update:draftAmount', $event)"
            @keydown="onDraftFieldKeydown"
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
              class="payment-panel__reference-input code h-11 w-full min-w-0 rounded-md border border-control bg-surf px-3 text-base text-ink"
              :value="draftReference"
              @input="emit('update:draftReference', ($event.target as HTMLInputElement).value)"
              @keydown="onDraftFieldKeydown"
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
        <div class="flex flex-wrap items-center gap-2 border-b border-line pb-2">
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
          <div class="payment-panel__summary-row flex flex-wrap justify-between gap-x-2">
            <dt class="min-w-0 text-muted">{{ paidTotalLabel }}</dt>
            <dd class="ms-auto font-semibold whitespace-nowrap">{{ paidTotal }}</dd>
          </div>
          <div
            v-if="changeDueLabel && changeDue"
            class="payment-panel__summary-row flex flex-wrap items-baseline justify-between gap-x-2 text-ok"
          >
            <dt class="min-w-0 font-bold">{{ changeDueLabel }}</dt>
            <dd class="ms-auto text-4xl font-extrabold whitespace-nowrap">{{ changeDue }}</dd>
          </div>
          <div
            v-if="dueLabel && due"
            class="payment-panel__summary-row flex flex-wrap items-baseline justify-between gap-x-2 text-warn"
          >
            <dt class="min-w-0 font-bold">{{ dueLabel }}</dt>
            <dd class="ms-auto text-4xl font-extrabold whitespace-nowrap">{{ due }}</dd>
          </div>
        </dl>

        <AppButton
          v-if="addRemaining"
          class="payment-panel__add-remaining"
          variant="secondary"
          icon="add"
          full-width
          @click="emit('addRemaining')"
        >
          <span class="whitespace-normal">{{ addRemaining.label }}</span>
        </AppButton>

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
          <AppIcon name="info" :size="20" class="mt-px flex-none text-info" />{{ previewMessage }}
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
      <!-- Always present so additions are announced; hidden while empty. -->
      <div
        class="payment-panel__notices flex basis-full flex-wrap gap-1.5 empty:hidden"
        role="status"
        aria-live="polite"
      >
        <p
          v-if="collectingHint"
          class="payment-panel__notice payment-panel__notice--collecting flex min-w-0 flex-1 basis-72 items-start gap-2 rounded-notice bg-info-bg px-3 py-1.5 text-sm"
        >
          <AppIcon name="barcode_scanner" :size="18" class="mt-px flex-none text-info" /><span
            class="min-w-0"
            >{{ collectingHint }}</span
          >
        </p>
        <p
          v-if="scannerNotice"
          class="payment-panel__notice payment-panel__notice--scanner flex min-w-0 flex-1 basis-72 items-start gap-2 rounded-notice bg-warn-bg px-3 py-1.5 text-sm"
        >
          <AppIcon name="barcode_scanner" :size="18" class="mt-px flex-none text-warn" /><span
            class="min-w-0"
            >{{ scannerNotice }}</span
          >
        </p>
        <p
          v-if="heldScansNotice"
          class="payment-panel__notice payment-panel__notice--held flex min-w-0 flex-1 basis-72 items-start gap-2 rounded-notice bg-info-bg px-3 py-1.5 text-sm"
        >
          <AppIcon name="barcode" :size="18" class="mt-px flex-none text-info" /><span
            class="min-w-0"
            >{{ heldScansNotice }}</span
          >
        </p>
        <p
          v-if="largeChangeWarning"
          class="payment-panel__notice payment-panel__notice--large-change flex min-w-0 flex-1 basis-72 items-start gap-2 rounded-notice bg-warn-bg px-3 py-1.5 text-sm font-semibold"
        >
          <AppIcon name="warning" :size="18" class="mt-px flex-none text-warn" /><span
            class="min-w-0"
            >{{ largeChangeWarning }}</span
          >
        </p>
      </div>
      <slot name="actions" />
      <div
        class="payment-panel__commit flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2.5"
      >
        <template v-if="recoveryState.kind === 'awaiting-acknowledgment'">
          <AppButton
            v-if="printReceiptLabel"
            class="payment-panel__print max-w-full"
            variant="secondary"
            size="lg"
            icon="print"
            data-commit-action="print"
            :aria-keyshortcuts="toAriaKeyShortcuts(printKeyHint)"
            :aria-describedby="describedBy('print')"
            @click="emit('print')"
          >
            <span :class="COMMIT_LABEL_CLASS">
              <span>{{ printReceiptLabel }}</span>
              <AppKbd aria-hidden="true">{{ printKeyHint }}</AppKbd>
            </span>
          </AppButton>
          <span
            v-if="printReceiptLabel && keyDescriptions.print"
            :id="descriptionIds.print"
            class="sr-only"
            >{{ keyDescriptions.print }}</span
          >
          <AppButton
            ref="acknowledgeRef"
            class="payment-panel__complete max-w-full"
            variant="primary"
            size="lg"
            data-autofocus
            data-commit-action="acknowledge"
            :aria-keyshortcuts="toAriaKeyShortcuts(primaryKeyHint)"
            :aria-describedby="describedBy('acknowledge')"
            @click="emit('acknowledge')"
          >
            <span :class="COMMIT_LABEL_CLASS">
              <span>{{ acknowledgeLabel }}</span>
              <AppKbd aria-hidden="true">{{ primaryKeyHint }}</AppKbd>
            </span>
          </AppButton>
          <span
            v-if="keyDescriptions.acknowledge"
            :id="descriptionIds.acknowledge"
            class="sr-only"
            >{{ keyDescriptions.acknowledge }}</span
          >
        </template>
        <template v-else-if="recoveryState.kind === 'clear'">
          <AppButton
            v-if="exactCash && !completionPending"
            class="payment-panel__exact-cash max-w-full"
            variant="outline"
            size="xl"
            icon="payments"
            data-commit-action="exact-cash"
            :aria-keyshortcuts="toAriaKeyShortcuts(exactCash.keyHint)"
            :aria-describedby="describedBy('exact-cash')"
            @click="emit('exactCash')"
          >
            <span :class="COMMIT_LABEL_CLASS">
              <span>{{ exactCash.label }}</span>
              <AppKbd aria-hidden="true">{{ exactCash.keyHint }}</AppKbd>
            </span>
          </AppButton>
          <span
            v-if="exactCash && !completionPending && keyDescriptions['exact-cash']"
            :id="descriptionIds['exact-cash']"
            class="sr-only"
            >{{ keyDescriptions['exact-cash'] }}</span
          >
          <AppButton
            class="payment-panel__complete max-w-full"
            variant="primary"
            size="xl"
            icon="task_alt"
            data-commit-action="complete"
            :aria-keyshortcuts="toAriaKeyShortcuts(primaryKeyHint)"
            :aria-describedby="describedBy('complete')"
            :disabled="!completionEnabled || completionPending"
            :aria-disabled="!completionEnabled || completionPending ? 'true' : undefined"
            @click="emit('complete')"
          >
            <span :class="COMMIT_LABEL_CLASS">
              <span>{{ completionLabel }}</span>
              <AppKbd aria-hidden="true">{{ primaryKeyHint }}</AppKbd>
            </span>
          </AppButton>
          <span v-if="keyDescriptions.complete" :id="descriptionIds.complete" class="sr-only">{{
            keyDescriptions.complete
          }}</span>
        </template>
      </div>
    </template>
  </AppDialog>
</template>
