import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { LoginInput } from '@shared/contracts/auth.contract'
import { handleSessionTransition } from '@renderer/app/session/sessionTransition'
import { parsePublicAppError } from '@renderer/shared/utils/parsePublicAppError'
import type { AuthDisplayState } from './types'
import { AuthService } from './service'

export const useAuthStore = defineStore('auth', () => {
  const session = ref<AuthDisplayState>(null)
  const error = ref<string | null>(null)
  const fieldErrors = ref<Record<string, string[]> | null>(null)
  const isSubmitting = ref(false)

  async function load(service = new AuthService()): Promise<void> {
    try {
      session.value = await service.getSessionSummary()
      error.value = null
    } catch (cause) {
      void handleSessionTransition(cause)
      error.value = parsePublicAppError(cause)?.message ?? 'Session information is unavailable'
    }
  }

  async function login(input: LoginInput, service = new AuthService()): Promise<boolean> {
    if (isSubmitting.value) {
      return false
    }

    isSubmitting.value = true
    error.value = null
    fieldErrors.value = null

    try {
      session.value = await service.login(input)
      return true
    } catch (cause) {
      void handleSessionTransition(cause)
      const publicError = parsePublicAppError(cause)

      if (publicError) {
        error.value = publicError.message
        fieldErrors.value = publicError.fieldErrors ?? null
      } else {
        error.value = 'Sign in failed'
      }
      return false
    } finally {
      isSubmitting.value = false
    }
  }

  function setSessionEndedMessage(message: string): void {
    fieldErrors.value = null
    error.value = message
  }

  return { session, error, fieldErrors, isSubmitting, load, login, setSessionEndedMessage }
})
