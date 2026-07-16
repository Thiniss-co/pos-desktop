import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { SyncDisplayState } from './types'
import { SyncService } from './service'

export const useSyncStore = defineStore('sync', () => {
  const status = ref<SyncDisplayState>(null)
  const error = ref<string | null>(null)

  async function refresh(service = new SyncService()): Promise<void> {
    try {
      status.value = await service.getStatus()
      error.value = null
    } catch {
      error.value = 'Sync status is unavailable'
    }
  }

  return { status, error, refresh }
})
