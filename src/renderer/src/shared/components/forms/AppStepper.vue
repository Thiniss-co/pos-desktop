<script setup lang="ts">
/**
 * V3 quantity stepper: − value + in a bordered 40px group labelled for assistive tech. The value
 * is display-only (already formatted by the caller); the component never does arithmetic.
 */
import AppIcon from '../common/AppIcon.vue'

withDefaults(
  defineProps<{
    value: string | number
    groupLabel: string
    decreaseLabel: string
    increaseLabel: string
    decreaseDisabled?: boolean
    increaseDisabled?: boolean
    disabled?: boolean
    width?: 'sm' | 'md'
  }>(),
  { decreaseDisabled: false, increaseDisabled: false, disabled: false, width: 'sm' }
)

const emit = defineEmits<{ decrease: []; increase: [] }>()
</script>

<template>
  <div
    class="app-stepper flex h-10 items-center rounded-md border border-control bg-surf"
    :class="width === 'md' ? 'w-33' : 'w-28'"
    role="group"
    :aria-label="groupLabel"
  >
    <button
      type="button"
      class="flex h-full w-[38px] items-center justify-center rounded-s-md text-ink enabled:hover:bg-subtle disabled:text-line-strong"
      :aria-label="decreaseLabel"
      :disabled="disabled || decreaseDisabled"
      @click="emit('decrease')"
    >
      <AppIcon name="remove" :size="20" />
    </button>
    <span class="numeric flex-1 text-center text-base font-bold" aria-live="polite">{{
      value
    }}</span>
    <button
      type="button"
      class="flex h-full w-[38px] items-center justify-center rounded-e-md text-ink enabled:hover:bg-subtle disabled:text-line-strong"
      :aria-label="increaseLabel"
      :disabled="disabled || increaseDisabled"
      @click="emit('increase')"
    >
      <AppIcon name="add" :size="20" />
    </button>
  </div>
</template>
