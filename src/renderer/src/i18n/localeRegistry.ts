import type { LocaleCode } from '@shared/contracts/preferences.contract'

export interface SupportedLocale {
  readonly code: LocaleCode
  readonly dir: 'ltr' | 'rtl'
  readonly nativeName: string
}

export const FALLBACK_LOCALE: LocaleCode = 'en'

export const SUPPORTED_LOCALES = Object.freeze([
  { code: 'en', dir: 'ltr', nativeName: 'English' },
  { code: 'ar', dir: 'rtl', nativeName: 'العربية' }
] satisfies readonly SupportedLocale[])

export function isSupportedLocale(value: string | null | undefined): value is LocaleCode {
  return SUPPORTED_LOCALES.some((locale) => locale.code === value)
}

export function directionFor(locale: LocaleCode): SupportedLocale['dir'] {
  return SUPPORTED_LOCALES.find((candidate) => candidate.code === locale)?.dir ?? 'ltr'
}

export function localeFromLanguage(language: string | undefined): LocaleCode | null {
  const baseLanguage = language?.trim().toLowerCase().split('-')[0]

  return isSupportedLocale(baseLanguage) ? baseLanguage : null
}
