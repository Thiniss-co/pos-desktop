<script setup lang="ts">
/**
 * Top-bar status pill (32px): network, sync queue, shift. Tone + icon + text; the text collapses
 * below 1100px (`hideTextBelowPills`) while the accessible name keeps the full label.
 */
import AppIcon from './AppIcon.vue'
import type { IconName } from './icons.generated'
import { PILL_TONE_CLASS, type PillTone } from './types'

withDefaults(
  defineProps<{
    tone: PillTone
    icon: IconName
    label: string
    as?: 'div' | 'button'
    hideTextBelowPills?: boolean
    trailingIcon?: IconName
    expanded?: boolean
    haspopup?: boolean
  }>(),
  {
    as: 'div',
    hideTextBelowPills: true,
    trailingIcon: undefined,
    expanded: undefined,
    haspopup: false
  }
)

const emit = defineEmits<{ click: [MouseEvent] }>()
</script>

<template>
  <component
    :is="as"
    :type="as === 'button' ? 'button' : undefined"
    :role="as === 'div' ? 'status' : undefined"
    :aria-label="label"
    :title="label"
    :aria-haspopup="haspopup ? 'menu' : undefined"
    :aria-expanded="expanded"
    class="app-pill flex h-8 flex-none items-center gap-1.5 rounded-full px-3 text-xs font-semibold whitespace-nowrap"
    :class="[PILL_TONE_CLASS[tone], { 'cursor-pointer hover:brightness-95': as === 'button' }]"
    @click="(event: MouseEvent) => emit('click', event)"
  >
    <AppIcon :name="icon" :size="18" />
    <span :class="{ 'hidden pills:inline': hideTextBelowPills }" aria-hidden="true">{{
      label
    }}</span>
    <AppIcon v-if="trailingIcon" :name="trailingIcon" :size="18" />
  </component>
</template>
