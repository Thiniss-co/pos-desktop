<script setup lang="ts">
import { ref, watch } from 'vue'
import AppBanner from '@renderer/shared/components/feedback/AppBanner.vue'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import type { DisplayRecoveryResult } from './types'

/**
 * Pure presentation (Phase 3F CP-4): every value here is already computed and formatted upstream.
 * Renders nothing when there is nothing to recover — the parent page still decides whether to
 * mount this component at all. Every emit carries the exact `attemptKey` it applies to; this
 * component never guesses which attempt a click on one row should resolve.
 */
const props = withDefaults(
  defineProps<{
    blockingAttemptKey: string | null
    blockedMessage: string
    retryLabel: string
    abandonLabel: string
    unacknowledgedResults: readonly DisplayRecoveryResult[]
    unacknowledgedMessage: string
    acknowledgeLabel: string
    abandonWarning: string
    confirmAbandonLabel: string
    cancelConfirmLabel: string
  }>(),
  {}
)

const emit = defineEmits<{
  retry: [attemptKey: string]
  abandon: [attemptKey: string]
  acknowledge: [attemptKey: string]
}>()

/** Plan §1.9: abandoning requires explicit confirmation and the tender warning, every time. */
const confirmingAbandon = ref(false)

watch(
  () => props.blockingAttemptKey,
  () => {
    confirmingAbandon.value = false
  }
)

function confirmAbandon(): void {
  if (props.blockingAttemptKey) {
    confirmingAbandon.value = false
    emit('abandon', props.blockingAttemptKey)
  }
}
</script>

<template>
  <div
    v-if="blockingAttemptKey || unacknowledgedResults.length > 0"
    class="sale-recovery-banner"
    data-testid="sale-recovery-banner"
  >
    <AppBanner v-if="blockingAttemptKey" variant="warning" role="alert">
      {{ confirmingAbandon ? abandonWarning : blockedMessage }}
      <template #action>
        <div v-if="confirmingAbandon" class="sale-recovery-banner__actions">
          <AppButton variant="ghost" @click="confirmingAbandon = false">
            {{ cancelConfirmLabel }}
          </AppButton>
          <AppButton variant="danger" @click="confirmAbandon">{{ confirmAbandonLabel }}</AppButton>
        </div>
        <div v-else class="sale-recovery-banner__actions">
          <AppButton variant="ghost" @click="confirmingAbandon = true">
            {{ abandonLabel }}
          </AppButton>
          <AppButton variant="secondary" @click="emit('retry', blockingAttemptKey)">
            {{ retryLabel }}
          </AppButton>
        </div>
      </template>
    </AppBanner>

    <AppBanner
      v-for="result in unacknowledgedResults"
      :key="result.attemptKey"
      variant="success"
      role="status"
      class="sale-recovery-banner__result"
    >
      {{ unacknowledgedMessage }} — {{ result.committedAtLabel }}
      <template #action>
        <AppButton variant="secondary" @click="emit('acknowledge', result.attemptKey)">
          {{ acknowledgeLabel }}
        </AppButton>
      </template>
    </AppBanner>
  </div>
</template>

<style scoped>
.sale-recovery-banner {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-block-end: var(--space-4);
}

.sale-recovery-banner__result + .sale-recovery-banner__result {
  margin-block-start: var(--space-2);
}

.sale-recovery-banner__actions {
  display: flex;
  gap: var(--space-2);
}
</style>
