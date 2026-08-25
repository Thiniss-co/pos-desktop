import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { ActivationInput } from '@shared/contracts/activation.contract'
import type { PublicAppError } from '@shared/contracts/api.contract'
import { createLocalizedErrorRef } from '@renderer/shared/utils/localizedErrorRef'
import type { DeviceDisplayState } from './types'
import { DeviceService } from './service'

function isPublicAppError(value: unknown): value is PublicAppError {
  return typeof value === 'object' && value !== null && 'message' in value && 'category' in value
}

export const useDeviceStore = defineStore('device', () => {
  const summary = ref<DeviceDisplayState>(null)
  const errorState = createLocalizedErrorRef()
  const error = errorState.error
  const fieldErrors = ref<Record<string, string[]> | null>(null)
  const isSubmitting = ref(false)

  async function load(service = new DeviceService()): Promise<void> {
    try {
      summary.value = await service.getIdentitySummary()
      errorState.clear()
    } catch {
      errorState.setFallbackKey('activation.deviceInfoUnavailable')
    }
  }

  async function activate(input: ActivationInput, service = new DeviceService()): Promise<boolean> {
    if (isSubmitting.value) {
      return false
    }
    isSubmitting.value = true
    errorState.clear()
    fieldErrors.value = null

    try {
      await service.register(input)
      await load(service)
      return true
    } catch (cause) {
      console.error('Device activation failed', cause)
      if (isPublicAppError(cause)) {
        errorState.setDetail(cause)
        fieldErrors.value = cause.fieldErrors ?? null
      } else {
        errorState.setFallbackKey('activation.activationFailed')
      }
      return false
    } finally {
      isSubmitting.value = false
    }
  }

  function setDeviceRecoveryMessage(): void {
    fieldErrors.value = null
    errorState.setFallbackKey('activation.deviceRecoveryRequired')
  }

  return { summary, error, fieldErrors, isSubmitting, load, activate, setDeviceRecoveryMessage }
})
