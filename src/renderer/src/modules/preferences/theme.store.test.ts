// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ThemePreference } from '@shared/contracts/preferences.contract'
import {
  applyThemeToDocument,
  resolveInitialTheme,
  resolveTheme,
  useThemeStore
} from './theme.store'
import type { PreferencesService } from './service'

/**
 * A controllable stand-in for `window.matchMedia('(prefers-color-scheme: dark)')`, following the
 * repo's duck-typed-fake convention (see ConnectivityBanner.test.ts). happy-dom implements a real
 * MediaQueryList, but nothing in the test environment can simulate an actual OS theme change, so
 * tests that need to assert "the store reacts to a live OS change" drive this fake directly.
 */
function createMatchMediaStub(initialMatches: boolean): {
  matchMedia: (query: string) => MediaQueryList
  fireChange: (matches: boolean) => void
  hasListener: () => boolean
} {
  let matches = initialMatches
  let listener: ((event: { matches: boolean }) => void) | undefined

  const mediaQueryList = {
    get matches() {
      return matches
    },
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_type: string, handler: (event: { matches: boolean }) => void) => {
      listener = handler
    },
    removeEventListener: (_type: string, handler: (event: { matches: boolean }) => void) => {
      if (listener === handler) {
        listener = undefined
      }
    }
  }

  return {
    matchMedia: () => mediaQueryList as unknown as MediaQueryList,
    fireChange: (nextMatches: boolean) => {
      matches = nextMatches
      listener?.({ matches: nextMatches })
    },
    hasListener: () => listener !== undefined
  }
}

