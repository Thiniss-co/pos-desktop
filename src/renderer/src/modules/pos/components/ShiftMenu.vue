<script setup lang="ts">
/**
 * Top-bar shift pill + menu (V3 shell). Pill tone/label mirror the shift store; the menu offers
 * exactly the lifecycle actions the store supports for the current phase (the same matrix as
 * ShiftStatusControl), opening `ShiftDialogs` for open/pause/close and resuming directly.
 * Lifecycle changes are disabled while the workstation is offline or the service is unreachable —
 * the store would refuse them anyway — and "Refresh status" re-reads the authoritative shift.
 */
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import type { LocaleCode } from '@shared/contracts/preferences.contract'
import { formatMinorCurrency } from '@shared/money/minorUnits'
import { formatDateTime } from '@renderer/shared/utils/format'
import AppDropdown from '@renderer/shared/components/common/AppDropdown.vue'
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import AppMenuItem from '@renderer/shared/components/common/AppMenuItem.vue'
import type { IconName } from '@renderer/shared/components/common/icons.generated'
import {
  PILL_TONE_CLASS as TONE_CLASS,
  PILL_TONE_TEXT,
  type PillTone
} from '@renderer/shared/components/common/types'
import { useConnectivityStore } from '@renderer/modules/connectivity/store'
import { useLocaleStore } from '@renderer/modules/preferences/locale.store'
import { useCartStore } from '../cart.store'
import { useShiftStore } from '../shift.store'
import { useShiftDialogStore } from '../shiftDialog.store'

const { t } = useI18n()
const shift = useShiftStore()
const dialog = useShiftDialogStore()
const cart = useCartStore()
const connectivity = useConnectivityStore()
const localeStore = useLocaleStore()
const { currentShift, observedStatus, freshness, mutation } = storeToRefs(shift)
const open = ref(false)

const phase = computed(() => mutation.value ?? observedStatus.value ?? 'closed')
const connected = computed(() => {
  const status = connectivity.snapshot?.status
  return status !== 'offline' && status !== 'backend_unreachable'
})

const pill = computed<{ tone: PillTone; icon: IconName; label: string }>(() => {
  if (freshness.value === 'loading' && mutation.value === null) {
    return { tone: 'neutral', icon: 'schedule', label: t('shell.shift.loading') }
  }
  if (freshness.value === 'error') {
    return { tone: 'warn', icon: 'lock_clock', label: t('shell.shift.unavailable') }
  }
  if (freshness.value === 'unknown') {
    return { tone: 'warn', icon: 'help', label: t('shell.shift.unknown') }
  }
  switch (phase.value) {
    case 'opening':
    case 'pausing':
    case 'resuming':
    case 'closing':
      return { tone: 'info', icon: 'hourglass_top', label: t(`shell.shift.${phase.value}`) }
    case 'open': {
      const openedAt = currentShift.value?.openedAt
      const time = openedAt
        ? formatDateTime(openedAt, localeStore.locale as LocaleCode, { timeStyle: 'short' })
        : null
      return {
        tone: 'ok',
        icon: 'schedule',
        label: time ? t('shell.shift.open', { time }) : t('shell.shift.openNoTime')
      }
    }
    case 'paused':
      return { tone: 'warn', icon: 'pause_circle', label: t('shell.shift.paused') }
    default:
      return { tone: 'neutral', icon: 'lock_clock', label: t('shell.shift.none') }
  }
})

/** Lifecycle actions exist only on an authoritative (`current`) read with no request in flight. */
const lifecycleReady = computed(
  () => freshness.value === 'current' && mutation.value === null && connected.value
)
const needsRefresh = computed(() => ['error', 'unknown', 'cached'].includes(freshness.value))

const varianceLabel = computed(() => {
  const difference = currentShift.value?.cashDifferenceAmount
  if (currentShift.value?.status !== 'closed' || difference === null || difference === undefined) {
    return null
  }
  const formatted = formatMinorCurrency(
    Math.abs(difference),
    localeStore.locale as LocaleCode,
    cart.contract?.currency ?? 'EGP',
    cart.contract?.currencyExponent ?? 2
  )
  return formatted.ok ? `${difference < 0 ? '−' : ''}${formatted.value}` : null
})

function run(action: 'open' | 'pause' | 'close' | 'resume' | 'refresh', close: () => void): void {
  close()
  if (action === 'resume') {
    const uuid = shift.activeShiftUuid
    if (uuid) {
      void shift.resume({ uuid, resumeNotes: null })
    }
  } else if (action === 'refresh') {
    void shift.loadCurrent()
  } else {
    dialog.request(action)
  }
}
</script>

<template>
  <AppDropdown
    v-model:open="open"
    :label="t('shell.shift.menuLabel')"
    width="300px"
    :trigger-class="`app-pill flex h-8 items-center gap-1.5 rounded-full ps-3 pe-2.5 text-xs font-semibold whitespace-nowrap ${TONE_CLASS[pill.tone]}`"
  >
    <template #trigger>
      <AppIcon :name="pill.icon" :size="18" />
      <span class="hidden pills:inline">{{ pill.label }}</span>
      <span class="sr-only pills:hidden">{{ pill.label }}</span>
      <AppIcon name="expand_more" :size="18" />
    </template>
    <template #default="{ close }">
      <div class="mb-1.5 flex items-center gap-2 border-b border-line px-2.5 pt-2.5 pb-3">
        <AppIcon :name="pill.icon" :size="20" :class="PILL_TONE_TEXT[pill.tone]" />
        <span class="font-bold">{{ pill.label }}</span>
      </div>
      <p v-if="varianceLabel" class="numeric px-2.5 pb-2 text-sm text-muted">
        {{ t('pos.cashVariance') }}: {{ varianceLabel }}
      </p>
      <template v-if="freshness === 'current'">
        <AppMenuItem
          v-if="phase === 'closed' || phase === 'cancelled' || phase === 'opening'"
          icon="play_circle"
          :disabled="!lifecycleReady"
          @select="run('open', close)"
          >{{ t('pos.openShift') }}</AppMenuItem
        >
        <AppMenuItem
          v-if="phase === 'open' || phase === 'pausing'"
          icon="pause_circle"
          :disabled="!lifecycleReady"
          @select="run('pause', close)"
          >{{ t('pos.pauseShift') }}</AppMenuItem
        >
        <AppMenuItem
          v-if="phase === 'paused' || phase === 'resuming'"
          icon="play_circle"
          :disabled="!lifecycleReady"
          @select="run('resume', close)"
          >{{ t('pos.resumeShift') }}</AppMenuItem
        >
        <AppMenuItem
          v-if="phase === 'open' || phase === 'paused' || phase === 'closing'"
          icon="stop_circle"
          :disabled="!lifecycleReady"
          @select="run('close', close)"
          >{{ t('pos.closeShift') }}</AppMenuItem
        >
      </template>
      <AppMenuItem
        v-if="needsRefresh"
        icon="refresh"
        :disabled="freshness === 'loading'"
        @select="run('refresh', close)"
        >{{ t('shell.shift.refreshStatus') }}</AppMenuItem
      >
      <p
        v-if="!connected || freshness === 'cached'"
        class="flex items-center gap-2 p-2.5 text-xs text-muted"
      >
        <AppIcon name="wifi_off" :size="18" />{{ t('shell.shift.needsConnection') }}
      </p>
    </template>
  </AppDropdown>
</template>
