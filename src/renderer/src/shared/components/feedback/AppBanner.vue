<script setup lang="ts">
/**
 * V3 inline notice: tinted 10px-radius block, coloured icon, bold title + body, optional action
 * and dismiss. `bar` renders the full-width strip used under the top bar (connectivity/sync).
 */
import { computed } from 'vue'
import AppIcon from '../common/AppIcon.vue'
import AppIconButton from '../common/AppIconButton.vue'
import type { IconName } from '../common/icons.generated'

type Variant = 'info' | 'success' | 'warning' | 'error' | 'neutral'

const props = withDefaults(
  defineProps<{
    variant?: Variant
    role?: 'alert' | 'status' | 'note'
    title?: string
    icon?: IconName
    bar?: boolean
    dismissLabel?: string
  }>(),
  {
    variant: 'info',
    role: 'status',
    title: undefined,
    icon: undefined,
    bar: false,
    dismissLabel: undefined
  }
)

const emit = defineEmits<{ dismiss: [] }>()

const DEFAULT_ICON: Record<Variant, IconName> = {
  info: 'info',
  success: 'check_circle',
  warning: 'warning',
  error: 'error',
  neutral: 'info'
}
const BG: Record<Variant, string> = {
  info: 'bg-info-bg',
  success: 'bg-ok-bg',
  warning: 'bg-warn-bg',
  error: 'bg-err-bg',
  neutral: 'bg-subtle'
}
const FG: Record<Variant, string> = {
  info: 'text-info',
  success: 'text-ok',
  warning: 'text-warn',
  error: 'text-err',
  neutral: 'text-muted'
}

const iconName = computed(() => props.icon ?? DEFAULT_ICON[props.variant])
</script>

<template>
  <div
    class="app-banner flex flex-wrap items-start gap-2.5 text-sm text-ink"
    :class="[
      `app-banner--${variant}`,
      BG[variant],
      bar ? 'items-center gap-3 border-b border-line px-4 py-2.5' : 'rounded-notice px-3.5 py-3',
      { 'border border-line': variant === 'neutral' && !bar }
    ]"
    :role="role"
  >
    <AppIcon :name="iconName" :size="20" class="app-banner__icon mt-px" :class="FG[variant]" />
    <div class="app-banner__content min-w-[200px] flex-1 text-pretty">
      <p v-if="title" class="font-bold" :class="bar ? 'inline' : 'text-base'">{{ title }}</p>
      <template v-if="bar && title">{{ ' ' }}</template>
      <component :is="bar && title ? 'span' : 'div'" :class="{ 'mt-0.5': title && !bar }"
        ><slot
      /></component>
    </div>
    <div v-if="$slots.action" class="app-banner__action flex flex-wrap items-center gap-2">
      <slot name="action" />
    </div>
    <AppIconButton
      v-if="dismissLabel"
      :label="dismissLabel"
      icon="close"
      size="sm"
      class="-my-1"
      @click="emit('dismiss')"
    />
  </div>
</template>
