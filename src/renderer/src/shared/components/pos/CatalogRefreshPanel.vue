<script setup lang="ts">
import AppBanner from '@renderer/shared/components/feedback/AppBanner.vue'
import AppButton from '@renderer/shared/components/common/AppButton.vue'

/**
 * The "refresh workstation data" action that sits in the POS toolbar.
 *
 * Pure presentation: every string is already localized and every timestamp already formatted by
 * the parent page. This component performs no IPC, reads no store, and decides nothing about the
 * cart — it renders the current state and emits one intent.
 *
 * The refresh action is ALWAYS rendered, in every state. A locally "fresh" catalog only means this
 * workstation's last known snapshot looked current when it was fetched — the server can gain new
 * products at any time, and a cashier must always be able to force a resync to check, not only
 * when something already looks wrong. Hiding the action whenever nothing looked wrong is the exact
 * defect this component exists to not repeat (a valid-but-outdated catalog was previously
 * unrefreshable because none of `stale`/`pending`/`errorMessage`/`lastRefreshedLabel` were set).
 *
 * The banners above the action are additional, mutually exclusive context, shown in priority
 * order — never more than one of these four at a time:
 *
 *   error    — the last refresh failed, with an actionable message
 *   stale    — the cached catalog is stale and a refresh is the resolution
 *   pending  — a refresh is running right now
 *   success  — the last refresh succeeded, showing when the data was refreshed
 *
 * and, independently, a revision-changed notice when a successful refresh moved the catalog
 * revision out from under an open cart.
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
  <div class="catalog-refresh-panel" data-testid="catalog-refresh-panel">
    <AppBanner v-if="errorMessage" variant="error" role="alert" data-testid="catalog-refresh-error">
      {{ errorMessage }}
    </AppBanner>

    <AppBanner v-else-if="stale" variant="warning" role="alert">
      {{ staleMessage }}
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

    <!--
      Exactly one action, unconditionally: it is never nested inside a banner's action slot, so no
      state can duplicate or hide it. Disabled while `pending` so a click cannot dispatch a second
      refresh; the label itself communicates progress.
    -->
    <AppButton
      variant="secondary"
      :disabled="pending"
      data-testid="catalog-refresh-action"
      @click="emit('refresh')"
    >
      {{ pending ? pendingLabel : refreshLabel }}
    </AppButton>
  </div>
</template>

<style scoped>
.catalog-refresh-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-block-end: var(--space-3);
}

/* Compact and inline, like every other secondary action in this toolbar — not a full-width block. */
.catalog-refresh-panel :deep(.app-button) {
  align-self: flex-start;
}
</style>
