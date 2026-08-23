// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import { PreferencesService } from './service'
import { resolveInitialLocale, useLocaleStore } from './locale.store'

describe('locale preferences', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    document.documentElement.lang = ''
    document.documentElement.dir = ''
    i18n.global.locale.value = 'en'
  })

  it('resolves a persisted locale before the browser language and applies RTL direction', async () => {
    const service = { getLocale: async () => 'ar' as const }

    await expect(resolveInitialLocale(service, 'en-GB')).resolves.toBe('ar')

    const store = useLocaleStore()
    await store.initialize(service as PreferencesService)

    expect(store.locale).toBe('ar')
    expect(document.documentElement.lang).toBe('ar')
    expect(document.documentElement.dir).toBe('rtl')
  })

  it('uses the supported OS language only when no locale was persisted', async () => {
    await expect(resolveInitialLocale({ getLocale: async () => null }, 'ar-EG')).resolves.toBe('ar')
  })

  it('falls back to English if the locale IPC read fails or returns an invalid value', async () => {
    await expect(
      resolveInitialLocale(
        {
          getLocale: async () => {
            throw new Error('IPC unavailable')
          }
        },
        'ar-EG'
      )
    ).resolves.toBe('en')
    await expect(
      resolveInitialLocale({ getLocale: async () => 'fr' as never }, 'ar-EG')
    ).resolves.toBe('en')
  })

  it('persists a selected language through the named preferences gateway', async () => {
    let saved = 'en'
    const service = {
      getLocale: async () => saved as 'en' | 'ar',
      setLocale: async (locale: 'en' | 'ar') => {
        saved = locale
        return locale
      }
    }
    const store = useLocaleStore()

    await store.initialize(service as PreferencesService)
    await expect(store.setLocale('ar', service as PreferencesService)).resolves.toBe(true)

    expect(saved).toBe('ar')
    expect(store.locale).toBe('ar')
  })

  it('applies only the most recently requested locale when switches overlap (last-write-wins)', async () => {
    // Regression test: a slower earlier save resolving after a faster later one must not clobber
    // the user's last choice, and must not falsely report success for the request it discarded.
    let saved = 'en'
    const pending = new Map<'en' | 'ar', () => void>()
    const service = {
      getLocale: async () => saved as 'en' | 'ar',
      setLocale: (locale: 'en' | 'ar') =>
        new Promise<'en' | 'ar'>((resolve) => {
          pending.set(locale, () => {
            saved = locale
            resolve(locale)
          })
        })
    }
    const store = useLocaleStore()
    await store.initialize(service as unknown as PreferencesService)

    const arSave = store.setLocale('ar', service as unknown as PreferencesService)
    const enSave = store.setLocale('en', service as unknown as PreferencesService)

    expect(store.isSaving).toBe(true)

    // Resolve the slower 'ar' request first, then the newer 'en' request — out of request order.
    pending.get('ar')?.()
    pending.get('en')?.()

    await expect(arSave).resolves.toBe(false)
    await expect(enSave).resolves.toBe(true)

    expect(store.locale).toBe('en')
    expect(saved).toBe('en')
    expect(store.isSaving).toBe(false)
  })
})
