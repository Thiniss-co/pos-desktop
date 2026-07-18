import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { PublicAppError } from '@shared/contracts/api.contract'
import type { AccessDisplayState } from './types'

const defaultState: AccessDisplayState = {
  category: 'authorization',
  message: 'Desktop access is not available for this workstation.',
  traceId: null
}

export const useAccessStore = defineStore('access', () => {
  const state = ref<AccessDisplayState>(defaultState)

  function setFromError(error?: PublicAppError): void {
    state.value = error
      ? { category: error.category, message: error.message, traceId: error.traceId ?? null }
      : defaultState
  }

  return { state, setFromError }
})
