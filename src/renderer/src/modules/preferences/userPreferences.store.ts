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

  function apply(next: UserPreferences): void {
    preferences.value = next
    applyTouchModeToDocument(next.touchMode)
  }

  async function load(): Promise<void> {
    try {
      apply(await service.getUserPreferences())
    } catch {
      apply(DEFAULTS)
    }
  }

  async function set(key: UserPreferenceKey, value: boolean): Promise<void> {
    saving.value = true
    failed.value = false
    try {
      apply(await service.setUserPreference(key, value))
    } catch {
      failed.value = true
    } finally {
      saving.value = false
    }
  }

  function reset(): void {
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
