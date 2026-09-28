<script setup lang="ts">
import AppIcon from '../common/AppIcon.vue'
import type { IconName } from '../common/icons.generated'

withDefaults(
  defineProps<{
    title: string
    description?: string
    icon?: IconName
    compact?: boolean
  }>(),
  { description: undefined, icon: undefined, compact: false }
)
</script>

<template>
  <div
    class="app-empty-state flex flex-col items-center gap-2 text-center"
    :class="compact ? 'px-3 py-6' : 'px-4 py-12'"
  >
    <div v-if="$slots.icon" class="app-empty-state__icon text-muted" aria-hidden="true">
      <slot name="icon" />
    </div>
    <AppIcon v-else-if="icon" :name="icon" :size="40" class="text-muted" />
    <p class="app-empty-state__title text-md font-bold">{{ title }}</p>
    <p
      v-if="description"
      class="app-empty-state__description max-w-[320px] text-pretty text-sm text-muted"
    >
      {{ description }}
    </p>
    <div
      v-if="$slots.action"
      class="app-empty-state__action mt-2 flex flex-wrap justify-center gap-2.5"
    >
      <slot name="action" />
    </div>
  </div>
</template>
