import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { ActivationInput } from '@shared/contracts/activation.contract'
import type { PublicAppError } from '@shared/contracts/api.contract'
import { i18n } from '@renderer/i18n'
import { localizeAppError } from '@renderer/shared/utils/localizeAppError'
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
      error.value = String(i18n.global.t('activation.deviceInfoUnavailable'))
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
        error.value = localizeAppError(cause, i18n.global.t, i18n.global.te)
        fieldErrors.value = cause.fieldErrors ?? null
      } else {
        error.value = String(i18n.global.t('activation.activationFailed'))
      }
      return false
    } finally {
      isSubmitting.value = false
    }
  }

  return { summary, error, fieldErrors, isSubmitting, load, activate }
})
