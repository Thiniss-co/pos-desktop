<script setup lang="ts">
/**
 * V3 category selector: pastel tiles (72px, icon + label, selected = 2px indigo border) on wide
 * layouts, a horizontal chip row when `compact`. Pastels cycle by position and never mean a
 * status. Real categories carry no icon in the catalog contract, so they share the generic
 * category glyph; "All" uses the grid glyph.
 */
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import type { DisplayCategory } from './types'

withDefaults(
  defineProps<{
    categories: readonly DisplayCategory[]
    selectedId: string | null
    allLabel: string
    groupLabel?: string
    compact?: boolean
  }>(),
  { groupLabel: undefined, compact: false }
)

const emit = defineEmits<{ select: [string | null] }>()

const TONE_BG = ['bg-cat-0', 'bg-cat-1', 'bg-cat-2', 'bg-cat-3', 'bg-cat-4', 'bg-cat-5']
const TONE_INK = [
  'text-cat-ink-0',
  'text-cat-ink-1',
  'text-cat-ink-2',
  'text-cat-ink-3',
  'text-cat-ink-4',
  'text-cat-ink-5'
]
</script>

<template>
  <div
    class="category-selector flex flex-none overflow-x-auto"
    :class="compact ? 'gap-2 pb-0.5' : 'gap-2.5 p-0.5'"
    role="group"
    :aria-label="groupLabel"
  >
    <button
      v-for="(entry, index) in [{ id: null, label: allLabel, tone: 0 }, ...categories]"
      :key="entry.id ?? '__all'"
      type="button"
      class="category-selector__chip flex items-center border-2 font-semibold whitespace-nowrap transition-colors"
      :class="[
        TONE_BG[(entry.tone ?? index) % 6],
        TONE_INK[(entry.tone ?? index) % 6],
        selectedId === entry.id ? 'border-pri' : 'border-transparent hover:border-line-strong',
        compact
          ? 'h-10 flex-none gap-1.5 rounded-full px-3.5 text-sm'
          : 'h-18 min-w-28 flex-[1_0_112px] flex-col justify-center gap-1 rounded-lg px-2 text-sm'
      ]"
      :aria-pressed="selectedId === entry.id"
      @click="emit('select', entry.id)"
    >
      <AppIcon :name="entry.id === null ? 'grid_view' : 'category'" :size="compact ? 18 : 22" />
      <span class="max-w-full truncate">{{ entry.label }}</span>
    </button>
  </div>
</template>
