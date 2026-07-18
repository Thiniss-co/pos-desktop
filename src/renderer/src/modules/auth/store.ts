import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { PublicAppError } from '@shared/contracts/api.contract'
import type { LoginInput } from '@shared/contracts/auth.contract'
import type { AuthDisplayState } from './types'
import { AuthService } from './service'

function isPublicAppError(value: unknown): value is PublicAppError {
  return typeof value === 'object' && value !== null && 'message' in value && 'category' in value
}

export const useAuthStore = defineStore('auth', () => {
  const session = ref<AuthDisplayState>(null)
  const error = ref<string | null>(null)
  const fieldErrors = ref<Record<string, string[]> | null>(null)
  const isSubmitting = ref(false)

  async function load(service = new AuthService()): Promise<void> {
    try {
      session.value = await service.getSessionSummary()
      error.value = null
    } catch {
      error.value = 'Session information is unavailable'
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
      if (isPublicAppError(cause)) {
        error.value = cause.message
        fieldErrors.value = cause.fieldErrors ?? null
      } else {
        error.value = 'Sign in failed'
      }
      return false
    } finally {
      isSubmitting.value = false
    }
  }

  return { session, error, fieldErrors, isSubmitting, load, login }
})
