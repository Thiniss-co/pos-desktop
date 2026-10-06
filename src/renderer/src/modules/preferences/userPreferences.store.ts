import { ref, watch } from 'vue'
import { defineStore, type Pinia } from 'pinia'
import type { UserPreferenceKey, UserPreferences } from '@shared/contracts/preferences.contract'
import { useAuthStore } from '../auth/store'
import { PreferencesService } from './service'

const DEFAULTS: UserPreferences = { touchMode: false, autoPrint: true }

/** Applies the touch layout to the document root: `data-touch="on"` drives every touch rule. */
export function applyTouchModeToDocument(touchMode: boolean): void {
  if (typeof document === 'undefined') {
    return
  }
  if (touchMode) {
    document.documentElement.dataset.touch = 'on'
  } else {
    delete document.documentElement.dataset.touch
  }
}

/**
 * POS improvements, Stage 5: the signed-in user's own preferences on this workstation (touch
 * layout; automatic printing, used by Stage 7). Main owns the identity and the storage; this store
 * only mirrors the current user's values and asks main to change them.
 */
export const useUserPreferencesStore = defineStore('userPreferences', () => {
  const service = new PreferencesService()
  const preferences = ref<UserPreferences>(DEFAULTS)
  const saving = ref(false)
  const failed = ref(false)
  // Only the newest request may apply: a slow answer for the previous user (or an older write) must
  // never overwrite the current user's touch layout, which also drives the workspace density.
  let generation = 0

  function apply(next: UserPreferences): void {
    preferences.value = next
    applyTouchModeToDocument(next.touchMode)
  }

  async function load(): Promise<void> {
    const request = ++generation
    try {
      const next = await service.getUserPreferences()
      if (request === generation) {
        apply(next)
      }
    } catch {
      if (request === generation) {
        apply(DEFAULTS)
      }
    }
  }

  async function set(key: UserPreferenceKey, value: boolean): Promise<void> {
    const request = ++generation
    saving.value = true
    failed.value = false
    try {
      const next = await service.setUserPreference(key, value)
      if (request === generation) {
        apply(next)
      }
    } catch {
      if (request === generation) {
        failed.value = true
      }
    } finally {
      if (request === generation) {
        saving.value = false
      }
    }
  }

  function reset(): void {
    generation += 1
    saving.value = false
    apply(DEFAULTS)
  }

  return { preferences, saving, failed, load, set, reset }
})

/** Reloads on every sign-in and sign-out, so each cashier gets their own layout. */
export function startUserPreferencesClient(pinia: Pinia): void {
  if (typeof window === 'undefined' || !window.posApi?.preferences?.getUser) {
    return
  }
  const store = useUserPreferencesStore(pinia)
  const auth = useAuthStore(pinia)
  watch(
    () => (auth.session?.isAuthenticated ? `in:${auth.session.userEmail ?? ''}` : 'out'),
    (identity) => {
      if (identity === 'out') {
        store.reset()
      } else {
        void store.load()
      }
    },
    { immediate: true }
  )
}
