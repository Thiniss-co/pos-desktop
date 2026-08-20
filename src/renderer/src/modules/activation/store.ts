import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { ActivationInput } from '@shared/contracts/activation.contract'
import type { PublicAppError } from '@shared/contracts/api.contract'
import type { DeviceDisplayState } from './types'
import { DeviceService } from './service'

function isPublicAppError(value: unknown): value is PublicAppError {
  return typeof value === 'object' && value !== null && 'message' in value && 'category' in value
}

export const useDeviceStore = defineStore('device', () => {
  const summary = ref<DeviceDisplayState>(null)
  const error = ref<string | null>(null)
  const fieldErrors = ref<Record<string, string[]> | null>(null)
  const isSubmitting = ref(false)

  async function load(service = new DeviceService()): Promise<void> {
    try {
      summary.value = await service.getIdentitySummary()
      error.value = null
    } catch {
      error.value = 'Device information is unavailable'
    }
  }

  async function activate(input: ActivationInput, service = new DeviceService()): Promise<boolean> {
    if (isSubmitting.value) {
      return false
    }
    isSubmitting.value = true
    error.value = null
    fieldErrors.value = null

    try {
      await service.register(input)
      await load(service)
      return true
    } catch (cause) {
      console.error('Device activation failed', cause)
      if (isPublicAppError(cause)) {
        error.value = cause.message
        fieldErrors.value = cause.fieldErrors ?? null
      } else {
        error.value = 'Device activation failed'
      }
      return false
    } finally {
      isSubmitting.value = false
    }
  }

  return { summary, error, fieldErrors, isSubmitting, load, activate }
})
