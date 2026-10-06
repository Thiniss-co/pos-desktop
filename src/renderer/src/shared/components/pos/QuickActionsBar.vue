<script setup lang="ts">
/**
 * Quick actions for the cart column. Pure presentation: every action is emitted by id and the page
 * runs its existing handler (permissions and disabled rules stay the page's).
 *
 * - `row` / `wrap`: the large V3 tiles (wrap: ≥ 84px each over as many rows as needed).
 * - `toolbar` (POS workspace): one row of labelled buttons in priority order. What does not fit the
 *   cart's width moves, in the same order, into the More menu (a top-layer popover, never clipped),
 *   followed by the menu-only actions. Nothing is duplicated: an action is either on the row or in
 *   the menu. With `touch` the row and the menu use labelled ≥ 44px buttons and More shows its
 *   label, so nothing needs a shortcut, hover or a second toolbar row.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppDropdown from '@renderer/shared/components/common/AppDropdown.vue'
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import AppMenuItem from '@renderer/shared/components/common/AppMenuItem.vue'
import type { DisplayQuickAction } from './types'

const props = withDefaults(
  defineProps<{
    actions: readonly DisplayQuickAction[]
    label: string
    layout?: 'row' | 'wrap' | 'toolbar'
    /** Toolbar only: actions that always live in the More menu. */
    menuActions?: readonly DisplayQuickAction[]
    moreLabel?: string
    touch?: boolean
    /** Bumped by the page (a scan, layout editing) to close an open More menu. */
    closeSignal?: number
  }>(),
  { layout: 'row', menuActions: () => [], moreLabel: 'More', touch: false, closeSignal: 0 }
)

const emit = defineEmits<{ action: [string] }>()

const rootRef = ref<HTMLElement | null>(null)
const measureRef = ref<HTMLElement | null>(null)
const moreOpen = ref(false)
/** How many leading actions fit on the row (toolbar, pointer mode). */
const fitCount = ref(Number.POSITIVE_INFINITY)
let observer: ResizeObserver | null = null

const inlineActions = computed(() => props.actions.slice(0, fitCount.value))
const overflowActions = computed(() =>
  props.actions.slice(Math.min(fitCount.value, props.actions.length))
)
const menuItems = computed(() => [...overflowActions.value, ...props.menuActions])

watch(
  () => props.closeSignal,
  () => (moreOpen.value = false)
)

const GAP = 6

/** Measures the natural widths once per change and keeps as many leading actions as fit. */
function measure(): void {
  if (props.layout !== 'toolbar') {
    return
  }
  const root = rootRef.value
  const probe = measureRef.value
  if (!root || !probe) {
    return
  }
  const widths = Array.from(probe.querySelectorAll<HTMLElement>('[data-probe-action]')).map(
    (element) => element.offsetWidth
  )
  const moreWidth = probe.querySelector<HTMLElement>('[data-probe-more]')?.offsetWidth ?? 44
  const available = root.clientWidth
  // Not laid out yet (hidden, or no layout engine): keep every action on the row.
  if (available === 0) {
    fitCount.value = Number.POSITIVE_INFINITY
    return
  }
  let used = 0
  let count = 0
  for (let index = 0; index < widths.length; index += 1) {
    const remaining = widths.length - index - 1
    const needsMore = remaining > 0 || props.menuActions.length > 0
    const next = used + (count > 0 ? GAP : 0) + widths[index]
    if (next + (needsMore ? GAP + moreWidth : 0) > available) {
      break
    }
    used = next
    count += 1
  }
  fitCount.value = count
}

onMounted(() => {
  void nextTick(measure)
  if (typeof ResizeObserver !== 'undefined' && rootRef.value) {
    observer = new ResizeObserver(() => measure())
    observer.observe(rootRef.value)
  }
})

watch(
  () => [props.actions.map((a) => `${a.id}:${a.label}:${a.badge ?? ''}`).join('|'), props.touch],
  () => void nextTick(measure)
)

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
})

function choose(id: string, close?: () => void): void {
  close?.()
  emit('action', id)
}
</script>

