<script setup lang="ts">
import AppBanner from '@renderer/shared/components/feedback/AppBanner.vue'
import AppButton from '@renderer/shared/components/common/AppButton.vue'

/**
 * The "refresh workstation data" action that sits beside the stale-catalog warning.
 *
 * Pure presentation: every string is already localized and every timestamp already formatted by
 * the parent page. This component performs no IPC, reads no store, and decides nothing about the
 * cart — it renders one state and emits one intent.
 *
 * The four states are mutually exclusive and each is rendered explicitly rather than inferred
 * from the absence of the others, so a cashier is never left looking at a warning with no
 * indication of what the app is doing:
 *
 *   pending  — the refresh is running; the button is disabled and labelled as in progress
 *   error    — the refresh failed, with an actionable message and the button still available
 *   stale    — the catalog is stale and a refresh is offered
 *   success  — the last refresh succeeded, showing when the data was refreshed
 */
withDefaults(
  defineProps<{
    /** True while a refresh is in flight. Disables the control so a second request cannot start. */
    pending: boolean
    /** True when the cached catalog is stale and a refresh is the resolution. */
    stale: boolean
    staleMessage: string
    refreshLabel: string
    pendingLabel: string
    /** Localized, already-formatted "last refreshed" line; null before any refresh succeeded. */
    lastRefreshedLabel?: string | null
    /** Localized failure message from the last refresh attempt, if it failed. */
    errorMessage?: string | null
    /** Shown when a successful refresh moved the catalog revision under an open cart. */
    revisionChangedMessage?: string | null
  }>(),
  {
    lastRefreshedLabel: null,
    errorMessage: null,
    revisionChangedMessage: null
  }
)

const emit = defineEmits<{ refresh: [] }>()
</script>

<template>
  <div
    v-if="stale || pending || errorMessage || lastRefreshedLabel"
    class="catalog-refresh-panel"
    data-testid="catalog-refresh-panel"
  >
    <AppBanner v-if="errorMessage" variant="error" role="alert" data-testid="catalog-refresh-error">
      {{ errorMessage }}
      <template #action>
        <AppButton variant="secondary" :disabled="pending" @click="emit('refresh')">
          {{ pending ? pendingLabel : refreshLabel }}
        </AppButton>
      </template>
    </AppBanner>

    <AppBanner v-else-if="stale" variant="warning" role="alert">
      {{ staleMessage }}
      <template #action>
        <AppButton
          variant="secondary"
          :disabled="pending"
          data-testid="catalog-refresh-action"
          @click="emit('refresh')"
        >
          {{ pending ? pendingLabel : refreshLabel }}
        </AppButton>
      </template>
    </AppBanner>

    <AppBanner
      v-else-if="pending"
      variant="info"
      role="status"
      data-testid="catalog-refresh-pending"
    >
      {{ pendingLabel }}
    </AppBanner>

    <AppBanner
      v-else-if="lastRefreshedLabel"
      variant="success"
      role="status"
      data-testid="catalog-refresh-success"
    >
      {{ lastRefreshedLabel }}
    </AppBanner>

    <AppBanner
      v-if="revisionChangedMessage"
      variant="warning"
      role="alert"
      data-testid="catalog-refresh-revision-changed"
    >
      {{ revisionChangedMessage }}
    </AppBanner>
  </div>
</template>

<style scoped>
.catalog-refresh-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-block-end: var(--space-3);
}
</style>
