import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { LoginInput } from '@shared/contracts/auth.contract'
import { handleSessionTransition } from '@renderer/app/session/sessionTransition'
import { parsePublicAppError } from '@renderer/shared/utils/parsePublicAppError'
import { createLocalizedErrorRef } from '@renderer/shared/utils/localizedErrorRef'
import type { AuthDisplayState } from './types'
import { AuthService } from './service'

export const useAuthStore = defineStore('auth', () => {
  const session = ref<AuthDisplayState>(null)
  const errorState = createLocalizedErrorRef()
  const error = errorState.error
  const fieldErrors = ref<Record<string, string[]> | null>(null)
  const isSubmitting = ref(false)

  async function load(service = new AuthService()): Promise<void> {
    try {
      session.value = await service.getSessionSummary()
      errorState.clear()
    } catch (cause) {
      void handleSessionTransition(cause)
      const publicError = parsePublicAppError(cause)

      if (publicError) {
        errorState.setDetail(publicError)
      } else {
        errorState.setFallbackKey('auth.sessionUnavailable')
      }
    }
  }

  async function login(input: LoginInput, service = new AuthService()): Promise<boolean> {
    if (isSubmitting.value) {
      return false
    }

    isSubmitting.value = true
    errorState.clear()
    fieldErrors.value = null

    try {
      session.value = await service.login(input)
      return true
    } catch (cause) {
      void handleSessionTransition(cause)
      const publicError = parsePublicAppError(cause)

      if (publicError) {
        errorState.setDetail(publicError)
        fieldErrors.value = publicError.fieldErrors ?? null
      } else {
        errorState.setFallbackKey('auth.signInFailed')
      }
      return false
    } finally {
      isSubmitting.value = false
    }
  }

  async function logout(service = new AuthService()): Promise<void> {
    if (isSubmitting.value) {
      return
    }

    isSubmitting.value = true
    errorState.clear()
    fieldErrors.value = null

    try {
      await service.logout()
    } catch {
      // Main clears the local session before the logout request can fail (e.g. offline), so
      // the renderer treats logout as complete regardless of whether the API call succeeded.
    } finally {
      session.value = { isAuthenticated: false, userName: null, userEmail: null }
      isSubmitting.value = false
    }
  }

  function setSessionEndedMessage(message: string): void {
    fieldErrors.value = null
    errorState.setMessage(message)
  }

  return { session, error, fieldErrors, isSubmitting, load, login, logout, setSessionEndedMessage }
})
