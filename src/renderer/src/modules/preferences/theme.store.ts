import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { ResolvedTheme, ThemePreference } from '@shared/contracts/preferences.contract'
import { PreferencesService } from './service'

const FALLBACK_THEME: ThemePreference = 'system'
const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)'

function prefersDarkColorScheme(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }
  return window.matchMedia(DARK_MEDIA_QUERY).matches
}

/** What `system` currently means, resolved against the OS preference right now. */
export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === 'system' ? (prefersDarkColorScheme() ? 'dark' : 'light') : preference
}

/**
 * Applies a theme preference to the document root.
 *
 * For an explicit `light`/`dark` choice this sets `data-theme` so the matching theme file's
 * unconditional selector wins outright. For `system` it deliberately *removes* `data-theme` and
 * sets `color-scheme: light dark` instead of resolving to a concrete value: `themes/dark.css`
 * carries a `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ... } }`
 * block that then owns the visual result entirely in CSS. That means `system` mode paints
 * correctly on first paint and follows OS changes with zero JavaScript and zero flash — no
 * pre-mount awaiting of a matchMedia read is needed for the *visual* half of this feature.
 */
export function applyThemeToDocument(preference: ThemePreference): void {
  if (typeof document === 'undefined') {
    return
  }

  const root = document.documentElement

  if (preference === 'system') {
    delete root.dataset.theme
    root.style.colorScheme = 'light dark'
  } else {
    root.dataset.theme = preference
    root.style.colorScheme = preference
  }
}

export async function resolveInitialTheme(
  service: Pick<PreferencesService, 'getTheme'>
): Promise<ThemePreference> {
  try {
    const storedTheme = await service.getTheme()

    if (storedTheme !== null) {
      return storedTheme
    }
  } catch {
    return FALLBACK_THEME
  }

  return FALLBACK_THEME
}

export const useThemeStore = defineStore('theme', () => {
  const preference = ref<ThemePreference>(FALLBACK_THEME)
  const resolvedTheme = ref<ResolvedTheme>('light')
  const isSaving = ref(false)
  const persistenceFailed = ref(false)
  let initialization: Promise<ThemePreference> | null = null
  // Mirrors locale.store.ts's latestRequestedLocale: only the call whose requested theme still
  // matches this value on resolution applies, so a slower earlier setTheme() can't clobber a
  // faster later one when the user switches rapidly.
  let latestRequestedTheme: ThemePreference | null = null
  let mediaQuery: MediaQueryList | null = null
  let mediaQueryListener: ((event: MediaQueryListEvent) => void) | null = null

  // The system listener exists only to keep `resolvedTheme` (a JS-visible ref for things like the
  // ThemeSwitcher's active-state display) accurate while in `system` mode. It never re-applies
  // anything to the document — the CSS media query in themes/dark.css already does that live.
  function stopWatchingSystemPreference(): void {
    if (mediaQuery && mediaQueryListener) {
      mediaQuery.removeEventListener('change', mediaQueryListener)
    }
    mediaQuery = null
    mediaQueryListener = null
  }

  function startWatchingSystemPreference(): void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function' || mediaQuery) {
      return
    }

    mediaQuery = window.matchMedia(DARK_MEDIA_QUERY)
    mediaQueryListener = (event) => {
      resolvedTheme.value = event.matches ? 'dark' : 'light'
    }
    mediaQuery.addEventListener('change', mediaQueryListener)
  }

  function syncSystemWatcher(nextPreference: ThemePreference): void {
    if (nextPreference === 'system') {
      startWatchingSystemPreference()
    } else {
      stopWatchingSystemPreference()
    }
  }

  async function initialize(service = new PreferencesService()): Promise<ThemePreference> {
    if (initialization) {
      return initialization
    }

    initialization = resolveInitialTheme(service).then((resolvedPreference) => {
      preference.value = resolvedPreference
      applyThemeToDocument(resolvedPreference)
      resolvedTheme.value = resolveTheme(resolvedPreference)
      syncSystemWatcher(resolvedPreference)
      return resolvedPreference
    })

    return initialization
  }

  async function setTheme(
    nextPreference: ThemePreference,
    service = new PreferencesService()
  ): Promise<boolean> {
    if (nextPreference === preference.value && latestRequestedTheme === null) {
      return true
    }

    latestRequestedTheme = nextPreference
    isSaving.value = true

    try {
      const savedPreference = await service.setTheme(nextPreference)

      if (latestRequestedTheme !== nextPreference) {
        // A newer request superseded this one while it was in flight.
        return false
      }

      preference.value = savedPreference
      applyThemeToDocument(savedPreference)
      resolvedTheme.value = resolveTheme(savedPreference)
      syncSystemWatcher(savedPreference)
      persistenceFailed.value = false
      latestRequestedTheme = null
      return true
    } catch {
      if (latestRequestedTheme !== nextPreference) {
        return false
      }

      // Persistence failed, but the choice still applies visually for this session — startup and
      // the current session are never blocked by a settings-write failure. It just may not
      // survive a restart, which the caller surfaces via `persistenceFailed`.
      preference.value = nextPreference
      applyThemeToDocument(nextPreference)
      resolvedTheme.value = resolveTheme(nextPreference)
      syncSystemWatcher(nextPreference)
      persistenceFailed.value = true
      latestRequestedTheme = null
      return false
    } finally {
      if (latestRequestedTheme === null) {
        isSaving.value = false
      }
    }
  }

  return { preference, resolvedTheme, isSaving, persistenceFailed, initialize, setTheme }
})
