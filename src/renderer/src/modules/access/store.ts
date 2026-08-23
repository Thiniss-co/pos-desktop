import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { PublicAppError } from '@shared/contracts/api.contract'
import { i18n } from '@renderer/i18n'
import { localizeAppError } from '@renderer/shared/utils/localizeAppError'
import type { AccessDisplayState } from './types'

const defaultState: AccessDisplayState = {
  category: 'authorization',
  message: String(i18n.global.t('access.defaultMessage')),
  traceId: null
}

export const useAccessStore = defineStore('access', () => {
  const state = ref<AccessDisplayState>(defaultState)

  function setFromError(error?: PublicAppError): void {
    state.value = error
      ? {
          category: error.category,
          message: localizeAppError(error, i18n.global.t, i18n.global.te),
          traceId: error.traceId ?? null
        }
      : defaultState
  }

  return { state, setFromError }
})
