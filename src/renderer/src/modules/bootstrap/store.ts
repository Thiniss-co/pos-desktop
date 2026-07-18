import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { PublicAppError } from '@shared/contracts/api.contract'
import { LicenseService } from '@renderer/modules/license/service'
import type { BootstrapDisplayState, BootstrapStage } from './types'
import { BootstrapService } from './service'

function isPublicAppError(value: unknown): value is PublicAppError {
  return typeof value === 'object' && value !== null && 'message' in value && 'category' in value
}

export const useBootstrapStore = defineStore('bootstrap', () => {
  const status = ref<BootstrapDisplayState>(null)
  const error = ref<string | null>(null)
  const stage = ref<BootstrapStage>('idle')
  const isRetryable = ref(false)
  const isRunning = ref(false)

  async function load(service = new BootstrapService()): Promise<void> {
    try {
      status.value = await service.getStatus()
      error.value = null
    } catch {
      error.value = 'Bootstrap status is unavailable'
    }
  }

  async function runBootstrap(
    licenseService = new LicenseService(),
    bootstrapService = new BootstrapService()
  ): Promise<boolean> {
    if (isRunning.value) {
      return false
    }

    isRunning.value = true
    error.value = null
    isRetryable.value = false

    try {
      stage.value = 'validating_access'
      await licenseService.validate()

      stage.value = 'downloading'
      const result = await bootstrapService.refresh()

      status.value = { isComplete: result.isComplete, updatedAt: result.fetchedAt }
      stage.value = 'complete'
      return true
    } catch (cause) {
      if (isPublicAppError(cause)) {
        error.value = cause.message
        isRetryable.value = cause.retryable
      } else {
        error.value = 'Bootstrap could not be completed'
      }
      stage.value = 'idle'
      return false
    } finally {
      isRunning.value = false
    }
  }

  return { status, error, stage, isRetryable, isRunning, load, runBootstrap }
})
