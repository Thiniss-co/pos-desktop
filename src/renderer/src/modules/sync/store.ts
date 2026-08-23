import { ref } from 'vue'
import { defineStore } from 'pinia'
import { handleSessionTransition } from '@renderer/app/session/sessionTransition'
import { publicAppErrorSchema } from '@shared/contracts/api.contract'
import { i18n } from '@renderer/i18n'
import { localizeAppError } from '@renderer/shared/utils/localizeAppError'
import type { SyncDisplayState } from './types'
import { SyncService } from './service'

export const useSyncStore = defineStore('sync', () => {
  const status = ref<SyncDisplayState>(null)
  const error = ref<string | null>(null)

  async function refresh(service = new SyncService()): Promise<void> {
    try {
      status.value = await service.getStatus()
      error.value = null
    } catch (cause) {
      void handleSessionTransition(cause)
      const parsed = publicAppErrorSchema.safeParse(cause)
      error.value = parsed.success
        ? localizeAppError(parsed.data, i18n.global.t, i18n.global.te)
        : String(i18n.global.t('sync.statusUnavailable'))
    }
  }

  return { status, error, refresh }
})
