<script setup lang="ts">
/**
 * Open / pause / close shift dialogs (V3 `pos_shift_dialogs`). Lifecycle calls go straight to the
 * shift store exactly as the POS page did before the redesign moved shift actions into the shell:
 * whole-number minor units, the same validation message, and the store's own authority checks
 * (it still refuses any lifecycle change until an authoritative refresh succeeds).
 */
import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import type { LocaleCode } from '@shared/contracts/preferences.contract'
import { formatMinorCurrency } from '@shared/money/minorUnits'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppDialog from '@renderer/shared/components/common/AppDialog.vue'
import AppInlineError from '@renderer/shared/components/feedback/AppInlineError.vue'
import AppInput from '@renderer/shared/components/forms/AppInput.vue'
import AppTextarea from '@renderer/shared/components/forms/AppTextarea.vue'
import NumericAmountInput from '@renderer/shared/components/pos/NumericAmountInput.vue'
import { useLocaleStore } from '@renderer/modules/preferences/locale.store'
import { useUserPreferencesStore } from '@renderer/modules/preferences/userPreferences.store'
import { useCartStore } from '../cart.store'
import { useShiftStore } from '../shift.store'
import { useShiftDialogStore } from '../shiftDialog.store'

const { t } = useI18n()
const shift = useShiftStore()
const dialog = useShiftDialogStore()
const cart = useCartStore()
const localeStore = useLocaleStore()
const userPreferences = useUserPreferencesStore()
const { currentShift, activeShiftUuid, mutation, error: shiftError } = storeToRefs(shift)
const { mode } = storeToRefs(dialog)

const cashAmount = ref('0.00')
const cashError = ref<string | null>(null)
const note = ref('')

const currency = computed(() => cart.contract?.currency ?? 'EGP')
const busy = computed(() => mutation.value !== null)
// Touch mode: the opening/closing cash is entered on the same on-screen keypad as the tender.
const keypadLabels = computed(() =>
  userPreferences.preferences.touchMode
    ? {
        backspace: t('touch.keypad.backspace'),
        clear: t('touch.keypad.clear'),
        decimal: t('touch.keypad.decimal')
      }
    : null
)
const cashLabel = computed(() =>
  mode.value === 'open' ? t('pos.openingCash') : t('pos.actualCash')
)
const cashHint = computed(() =>
  mode.value === 'open' ? t('pos.shiftDialog.openHelp') : t('pos.shiftDialog.closeHelp')
)

const expectedCashLabel = computed(() => {
  const expected = currentShift.value?.expectedCashAmount
  if (mode.value !== 'close' || expected === null || expected === undefined) {
    return null
  }
  const formatted = formatMinorCurrency(
    expected,
    localeStore.locale as LocaleCode,
    currency.value,
    cart.contract?.currencyExponent ?? 2
  )
  return formatted.ok ? t('pos.shiftDialog.expectedCash', { amount: formatted.value }) : null
})

watch(mode, (next) => {
  if (next === null) {
    return
  }
  cashAmount.value =
    next === 'close' && currentShift.value?.expectedCashAmount !== null
      ? String((currentShift.value?.expectedCashAmount ?? 0) / 100)
      : '0.00'
  note.value = ''
  cashError.value = null
})

function parseMinorUnits(value: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim())

  if (!match) {
    return null
  }

  const amount = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
  return Number.isSafeInteger(amount) && amount <= 2_147_483_647 ? amount : null
}

async function submit(): Promise<void> {
  const amount = parseMinorUnits(cashAmount.value)
  let succeeded = false

  if (mode.value !== 'pause' && amount === null) {
    cashError.value = t('pos.invalidCash')
    return
  }

  if (mode.value === 'open' && amount !== null) {
    succeeded = await shift.open({ openingCashAmount: amount, notes: note.value || null })
  } else if (mode.value === 'pause' && activeShiftUuid.value) {
    // `activeShiftUuid` may come from local authority while the backend is unreachable. The store's
    // `mutate` still refuses to send any lifecycle change until an authoritative refresh succeeds,
    // so this surfaces the real transport denial instead of silently doing nothing.
    succeeded = await shift.pause({
      uuid: activeShiftUuid.value,
      reason: note.value || null,
      notes: null
    })
  } else if (mode.value === 'close' && activeShiftUuid.value && amount !== null) {
    succeeded = await shift.close({
      uuid: activeShiftUuid.value,
      actualCashAmount: amount,
      closeNotes: note.value || null
    })
  }

  if (succeeded) {
    dialog.dismiss()
  }
}

const submitLabel = computed(() =>
  mode.value === 'open'
    ? busy.value
      ? t('pos.shift.opening')
      : t('pos.openShift')
    : mode.value === 'close'
      ? busy.value
        ? t('pos.shift.closing')
        : t('pos.closeShift')
      : t('pos.pauseShift')
)
</script>

<template>
  <AppDialog
    :open="mode !== null"
    size="sm"
    :close-label="t('common.close')"
    :persistent="busy"
    @close="dialog.dismiss()"
  >
    <template #title>{{ mode ? t(`pos.dialog.${mode}`) : '' }}</template>
    <form id="shift-dialog-form" class="flex flex-col gap-4" novalidate @submit.prevent="submit">
      <p v-if="mode === 'pause'" class="text-muted">{{ t('pos.shiftDialog.pauseBody') }}</p>
      <!-- The pre-filled amount is selected on focus, so the first keypad key replaces it. -->
      <NumericAmountInput
        v-if="mode !== 'pause' && keypadLabels"
        v-model="cashAmount"
        :label="cashLabel"
        :prefix="currency"
        autofocus
        select-on-focus
        :error="cashError ?? undefined"
        :hint="cashHint"
        :keypad-labels="keypadLabels"
        :max-decimals="2"
      />
      <AppInput
        v-else-if="mode !== 'pause'"
        v-model="cashAmount"
        :label="cashLabel"
        :prefix="currency"
        inputmode="decimal"
        size="lg"
        autofocus
        :error="cashError ?? undefined"
        :hint="cashHint"
      />
      <p v-if="expectedCashLabel" class="numeric -mt-2 text-sm text-muted">
        {{ expectedCashLabel }}
      </p>
      <AppTextarea
        v-model="note"
        :label="t('pos.notes')"
        :placeholder="mode === 'pause' ? t('pos.shiftDialog.pausePlaceholder') : undefined"
        :autofocus="mode === 'pause'"
      />
      <AppInlineError v-if="shiftError">{{ shiftError }}</AppInlineError>
    </form>
    <template #actions>
      <AppButton variant="secondary" :disabled="busy" @click="dialog.dismiss()">
        {{ t('common.cancel') }}
      </AppButton>
      <AppButton type="submit" form="shift-dialog-form" variant="primary" :loading="busy">
        {{ submitLabel }}
      </AppButton>
    </template>
  </AppDialog>
</template>
