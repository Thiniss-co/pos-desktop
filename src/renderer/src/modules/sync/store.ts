import { ref } from 'vue'
import { defineStore } from 'pinia'
import { handleSessionTransition } from '@renderer/app/session/sessionTransition'
import { publicAppErrorSchema } from '@shared/contracts/api.contract'
import { createLocalizedErrorRef } from '@renderer/shared/utils/localizedErrorRef'
import type { SyncDisplayState } from './types'
import { SyncService } from './service'

export const useSyncStore = defineStore('sync', () => {
  const status = ref<SyncDisplayState>(null)
  const errorState = createLocalizedErrorRef()
  const error = errorState.error

  async function refresh(service = new SyncService()): Promise<void> {
    try {
      status.value = await service.getStatus()
      errorState.clear()
    } catch (cause) {
      void handleSessionTransition(cause)
      const parsed = publicAppErrorSchema.safeParse(cause)

      if (parsed.success) {
        errorState.setDetail(parsed.data)
      } else {
        errorState.setFallbackKey('sync.statusUnavailable')
      }
    }
  }

  return { status, error, refresh }
})
