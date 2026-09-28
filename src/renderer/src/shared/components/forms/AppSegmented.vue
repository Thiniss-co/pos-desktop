<script setup lang="ts" generic="T extends string">
/**
 * V3 radio tiles (discount type, payment method, paper width, print mode, refund method, filters).
 * A real `role="radiogroup"` with roving arrow-key selection. Each option may carry an icon and a
 * sub-line; disabled options stay visible with their reason (never hidden).
 */
import { useId } from 'vue'
import AppIcon from '../common/AppIcon.vue'
import type { IconName } from '../common/icons.generated'

const props = withDefaults(
  defineProps<{
    modelValue: T | null
    label: string
    options: ReadonlyArray<{
      value: T
      label: string
      sub?: string
      icon?: IconName
      disabled?: boolean
    }>
    columns?: number
    layout?: 'tile' | 'stack' | 'chip' | 'icon-tile'
    hideLabel?: boolean
    disabled?: boolean
  }>(),
  { columns: 0, layout: 'tile', hideLabel: false, disabled: false }
)

const emit = defineEmits<{ 'update:modelValue': [T] }>()
const labelId = useId()

function select(value: T): void {
  emit('update:modelValue', value)
}

function onKeydown(event: KeyboardEvent, index: number): void {
  const forward = ['ArrowDown', 'ArrowRight']
  const backward = ['ArrowUp', 'ArrowLeft']
  if (!forward.includes(event.key) && !backward.includes(event.key)) {
    return
  }
  event.preventDefault()
  const rtl = (event.currentTarget as HTMLElement).closest('[dir="rtl"]') !== null
  let step = forward.includes(event.key) ? 1 : -1
  if (rtl && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    step = -step
  }
  const enabled = props.options
    .map((option, i) => ({ option, i }))
    .filter(({ option }) => !option.disabled)
  const position = enabled.findIndex(({ i }) => i === index)
  const next = enabled[(position + step + enabled.length) % enabled.length]
  if (next) {
    select(next.option.value)
    const group = (event.currentTarget as HTMLElement).parentElement
    group?.querySelectorAll<HTMLElement>('[role="radio"]')[next.i]?.focus()
  }
}
</script>

<template>
  <div
    class="app-segmented flex flex-col gap-1.5"
    role="radiogroup"
    :aria-labelledby="labelId"
    :aria-disabled="disabled || undefined"
  >
    <span :id="labelId" class="text-sm font-semibold" :class="{ 'sr-only': hideLabel }">{{
      label
    }}</span>
    <div
      :class="[
        layout === 'stack'
          ? 'flex flex-col gap-1.5'
          : layout === 'chip'
            ? 'flex flex-wrap gap-1.5'
            : 'grid gap-2'
      ]"
      :style="
        layout === 'tile' || layout === 'icon-tile'
          ? { gridTemplateColumns: `repeat(${columns || options.length}, minmax(0, 1fr))` }
          : undefined
      "
    >
      <button
        v-for="(option, index) in options"
        :key="option.value"
        type="button"
        role="radio"
        :aria-checked="modelValue === option.value"
        :tabindex="modelValue === option.value || (modelValue === null && index === 0) ? 0 : -1"
        :disabled="disabled || option.disabled"
        class="app-segmented__option text-ink transition-colors disabled:cursor-not-allowed disabled:border-dashed disabled:bg-subtle disabled:text-muted"
        :class="[
          layout === 'chip'
            ? 'h-10 rounded-full border px-3.5 text-sm font-semibold'
            : layout === 'icon-tile'
              ? 'flex h-16 flex-col items-center justify-center gap-1 rounded-notice border-2 text-base font-bold'
              : layout === 'stack'
                ? 'flex min-h-11 items-center gap-2.5 rounded-md border px-3 py-2 text-start text-sm font-semibold'
                : 'flex min-h-11 flex-col justify-center rounded-md border px-3 py-2 text-start text-sm font-semibold',
          option.sub && layout === 'tile' ? 'min-h-14 border-2' : '',
          modelValue === option.value
            ? 'border-pri bg-pri-soft text-pri-text'
            : 'border-control bg-surf enabled:hover:bg-subtle'
        ]"
        @click="select(option.value)"
        @keydown="onKeydown($event, index)"
      >
        <AppIcon v-if="option.icon" :name="option.icon" :size="layout === 'icon-tile' ? 22 : 20" />
        <span class="block" :class="{ 'font-bold': option.sub }">{{ option.label }}</span>
        <span v-if="option.sub" class="block text-xs font-normal text-muted">{{ option.sub }}</span>
      </button>
    </div>
  </div>
</template>
