<script setup lang="ts">
/**
 * The single button primitive for the app. Every other button in the codebase (submit, link,
 * icon-only, danger confirm) is built on this — no page should style a bare `<button>` itself.
 *
 * V3 variants (docs/design/claude-v3): exactly ONE filled indigo action per view.
 * - `primary`     filled indigo — Pay / Complete sale / Confirm refund / the final confirm.
 * - `transaction` the full-width 56px Pay button (filled indigo, large).
 * - `secondary`   outline on the surface — every other action.
 * - `outline`     indigo outline + indigo text (e.g. "Add payment" inside the tender card).
 * - `soft`        indigo-tinted fill for toggles and selected chips.
 * - `ghost`       no border (Cancel in dialog footers, text links, row actions).
 * - `danger`      filled red — destructive final confirm (clear cart, abandon sale).
 * - `danger-outline` outline with red text — destructive entry points (Abandon, Disable).
 *
 * `app-button--<variant>` stays on the element as a stable hook for tests and diagnostics.
 */
import { computed } from 'vue'
import AppIcon from './AppIcon.vue'
import AppSpinner from './AppSpinner.vue'
import type { IconName } from './icons.generated'

type Variant =
  | 'primary'
  | 'secondary'
  | 'transaction'
  | 'outline'
  | 'soft'
  | 'ghost'
  | 'danger'
  | 'danger-outline'

const props = withDefaults(
  defineProps<{
    variant?: Variant
    size?: 'sm' | 'md' | 'lg' | 'xl'
    type?: 'button' | 'submit' | 'reset'
    disabled?: boolean
    loading?: boolean
    fullWidth?: boolean
    icon?: IconName
    iconEnd?: IconName
    /** Mirror the icons in RTL — only for directional glyphs (arrows, chevrons). */
    mirrorIcon?: boolean
  }>(),
  {
    variant: 'primary',
    size: 'md',
    type: 'button',
    disabled: false,
    loading: false,
    fullWidth: false,
    icon: undefined,
    iconEnd: undefined,
    mirrorIcon: false
  }
)

const emit = defineEmits<{ click: [MouseEvent] }>()

const VARIANT: Record<Variant, string> = {
  primary:
    'border-pri bg-pri text-on-pri font-bold enabled:hover:border-pri-hover enabled:hover:bg-pri-hover enabled:active:bg-pri-press',
  transaction:
    'border-pri bg-pri text-on-pri font-bold enabled:hover:border-pri-hover enabled:hover:bg-pri-hover enabled:active:bg-pri-press',
  secondary: 'border-control bg-surf text-ink enabled:hover:bg-subtle',
  outline: 'border-pri bg-surf text-pri-text font-bold enabled:hover:bg-pri-soft',
  soft: 'border-transparent bg-pri-soft text-pri-text',
  ghost: 'border-transparent bg-transparent text-ink enabled:hover:bg-subtle',
  danger:
    'border-danger bg-danger text-on-pri font-bold enabled:hover:border-danger-hover enabled:hover:bg-danger-hover',
  'danger-outline': 'border-control bg-surf text-err enabled:hover:bg-err-bg'
}

const SIZE = {
  sm: 'min-h-9 px-3 text-sm rounded-md',
  md: 'min-h-11 px-4 text-base rounded-md',
  lg: 'min-h-12 px-4.5 text-base rounded-md',
  xl: 'min-h-[52px] px-5.5 text-md font-bold rounded-notice'
} as const

const classes = computed(() => [
  `app-button--${props.variant}`,
  VARIANT[props.variant],
  props.variant === 'transaction'
    ? 'min-h-14 w-full px-4 text-[1.125rem] rounded-notice'
    : SIZE[props.size],
  { 'app-button--full w-full': props.fullWidth },
  // Disabled is never colour alone: the fill drops out and the cursor changes. A loading button
  // keeps its face so the pending action stays recognisable.
  props.variant === 'ghost'
    ? 'not-aria-busy:disabled:text-muted'
    : 'not-aria-busy:disabled:border-line-strong not-aria-busy:disabled:bg-subtle not-aria-busy:disabled:text-muted'
])
</script>

<template>
  <button
    :type="type"
    class="app-button numeric inline-flex shrink-0 items-center justify-center gap-2 border font-semibold whitespace-nowrap transition-colors duration-150 disabled:cursor-not-allowed aria-busy:opacity-85"
    :class="classes"
    :disabled="disabled || loading"
    :aria-busy="loading || undefined"
    @click="(event) => emit('click', event)"
  >
    <AppSpinner v-if="loading" class="app-button__spinner" :size="18" />
    <AppIcon v-else-if="icon" :name="icon" :size="20" :mirror-rtl="mirrorIcon" />
    <span class="app-button__label"><slot /></span>
    <AppIcon v-if="iconEnd && !loading" :name="iconEnd" :size="20" :mirror-rtl="mirrorIcon" />
  </button>
</template>