describe('theme preferences', () => {
  let originalMatchMedia: typeof window.matchMedia

  beforeEach(() => {
    setActivePinia(createPinia())
    delete document.documentElement.dataset.theme
    document.documentElement.style.colorScheme = ''
    originalMatchMedia = window.matchMedia
  })

  afterEach(() => {
    window.matchMedia = originalMatchMedia
  })

  it('resolves a persisted theme preference', async () => {
    await expect(resolveInitialTheme({ getTheme: async () => 'dark' })).resolves.toBe('dark')
  })

  it('falls back to "system" when nothing was persisted or the read fails', async () => {
    await expect(resolveInitialTheme({ getTheme: async () => null })).resolves.toBe('system')
    await expect(
      resolveInitialTheme({
        getTheme: async () => {
          throw new Error('IPC unavailable')
        }
      })
    ).resolves.toBe('system')
  })

  it('resolveTheme resolves "system" against the OS preference and passes explicit choices through', () => {
    window.matchMedia = createMatchMediaStub(true).matchMedia as typeof window.matchMedia
    expect(resolveTheme('system')).toBe('dark')
    expect(resolveTheme('light')).toBe('light')
    expect(resolveTheme('dark')).toBe('dark')
  })

  it('applies an explicit theme to the document root before mount, with color-scheme matching', async () => {
    window.matchMedia = createMatchMediaStub(false).matchMedia as typeof window.matchMedia
    const store = useThemeStore()

    await store.initialize({ getTheme: async () => 'dark' } as PreferencesService)

    expect(store.preference).toBe('dark')
    expect(store.resolvedTheme).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
  })

  it('leaves data-theme unset for "system" so the CSS media query owns the paint, no flash', async () => {
    window.matchMedia = createMatchMediaStub(true).matchMedia as typeof window.matchMedia
    const store = useThemeStore()

    await store.initialize({ getTheme: async () => 'system' } as PreferencesService)

    expect(store.preference).toBe('system')
    expect(store.resolvedTheme).toBe('dark')
    expect(document.documentElement.dataset.theme).toBeUndefined()
    expect(document.documentElement.style.colorScheme).toBe('light dark')
  })

  it('follows live OS theme changes while in system mode, and unsubscribes on leaving it', async () => {
    const stub = createMatchMediaStub(false)
    window.matchMedia = stub.matchMedia as typeof window.matchMedia
    const service = {
      getTheme: async () => 'system' as ThemePreference,
      setTheme: async (theme: ThemePreference) => theme
    }
    const store = useThemeStore()

    await store.initialize(service as unknown as PreferencesService)
    expect(stub.hasListener()).toBe(true)
    expect(store.resolvedTheme).toBe('light')

    stub.fireChange(true)
    expect(store.resolvedTheme).toBe('dark')

    await store.setTheme('light', service as unknown as PreferencesService)
    expect(stub.hasListener()).toBe(false)
    expect(document.documentElement.dataset.theme).toBe('light')

    // Switching back to system re-subscribes rather than leaking a second listener.
    await store.setTheme('system', service as unknown as PreferencesService)
    expect(stub.hasListener()).toBe(true)
  })

  it('persists a selected theme through the named preferences gateway', async () => {
    window.matchMedia = createMatchMediaStub(false).matchMedia as typeof window.matchMedia
    let saved: ThemePreference = 'system'
    const service = {
      getTheme: async () => saved,
      setTheme: async (theme: ThemePreference) => {
        saved = theme
        return theme
      }
    }
    const store = useThemeStore()

    await store.initialize(service as unknown as PreferencesService)
    await expect(store.setTheme('dark', service as unknown as PreferencesService)).resolves.toBe(
      true
    )

    expect(saved).toBe('dark')
    expect(store.preference).toBe('dark')
    expect(store.persistenceFailed).toBe(false)
  })

  it('applies only the most recently requested theme when switches overlap (last-write-wins)', async () => {
    window.matchMedia = createMatchMediaStub(false).matchMedia as typeof window.matchMedia
    let saved: ThemePreference = 'light'
    const pending = new Map<ThemePreference, () => void>()
    const service = {
      getTheme: async () => saved,
      setTheme: (theme: ThemePreference) =>
        new Promise<ThemePreference>((resolve) => {
          pending.set(theme, () => {
            saved = theme
            resolve(theme)
          })
        })
    }
    const store = useThemeStore()
    await store.initialize(service as unknown as PreferencesService)

    const darkSave = store.setTheme('dark', service as unknown as PreferencesService)
    const lightSave = store.setTheme('light', service as unknown as PreferencesService)

    expect(store.isSaving).toBe(true)

    // Resolve the slower 'dark' request first, then the newer 'light' request — out of order.
    pending.get('dark')?.()
    pending.get('light')?.()

    await expect(darkSave).resolves.toBe(false)
    await expect(lightSave).resolves.toBe(true)

    expect(store.preference).toBe('light')
    expect(saved).toBe('light')
    expect(store.isSaving).toBe(false)
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('still applies the theme visually and flags persistenceFailed when the save rejects', async () => {
    window.matchMedia = createMatchMediaStub(false).matchMedia as typeof window.matchMedia
    const service = {
      getTheme: async () => 'system' as ThemePreference,
      setTheme: async () => {
        throw new Error('disk full')
      }
    }
    const store = useThemeStore()
    await store.initialize(service as unknown as PreferencesService)

    await expect(store.setTheme('dark', service as unknown as PreferencesService)).resolves.toBe(
      false
    )

    expect(store.preference).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(store.persistenceFailed).toBe(true)
    expect(store.isSaving).toBe(false)
  })

  it('never touches localStorage or sessionStorage', async () => {
    window.matchMedia = createMatchMediaStub(false).matchMedia as typeof window.matchMedia
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    const service = {
      getTheme: async () => 'system' as ThemePreference,
      setTheme: async (theme: ThemePreference) => theme
    }
    const store = useThemeStore()

    await store.initialize(service as unknown as PreferencesService)
    await store.setTheme('dark', service as unknown as PreferencesService)

    expect(setItemSpy).not.toHaveBeenCalled()
    setItemSpy.mockRestore()
  })

  it('does not touch document.documentElement.lang/dir — theme and locale stay independent', async () => {
    window.matchMedia = createMatchMediaStub(false).matchMedia as typeof window.matchMedia
    document.documentElement.lang = 'ar'
    document.documentElement.dir = 'rtl'
    const store = useThemeStore()

    await store.initialize({ getTheme: async () => 'dark' } as PreferencesService)

    expect(document.documentElement.lang).toBe('ar')
    expect(document.documentElement.dir).toBe('rtl')
  })

  it('applyThemeToDocument is idempotent and safe to call directly', () => {
    window.matchMedia = createMatchMediaStub(false).matchMedia as typeof window.matchMedia
    applyThemeToDocument('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    applyThemeToDocument('system')
    expect(document.documentElement.dataset.theme).toBeUndefined()
  })
})
