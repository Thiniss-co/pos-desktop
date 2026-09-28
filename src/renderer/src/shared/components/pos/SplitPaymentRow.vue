<script setup lang="ts">
/** One added tender (V3): method glyph, label, reference (LTR code), amount, Remove. */
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import type { DisplaySplitPayment } from './types'

withDefaults(
  defineProps<{
    payment: DisplaySplitPayment
    removeLabel: string
    /** Visible text of the remove action; the accessible name is `removeLabel`. */
    removeText?: string
  }>(),
  { removeText: undefined }
)

const emit = defineEmits<{ remove: [] }>()
</script>

<template>
  <div
    class="split-payment-row numeric flex items-center gap-3 rounded-notice border border-line px-3 py-2.5"
  >
    <span
      aria-hidden="true"
      class="flex size-9 flex-none items-center justify-center rounded-md bg-ok-bg text-ok"
      ><AppIcon name="check" :size="20"
    /></span>
    <div class="min-w-0 flex-1">
      <div class="split-payment-row__method font-semibold">{{ payment.methodLabel }}</div>
      <div v-if="payment.reference" class="code text-start text-xs text-muted">
        {{ payment.reference }}
      </div>
    </div>
    <span class="split-payment-row__amount font-bold whitespace-nowrap">{{ payment.amount }}</span>
    <AppButton
      variant="ghost"
      size="sm"
      icon="close"
      class="px-2 text-err"
      :aria-label="removeLabel"
      @click="emit('remove')"
    >
      {{ removeText ?? '' }}
    </AppButton>
  </div>
</template>
