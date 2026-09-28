import { computed, type ComputedRef } from 'vue'
import { useI18n } from 'vue-i18n'
import type { IconName } from '@renderer/shared/components/common/icons.generated'
import type { PillTone } from '@renderer/shared/components/common/types'
import { useConnectivityStore } from '@renderer/modules/connectivity/store'
import { useSyncStore } from '@renderer/modules/sync/store'

export interface ShellPill {
  readonly tone: PillTone
  readonly icon: IconName
  readonly label: string
}

/**
 * Network and sync pills for the V3 top bar. Pure read-models over the connectivity and sync
 * stores — the shell never triggers an upload or a connectivity probe from here.
 */
export function useShellStatus(): {
  network: ComputedRef<ShellPill>
  syncPill: ComputedRef<ShellPill>
} {
  const { t } = useI18n()
  const connectivity = useConnectivityStore()
  const sync = useSyncStore()

  const network = computed<ShellPill>(() => {
    switch (connectivity.snapshot?.status) {
      case 'online':
        return { tone: 'ok', icon: 'wifi', label: t('shell.network.online') }
      case 'offline':
        return { tone: 'neutral', icon: 'wifi_off', label: t('shell.network.offline') }
      case 'backend_unreachable':
        return { tone: 'warn', icon: 'cloud_off', label: t('shell.network.unreachable') }
      default:
        return { tone: 'info', icon: 'sync', label: t('shell.network.checking') }
    }
  })

  // Order follows the prototype: paused first (it explains why nothing moves), then what is
  // waiting, then what needs review, then "all uploaded".
  const syncPill = computed<ShellPill>(() => {
    if (sync.status === null) {
      return sync.error
        ? { tone: 'neutral', icon: 'sync_problem', label: t('shell.sync.unavailable') }
        : { tone: 'neutral', icon: 'sync', label: t('shell.sync.loading') }
    }
    if (sync.isPaused) {
      return {
        tone: 'warn',
        icon: 'pause_circle',
        label: t('shell.sync.paused', { count: sync.queuedCount })
      }
    }
    if (sync.queuedCount > 0) {
      return {
        tone: 'info',
        icon: 'cloud_upload',
        label: t('shell.sync.queued', { count: sync.queuedCount })
      }
    }
    if (sync.failedCount > 0) {
      return {
        tone: 'err',
        icon: 'error',
        label: t('shell.sync.review', { count: sync.failedCount })
      }
    }
    return { tone: 'ok', icon: 'cloud_done', label: t('shell.sync.ok') }
  })

  return { network, syncPill }
}
