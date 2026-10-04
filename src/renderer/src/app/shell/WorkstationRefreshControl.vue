<script setup lang="ts">
/**
 * Rev 4 §13 — the global "Refresh workstation" control (top bar, and a compact drawer variant).
 *
 * One tap refreshes the license, authority and catalog. With a sale in progress the cashier is asked
 * first (consent is bound to that exact draft); a claimed payment is never superseded — the
 * refresh is refused with a clear message instead. The outcome is announced politely.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppConfirmDialog from '@renderer/shared/components/common/AppConfirmDialog.vue'
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import AppSpinner from '@renderer/shared/components/common/AppSpinner.vue'
import { formatRelativeDateTime } from '@renderer/shared/utils/format'
import { useWorkstationRefreshStore } from '@renderer/modules/catalogInstall/workstationRefresh.store'
import { installHoldActive } from '@renderer/modules/catalogInstall/installHold'
import { useLocaleStore } from '@renderer/modules/preferences/locale.store'
import { useCatalogStore } from '@renderer/modules/pos/catalog.store'
import type { LocaleCode } from '@shared/contracts/preferences.contract'

withDefaults(defineProps<{ compact?: boolean }>(), { compact: false })

const { t } = useI18n()
const refresh = useWorkstationRefreshStore()
const catalog = useCatalogStore()
const locale = useLocaleStore()
const now = ref(Date.now())
let ticker: number | undefined
let releaseCatalogChanges: (() => void) | null = null

onMounted(() => {
  ticker = window.setInterval(() => (now.value = Date.now()), 30_000)
  // The header consumes catalog change hints on every page, not only while the POS is mounted.
  if (window.posApi?.catalog) {
    releaseCatalogChanges = catalog.subscribeToChanges()
  }
})
onBeforeUnmount(() => {
  window.clearInterval(ticker)
  releaseCatalogChanges?.()
})

const pending = computed(() => refresh.status === 'pending')
const updating = computed(() => installHoldActive.value && !pending.value)
const lastRefreshedLabel = computed(() => {
  const at = refresh.lastRefreshedAt ?? catalog.status?.lastSyncedAt ?? null
  return at
    ? t('shell.workstationRefresh.lastRefreshed', {
        time: formatRelativeDateTime(at, locale.locale as LocaleCode, now.value)
      })
    : t('shell.workstationRefresh.never')
})
const label = computed(() =>
  pending.value
    ? t('shell.workstationRefresh.pending')
    : updating.value
      ? t('shell.workstationRefresh.updating')
      : t('shell.workstationRefresh.action')
)
const message = computed(() =>
  refresh.lastMessage ? t(`shell.workstationRefresh.result.${refresh.lastMessage}`) : ''
)
const messageTone = computed(() => (refresh.lastMessage === 'installed' ? 'text-ok' : 'text-warn'))
</script>

<template>
  <div class="workstation-refresh flex min-w-0 items-center gap-2">
    <button
      type="button"
      class="workstation-refresh__button flex h-8 flex-none items-center gap-1.5 rounded-full border border-line bg-surf px-3 text-xs font-semibold whitespace-nowrap text-ink hover:bg-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pri disabled:cursor-progress disabled:opacity-70"
      :disabled="pending || updating"
      :aria-busy="pending || updating"
      :title="`${label} — ${lastRefreshedLabel}`"
      data-testid="workstation-refresh"
      @click="refresh.request()"
    >
      <AppSpinner v-if="pending || updating" :size="16" />
      <AppIcon v-else name="sync" :size="18" />
      <span :class="compact ? '' : 'hidden pills:inline'">{{ label }}</span>
      <span class="sr-only">{{ lastRefreshedLabel }}</span>
    </button>
    <span
      v-if="compact"
      class="workstation-refresh__last text-xs text-muted [overflow-wrap:anywhere]"
      >{{ lastRefreshedLabel }}</span
    >
    <span
      class="workstation-refresh__message text-xs font-semibold"
      :class="[messageTone, compact ? '' : 'sr-only']"
      role="status"
      aria-live="polite"
      >{{ message }}</span
    >
    <AppConfirmDialog
      v-if="!compact"
      :open="refresh.status === 'confirming'"
      :title="t('shell.workstationRefresh.consentTitle')"
      :message="t('shell.workstationRefresh.consentBody')"
      :confirm-label="t('shell.workstationRefresh.consentConfirm')"
      :cancel-label="t('common.cancel')"
      variant="primary"
      @confirm="refresh.confirm()"
      @cancel="refresh.cancel()"
    />
  </div>
</template>
