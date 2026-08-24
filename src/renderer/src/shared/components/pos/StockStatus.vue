<script setup lang="ts">
import { computed } from 'vue'
import AppStatusChip from '@renderer/shared/components/feedback/AppStatusChip.vue'
import type { StockLevel } from './types'

const props = defineProps<{
  level: StockLevel
  label: string
}>()

const variant = computed(() => {
  switch (props.level) {
    case 'in-stock':
      return 'success' as const
    case 'low-stock':
      return 'warning' as const
    default:
      return 'error' as const
  }
})
</script>

<template>
  <AppStatusChip :variant="variant">{{ label }}</AppStatusChip>
</template>