<template>
  <div
    v-if="layout === 'toolbar'"
    ref="rootRef"
    class="quick-actions quick-actions--toolbar relative flex min-w-0 flex-none flex-nowrap items-center gap-1.5"
    role="toolbar"
    :aria-label="label"
  >
    <button
      v-for="action in inlineActions"
      :key="action.id"
      type="button"
      class="quick-actions__tile quick-actions__tool relative flex h-(--cart-tool-h) max-w-full min-w-0 flex-none items-center gap-1.5 rounded-md border px-2.5 text-sm font-semibold whitespace-nowrap focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50"
      :class="[
        action.active
          ? 'border-pri bg-pri-soft text-pri-text'
          : 'border-line bg-surf text-ink enabled:hover:border-pri enabled:hover:bg-pri-soft',
        action.tone === 'danger' ? 'text-err' : ''
      ]"
      :data-action="action.id"
      :disabled="action.disabled"
      :aria-keyshortcuts="action.shortcut"
      :aria-label="action.ariaLabel"
      :title="action.shortcut ? `${action.label} (${action.shortcut})` : action.label"
      @click="choose(action.id)"
    >
      <AppIcon
        v-if="action.icon"
        :name="action.icon"
        :size="18"
        class="flex-none"
        :class="action.tone === 'danger' ? 'text-err' : 'text-pri-text'"
      />
      <span class="quick-actions__label min-w-0 truncate">{{ action.label }}</span>
      <span
        v-if="action.badge"
        class="quick-actions__badge numeric flex h-5 min-w-5 flex-none items-center justify-center rounded-full bg-pri px-1.5 text-[0.6875rem] font-bold text-on-pri"
        >{{ action.badge }}</span
      >
    </button>
    <AppDropdown
      v-if="menuItems.length > 0"
      v-model:open="moreOpen"
      layer="top"
      align="end"
      width="280px"
      :label="moreLabel"
      :trigger-title="moreLabel"
      class="quick-actions__more ms-auto flex-none"
      trigger-class="quick-actions__tile quick-actions__tool flex h-(--cart-tool-h) min-w-(--cart-tool-h) items-center justify-center gap-1.5 rounded-md border border-line bg-surf px-2 text-sm font-semibold text-ink hover:border-pri hover:bg-pri-soft focus-visible:ring-2 focus-visible:ring-focus"
    >
      <template #trigger>
        <span class="flex items-center gap-1.5" data-action="more">
          <AppIcon name="more_horiz" :size="20" class="text-pri-text" />
          <span v-if="touch">{{ moreLabel }}</span>
        </span>
      </template>
      <template #default="{ close }">
        <AppMenuItem
          v-for="action in menuItems"
          :key="action.id"
          :icon="action.icon"
          :tone="action.tone === 'danger' ? 'danger' : 'default'"
          :disabled="action.disabled"
          :data-action="action.id"
          :aria-keyshortcuts="action.shortcut"
          :aria-label="action.ariaLabel"
          @select="choose(action.id, close)"
        >
          <span class="flex items-center justify-between gap-2">
            <span class="min-w-0 [overflow-wrap:anywhere]">{{ action.label }}</span>
            <span
              v-if="action.badge"
              class="numeric rounded-full bg-pri px-1.5 text-[0.6875rem] font-bold text-on-pri"
              >{{ action.badge }}</span
            >
            <span v-else-if="action.shortcut" class="text-xs font-normal text-muted" dir="ltr">{{
              action.shortcut
            }}</span>
          </span>
        </AppMenuItem>
      </template>
    </AppDropdown>
    <!-- Invisible probe: the natural width of every action, for the overflow calculation. -->
    <div
      ref="measureRef"
      class="pointer-events-none invisible absolute start-0 top-0 flex gap-1.5"
      aria-hidden="true"
      inert
    >
      <span
        v-for="action in actions"
        :key="action.id"
        data-probe-action
        class="flex h-(--cart-tool-h) flex-none items-center gap-1.5 rounded-md border px-2.5 text-sm font-semibold whitespace-nowrap"
      >
        <span v-if="action.icon" class="size-[18px] flex-none" />{{ action.label
        }}<span v-if="action.badge" class="min-w-5 px-1.5 text-[0.6875rem]">{{
          action.badge
        }}</span>
      </span>
      <span
        data-probe-more
        class="flex h-(--cart-tool-h) min-w-(--cart-tool-h) items-center gap-1.5 border px-2 text-sm font-semibold"
        ><span class="size-5 flex-none" /><span v-if="touch">{{ moreLabel }}</span></span
      >
    </div>
  </div>
  <div
    v-else
    class="quick-actions mx-4 grid flex-none gap-2"
    :style="{
      gridTemplateColumns:
        layout === 'wrap'
          ? 'repeat(auto-fill, minmax(5.25rem, 1fr))'
          : `repeat(${Math.max(actions.length, 1)}, minmax(0, 1fr))`
    }"
    role="toolbar"
    :aria-label="label"
  >
    <button
      v-for="action in actions"
      :key="action.id"
      type="button"
      class="quick-actions__tile relative flex min-h-15 flex-col items-center justify-center gap-0.5 rounded-notice border border-line bg-surf px-1.5 py-2 text-xs font-semibold text-ink hover:border-pri hover:bg-pri-soft focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-line disabled:hover:bg-surf"
      :class="{ 'text-err': action.tone === 'danger' }"
      :data-action="action.id"
      :disabled="action.disabled"
      :aria-keyshortcuts="action.shortcut"
      :title="action.shortcut ? `${action.label} (${action.shortcut})` : action.label"
      @click="emit('action', action.id)"
    >
      <AppIcon
        v-if="action.icon"
        :name="action.icon"
        :size="22"
        :class="action.tone === 'danger' ? 'text-err' : 'text-pri-text'"
      />
      <span class="quick-actions__label leading-tight text-balance [overflow-wrap:anywhere]">{{
        action.label
      }}</span>
      <span v-if="action.shortcut" class="text-[0.6875rem] font-normal text-muted" dir="ltr">{{
        action.shortcut
      }}</span>
      <span
        v-if="action.badge"
        class="quick-actions__badge numeric absolute -top-1.5 -end-1.5 flex h-5.5 min-w-5.5 items-center justify-center rounded-full bg-pri px-1.5 text-[0.6875rem] font-bold text-on-pri"
        >{{ action.badge }}</span
      >
    </button>
  </div>
</template>
