import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { DeviceDisplayState } from './types'
import { DeviceService } from './service'

export const useDeviceStore = defineStore('device', () => {
  const summary = ref<DeviceDisplayState>(null)
  const error = ref<string | null>(null)

  async function load(service = new DeviceService()): Promise<void> {
    try {
      summary.value = await service.getIdentitySummary()
      error.value = null
    } catch {
      error.value = 'Device information is unavailable'
    }
  }

  return { summary, error, load }
})
