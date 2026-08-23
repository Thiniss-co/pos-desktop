import { ref } from 'vue'
import { defineStore } from 'pinia'
import { LicenseService } from '@renderer/modules/license/service'
import { handleSessionTransition } from '@renderer/app/session/sessionTransition'
import { parsePublicAppError } from '@renderer/shared/utils/parsePublicAppError'
import { createLocalizedErrorRef } from '@renderer/shared/utils/localizedErrorRef'
import type { BootstrapDisplayState, BootstrapStage } from './types'
import { BootstrapService } from './service'

export const useBootstrapStore = defineStore('bootstrap', () => {
  const status = ref<BootstrapDisplayState>(null)
  const errorState = createLocalizedErrorRef()
  const error = errorState.error
  const stage = ref<BootstrapStage>('idle')
  const isRetryable = ref(false)
  const isRunning = ref(false)

  async function load(service = new BootstrapService()): Promise<void> {
    try {
      status.value = await service.getStatus()
      errorState.clear()
    } catch {
      errorState.setFallbackKey('bootstrap.statusUnavailable')
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
    errorState.clear()
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
      void handleSessionTransition(cause)
      const publicError = parsePublicAppError(cause)

      if (publicError) {
        errorState.setDetail(publicError)
        isRetryable.value = publicError.retryable
      } else {
        errorState.setFallbackKey('bootstrap.failed')
      }
      stage.value = 'idle'
      return false
    } finally {
      isRunning.value = false
    }
  }

  return { status, error, stage, isRetryable, isRunning, load, runBootstrap }
})
