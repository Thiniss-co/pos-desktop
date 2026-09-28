<script setup lang="ts">
/** Large, touch-friendly quick-action tiles for the V3 cart column. Pure presentation. */
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import type { DisplayQuickAction } from './types'

withDefaults(
  defineProps<{
    actions: readonly DisplayQuickAction[]
    label: string
  }>(),
  {}
)

const emit = defineEmits<{ action: [string] }>()
</script>

<template>
  <div
    class="quick-actions mx-4 grid flex-none gap-2"
    :style="{ gridTemplateColumns: `repeat(${Math.max(actions.length, 1)}, minmax(0, 1fr))` }"
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
      <span class="quick-actions__label leading-tight">{{ action.label }}</span>
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
