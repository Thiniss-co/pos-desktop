import { ref } from 'vue'
import { defineStore } from 'pinia'
import { LicenseService } from '@renderer/modules/license/service'
import { handleSessionTransition } from '@renderer/app/session/sessionTransition'
import { parsePublicAppError } from '@renderer/shared/utils/parsePublicAppError'
import { i18n } from '@renderer/i18n'
import { localizeAppError } from '@renderer/shared/utils/localizeAppError'
import type { BootstrapDisplayState, BootstrapStage } from './types'
import { BootstrapService } from './service'

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
      error.value = String(i18n.global.t('bootstrap.statusUnavailable'))
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
      void handleSessionTransition(cause)
      const publicError = parsePublicAppError(cause)

      if (publicError) {
        error.value = localizeAppError(publicError, i18n.global.t, i18n.global.te)
        isRetryable.value = publicError.retryable
      } else {
        error.value = String(i18n.global.t('bootstrap.failed'))
      }
      stage.value = 'idle'
      return false
    } finally {
      isRunning.value = false
    }
  }

  return { status, error, stage, isRetryable, isRunning, load, runBootstrap }
})
