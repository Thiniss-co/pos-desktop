<script setup lang="ts">
import AppBanner from '@renderer/shared/components/feedback/AppBanner.vue'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import type { IconName } from '@renderer/shared/components/common/icons.generated'

/**
 * The "refresh workstation data" action and its catalog status line (V3 `catLine`).
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
 * The notices below the status line are additional, mutually exclusive context, shown in priority
 * order — never more than one of these four at a time:
 *
 *   error    — the last refresh failed, with an actionable message
 *   stale    — the cached catalog is stale and a refresh is the resolution
 *   pending  — a refresh is running right now
 *   success  — the last refresh succeeded, showing when the data was refreshed
 *
 * and, independently, a revision-changed notice when a successful refresh moved the catalog
 * revision out from under an open cart (with an optional "Review and rebuild" action slot).
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
    /** The catalog status line, e.g. "Catalog up to date · updated 4 min ago". */
    statusLabel?: string | null
    statusTone?: 'ok' | 'muted' | 'info' | 'warn'
    /** Explains what refreshing does (tooltip on the action). */
    refreshNote?: string
    dismissLabel?: string
  }>(),
  {
    lastRefreshedLabel: null,
    errorMessage: null,
    revisionChangedMessage: null,
    statusLabel: null,
    statusTone: 'muted',
    refreshNote: undefined,
    dismissLabel: undefined
  }
)

const emit = defineEmits<{ refresh: [] }>()

const STATUS_ICON: Record<'ok' | 'muted' | 'info' | 'warn', IconName> = {
  ok: 'check_circle',
  muted: 'inventory',
  info: 'sync',
  warn: 'history'
}
const STATUS_TEXT = { ok: 'text-ok', muted: 'text-muted', info: 'text-info', warn: 'text-warn' }
</script>

<template>
  <div
    class="catalog-refresh-panel flex flex-none flex-col gap-2.5"
    data-testid="catalog-refresh-panel"
  >
    <div class="flex min-h-8 flex-wrap items-center gap-2 text-xs text-muted">
      <template v-if="statusLabel">
        <AppIcon :name="STATUS_ICON[statusTone]" :size="18" :class="STATUS_TEXT[statusTone]" />
        <span class="numeric">{{ statusLabel }}</span>
      </template>
      <div class="flex-1" />
      <!--
        Exactly one action, unconditionally: it is never nested inside a notice, so no state can
        duplicate or hide it. Disabled while `pending` so a click cannot dispatch a second
        refresh; the label itself communicates progress.
      -->
      <AppButton
        variant="ghost"
        size="sm"
        icon="refresh"
        class="text-pri-text"
        :title="refreshNote"
        :disabled="pending"
        data-testid="catalog-refresh-action"
        @click="emit('refresh')"
      >
        {{ pending ? pendingLabel : refreshLabel }}
      </AppButton>
    </div>

    <AppBanner v-if="errorMessage" variant="error" role="alert" data-testid="catalog-refresh-error">
      {{ errorMessage }}
    </AppBanner>

    <AppBanner v-else-if="stale" variant="warning" icon="history" role="alert">
      {{ staleMessage }}
    </AppBanner>

    <AppBanner
      v-else-if="pending"
      variant="info"
      icon="sync"
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
      icon="published_with_changes"
      role="alert"
      data-testid="catalog-refresh-revision-changed"
    >
      {{ revisionChangedMessage }}
      <template v-if="$slots['revision-action']" #action><slot name="revision-action" /></template>
    </AppBanner>
  </div>
</template>
