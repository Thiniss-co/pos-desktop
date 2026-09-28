<script setup lang="ts">
/**
 * V3 status pill: tinted background + icon + text, 999px radius. Status is never colour alone —
 * every variant carries an icon (default per variant, or `icon` to name a more specific one).
 */
import { computed } from 'vue'
import AppIcon from '../common/AppIcon.vue'
import type { IconName } from '../common/icons.generated'

type Variant = 'success' | 'warning' | 'error' | 'information' | 'neutral' | 'primary'

const props = withDefaults(
  defineProps<{
    variant?: Variant
    icon?: IconName
    size?: 'sm' | 'md'
  }>(),
  { variant: 'neutral', icon: undefined, size: 'md' }
)

const DEFAULT_ICON: Record<Variant, IconName> = {
  success: 'check_circle',
  warning: 'warning',
  error: 'error',
  information: 'info',
  neutral: 'remove',
  primary: 'check'
}

const TONE: Record<Variant, string> = {
  success: 'bg-ok-bg text-ok',
  warning: 'bg-warn-bg text-warn',
  error: 'bg-err-bg text-err',
  information: 'bg-info-bg text-info',
  neutral: 'border border-line bg-subtle text-ink',
  primary: 'bg-pri-soft text-pri-text'
}

const iconName = computed(() => props.icon ?? DEFAULT_ICON[props.variant])
</script>

<template>
  <span
    class="app-status-chip inline-flex max-w-full items-center gap-1 rounded-full font-semibold leading-[1.3] whitespace-nowrap"
    :class="[
      `app-status-chip--${variant}`,
      TONE[variant],
      size === 'sm' ? 'min-h-6 px-2 py-0.5 text-xs' : 'min-h-[26px] px-2.5 py-0.5 text-xs'
    ]"
  >
    <AppIcon :name="iconName" :size="15" class="app-status-chip__icon" />
    <span class="app-status-chip__label truncate"><slot /></span>
  </span>
</template>
