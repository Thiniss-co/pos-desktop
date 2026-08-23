import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { LoginInput } from '@shared/contracts/auth.contract'
import { handleSessionTransition } from '@renderer/app/session/sessionTransition'
import { parsePublicAppError } from '@renderer/shared/utils/parsePublicAppError'
import { i18n } from '@renderer/i18n'
import { localizeAppError } from '@renderer/shared/utils/localizeAppError'
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
      const publicError = parsePublicAppError(cause)
      error.value = publicError
        ? localizeAppError(publicError, i18n.global.t, i18n.global.te)
        : String(i18n.global.t('auth.sessionUnavailable'))
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
        error.value = localizeAppError(publicError, i18n.global.t, i18n.global.te)
        fieldErrors.value = publicError.fieldErrors ?? null
      } else {
        error.value = String(i18n.global.t('auth.signInFailed'))
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
    error.value = null
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
    error.value = message
  }

  return { session, error, fieldErrors, isSubmitting, load, login, logout, setSessionEndedMessage }
})
