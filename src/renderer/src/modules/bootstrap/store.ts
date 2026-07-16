import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { BootstrapDisplayState } from './types'
import { BootstrapService } from './service'

export const useBootstrapStore = defineStore('bootstrap', () => {
  const status = ref<BootstrapDisplayState>(null)
  const error = ref<string | null>(null)

  async function load(service = new BootstrapService()): Promise<void> {
    try {
      status.value = await service.getStatus()
      error.value = null
    } catch {
      error.value = 'Bootstrap status is unavailable'
    }
  }

  return { status, error, load }
})
