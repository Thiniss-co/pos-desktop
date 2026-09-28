<script setup lang="ts">
/** A compact icon-only control. `label` is required and renders as the accessible name — there is
 * no icon-only button anywhere in this app without one. Pass `icon` for a Material Symbol, or put
 * custom content in the default slot. */
import AppIcon from './AppIcon.vue'
import type { IconName } from './icons.generated'

withDefaults(
  defineProps<{
    label: string
    icon?: IconName
    variant?: 'ghost' | 'danger' | 'outline'
    size?: 'sm' | 'md'
    disabled?: boolean
    pressed?: boolean
    mirrorIcon?: boolean
  }>(),
  {
    icon: undefined,
    variant: 'ghost',
    size: 'md',
    disabled: false,
    pressed: undefined,
    mirrorIcon: false
  }
)

const emit = defineEmits<{ click: [MouseEvent] }>()
</script>

<template>
  <button
    type="button"
    class="app-icon-button inline-flex shrink-0 items-center justify-center rounded-md border transition-colors duration-150 disabled:cursor-not-allowed disabled:text-line-strong"
    :class="[
      `app-icon-button--${variant}`,
      size === 'sm' ? 'size-8' : 'size-10',
      variant === 'outline'
        ? 'border-line bg-surf text-ink enabled:hover:bg-subtle'
        : variant === 'danger'
          ? 'border-transparent text-err enabled:hover:bg-err-bg'
          : 'border-transparent text-ink enabled:hover:bg-subtle',
      { 'bg-pri-soft text-pri-text': pressed }
    ]"
    :aria-label="label"
    :title="label"
    :aria-pressed="pressed"
    :disabled="disabled"
    @click="(event) => emit('click', event)"
  >
    <slot>
      <AppIcon v-if="icon" :name="icon" :size="size === 'sm' ? 20 : 22" :mirror-rtl="mirrorIcon" />
    </slot>
  </button>
</template>
