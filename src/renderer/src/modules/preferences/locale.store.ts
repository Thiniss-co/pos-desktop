import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { LocaleCode } from '@shared/contracts/preferences.contract'
import { i18n } from '@renderer/i18n'
import {
  directionFor,
  FALLBACK_LOCALE,
  isSupportedLocale,
  localeFromLanguage
} from '@renderer/i18n/localeRegistry'
import { PreferencesService } from './service'

export function applyLocaleToDocument(locale: LocaleCode): void {
  i18n.global.locale.value = locale

  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale
    document.documentElement.dir = directionFor(locale)
  }
}

export async function resolveInitialLocale(
  service: Pick<PreferencesService, 'getLocale'>,
  browserLanguage: string | undefined = typeof navigator === 'undefined'
    ? undefined
    : navigator.language
): Promise<LocaleCode> {
  try {
    const storedLocale = await service.getLocale()

    if (storedLocale !== null) {
      return isSupportedLocale(storedLocale) ? storedLocale : FALLBACK_LOCALE
    }
  } catch {
    return FALLBACK_LOCALE
  }

  return localeFromLanguage(browserLanguage) ?? FALLBACK_LOCALE
}

export const useLocaleStore = defineStore('locale', () => {
  const locale = ref<LocaleCode>(FALLBACK_LOCALE)
  const isSaving = ref(false)
  let initialization: Promise<LocaleCode> | null = null
  // The most recently *requested* locale. A slower, earlier setLocale() call must not apply its
  // result once a later call has superseded it — otherwise rapid switching (e.g. ar then en
  // before the first save resolves) can persist and display a locale other than the user's last
  // choice. Only the call whose requested locale still matches this value on resolution applies.
  let latestRequestedLocale: LocaleCode | null = null

  async function initialize(service = new PreferencesService()): Promise<LocaleCode> {
    if (initialization) {
      return initialization
    }

    initialization = resolveInitialLocale(service).then((resolvedLocale) => {
      locale.value = resolvedLocale
      applyLocaleToDocument(resolvedLocale)
      return resolvedLocale
    })

    return initialization
  }

  async function setLocale(
    nextLocale: LocaleCode,
    service = new PreferencesService()
  ): Promise<boolean> {
    if (nextLocale === locale.value && latestRequestedLocale === null) {
      return true
    }

    latestRequestedLocale = nextLocale
    isSaving.value = true

    try {
      const savedLocale = await service.setLocale(nextLocale)

      if (latestRequestedLocale !== nextLocale) {
        // A newer request superseded this one while it was in flight.
        return false
      }

      locale.value = savedLocale
      applyLocaleToDocument(savedLocale)
      latestRequestedLocale = null
      return true
    } catch {
      if (latestRequestedLocale === nextLocale) {
        latestRequestedLocale = null
      }
      return false
    } finally {
      if (latestRequestedLocale === null) {
        isSaving.value = false
      }
    }
  }

  return { locale, isSaving, initialize, setLocale }
})
