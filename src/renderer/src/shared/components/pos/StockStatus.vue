<script setup lang="ts">
import { computed } from 'vue'
import AppStatusChip from '@renderer/shared/components/feedback/AppStatusChip.vue'
import type { StockLevel } from './types'

const props = defineProps<{
  level: StockLevel
  label: string
}>()

const chip = computed(() => {
  switch (props.level) {
    case 'in-stock':
      return { variant: 'success' as const, icon: 'check_circle' as const }
    case 'low-stock':
      return { variant: 'warning' as const, icon: 'warning' as const }
    case 'recorded':
      return { variant: 'neutral' as const, icon: 'inventory' as const }
    default:
      return { variant: 'error' as const, icon: 'block' as const }
  }
})
</script>

<template>
  <AppStatusChip :variant="chip.variant" :icon="chip.icon" size="sm">{{ label }}</AppStatusChip>
</template>
