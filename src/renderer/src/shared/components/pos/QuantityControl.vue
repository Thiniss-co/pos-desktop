<script setup lang="ts">
/**
 * Cart-line quantity stepper (V3): − value + in a 112×40 bordered group. Display only.
 * `fluid` (POS workspace) sizes it from the workspace density tokens: 28px controls in the compact
 * density, 44px in the comfortable one (touch mode raises it further through touch.css).
 */
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'

withDefaults(
  defineProps<{
    quantity: number
    decreaseLabel: string
    increaseLabel: string
    groupLabel?: string
    disabled?: boolean
    min?: number
    /** POS improvements, Stage 5: touch mode — the value opens a keypad (`edit`). */
    editLabel?: string | null
    fluid?: boolean
  }>(),
  { groupLabel: undefined, disabled: false, min: 1, editLabel: null, fluid: false }
)

const emit = defineEmits<{ decrease: []; increase: []; edit: [] }>()
</script>

<template>
  <div
    class="quantity-control flex items-center rounded-md border border-control"
    :class="fluid ? 'quantity-control--fluid h-(--cart-ctl) w-full' : 'h-10 w-28'"
    role="group"
    :aria-label="groupLabel"
  >
    <button
      type="button"
      class="quantity-control__button flex h-full flex-none items-center justify-center rounded-s-md text-ink enabled:hover:bg-subtle disabled:text-line-strong"
      :aria-label="decreaseLabel"
      :disabled="disabled || quantity <= min"
      :class="fluid ? 'w-(--cart-ctl)' : 'w-[38px]'"
      @click="emit('decrease')"
    >
      <AppIcon name="remove" :size="fluid ? 18 : 20" />
    </button>
    <button
      v-if="editLabel"
      type="button"
      class="quantity-control__value numeric h-full flex-1 text-center text-base font-bold underline decoration-dotted underline-offset-4"
      :aria-label="editLabel"
      :disabled="disabled"
      @click="emit('edit')"
    >
      {{ quantity }}
    </button>
    <span
      v-else
      class="quantity-control__value numeric flex-1 text-center text-base font-bold"
      aria-live="polite"
      >{{ quantity }}</span
    >
    <button
      type="button"
      class="quantity-control__button flex h-full flex-none items-center justify-center rounded-e-md text-ink enabled:hover:bg-subtle disabled:text-line-strong"
      :aria-label="increaseLabel"
      :disabled="disabled"
      :class="fluid ? 'w-(--cart-ctl)' : 'w-[38px]'"
      @click="emit('increase')"
    >
      <AppIcon name="add" :size="fluid ? 18 : 20" />
    </button>
  </div>
</template>
