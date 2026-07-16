import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { AuthDisplayState } from './types'
import { AuthService } from './service'

export const useAuthStore = defineStore('auth', () => {
  const session = ref<AuthDisplayState>(null)
  const error = ref<string | null>(null)

  async function load(service = new AuthService()): Promise<void> {
    try {
      session.value = await service.getSessionSummary()
      error.value = null
    } catch {
      error.value = 'Session information is unavailable'
    }
  }

  return { session, error, load }
})
