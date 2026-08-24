<script setup lang="ts">
import { computed } from 'vue'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppStatusChip from '@renderer/shared/components/feedback/AppStatusChip.vue'
import type { ShiftPhase } from './types'

const props = withDefaults(
  defineProps<{
    phase: ShiftPhase
    phaseLabel: string
    openLabel: string
    pauseLabel: string
    resumeLabel: string
    closeLabel: string
  }>(),
  {}
)

const emit = defineEmits<{ open: []; pause: []; resume: []; close: [] }>()

const chipVariant = computed(() => {
  switch (props.phase) {
    case 'open':
      return 'success' as const
    case 'paused':
      return 'warning' as const
    case 'closed':
      return 'neutral' as const
    default:
      return 'information' as const
  }
})

const isBusy = computed(() => ['opening', 'pausing', 'resuming', 'closing'].includes(props.phase))
</script>

<template>
  <div class="shift-status-control">
    <AppStatusChip :variant="chipVariant">{{ phaseLabel }}</AppStatusChip>
    <div class="shift-status-control__actions">
      <AppButton
        v-if="phase === 'closed'"
        variant="primary"
        :loading="isBusy"
        @click="emit('open')"
      >
        {{ openLabel }}
      </AppButton>
      <template v-else-if="phase === 'open'">
        <AppButton variant="ghost" :loading="isBusy" @click="emit('pause')">
          {{ pauseLabel }}
        </AppButton>
        <AppButton variant="secondary" :loading="isBusy" @click="emit('close')">
          {{ closeLabel }}
        </AppButton>
      </template>
      <AppButton
        v-else-if="phase === 'paused'"
        variant="primary"
        :loading="isBusy"
        @click="emit('resume')"
      >
        {{ resumeLabel }}
      </AppButton>
    </div>
  </div>
</template>

<style scoped>
.shift-status-control {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.shift-status-control__actions {
  display: flex;
  gap: var(--space-2);
}
</style>
