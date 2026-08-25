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
    case 'cancelled':
      return 'neutral' as const
    default:
      return 'information' as const
  }
})

const isBusy = computed(() => ['opening', 'pausing', 'resuming', 'closing'].includes(props.phase))

const actionPhase = computed(() => {
  switch (props.phase) {
    case 'opening':
      return 'closed'
    case 'pausing':
    case 'closing':
      return 'open'
    case 'resuming':
      return 'paused'
    default:
      return props.phase
  }
})
</script>

<template>
  <div class="shift-status-control">
    <AppStatusChip :variant="chipVariant">{{ phaseLabel }}</AppStatusChip>
    <div class="shift-status-control__actions">
      <AppButton
        v-if="actionPhase === 'closed'"
        variant="primary"
        :loading="phase === 'opening'"
        :disabled="isBusy && phase !== 'opening'"
        @click="emit('open')"
      >
        {{ openLabel }}
      </AppButton>
      <template v-else-if="actionPhase === 'open'">
        <AppButton
          variant="ghost"
          :loading="phase === 'pausing'"
          :disabled="isBusy && phase !== 'pausing'"
          @click="emit('pause')"
        >
          {{ pauseLabel }}
        </AppButton>
        <AppButton
          variant="secondary"
          :loading="phase === 'closing'"
          :disabled="isBusy && phase !== 'closing'"
          @click="emit('close')"
        >
          {{ closeLabel }}
        </AppButton>
      </template>
      <template v-else-if="actionPhase === 'paused'">
        <AppButton
          variant="primary"
          :loading="phase === 'resuming'"
          :disabled="isBusy && phase !== 'resuming'"
          @click="emit('resume')"
        >
          {{ resumeLabel }}
        </AppButton>
        <AppButton
          variant="secondary"
          :loading="phase === 'closing'"
          :disabled="isBusy && phase !== 'closing'"
          @click="emit('close')"
        >
          {{ closeLabel }}
        </AppButton>
      </template>
      <template v-else-if="actionPhase === 'cancelled'">
        <!-- A cancelled shift is terminal: it deliberately has no lifecycle actions. -->
      </template>
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
