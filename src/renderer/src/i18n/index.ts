import { createI18n } from 'vue-i18n'
import ar from './locales/ar.json'
import en from './locales/en.json'
import { FALLBACK_LOCALE } from './localeRegistry'

export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: FALLBACK_LOCALE,
  fallbackLocale: FALLBACK_LOCALE,
  messages: { en, ar }
})
