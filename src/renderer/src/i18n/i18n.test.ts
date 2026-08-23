import { describe, expect, it } from 'vitest'
import { API_ERROR_CODES } from '@shared/constants/apiErrorCodes'
import { publicAppErrorSchema } from '@shared/contracts/api.contract'
import { localizeAppError } from '@renderer/shared/utils/localizeAppError'
import { i18n } from './index'
import ar from './locales/ar.json'
import en from './locales/en.json'

function flattenedKeys(value: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? prefix + '.' + key : key

    return typeof child === 'object' && child !== null
      ? flattenedKeys(child as Record<string, unknown>, path)
      : [path]
  })
}

describe('i18n catalogs', () => {
  it('keeps English and Arabic keys in parity and bundles every known backend error', () => {
    expect(flattenedKeys(ar)).toEqual(flattenedKeys(en))

    for (const code of API_ERROR_CODES) {
      expect(flattenedKeys(en)).toContain('errors.' + code)
    }
  })

  it('renders catalog entries offline and localizes known error codes', () => {
    const error = publicAppErrorSchema.parse({
      category: 'authentication',
      message: 'Raw backend message',
      backendCode: 'INVALID_CREDENTIALS',
      retryable: false
    })

    i18n.global.locale.value = 'en'
    expect(i18n.global.t('connectivity.offline')).toContain('offline')
    expect(localizeAppError(error, i18n.global.t, i18n.global.te)).toBe(
      'The provided credentials are invalid.'
    )

    i18n.global.locale.value = 'ar'
    expect(i18n.global.t('connectivity.offline')).toContain('غير متصلة')
    expect(localizeAppError(error, i18n.global.t, i18n.global.te)).toBe(
      'بيانات الاعتماد المدخلة غير صحيحة.'
    )
  })

  it('falls back to the localized generic message when a backendCode has no catalog entry', () => {
    // The main-process normalizer (apiError.ts) strips backendCode entirely for a code this app
    // doesn't recognize (see apiError.test.ts), so it never reaches localizeAppError with a
    // backendCode set. This exercises localizeAppError's own defensive branch directly — the
    // guard that would apply if apiErrorCodes.ts ever gained a new known code before its en/ar
    // catalog entry was added. It is not the path a real "unknown to this app" backend code takes
    // today; that path is covered by localizeAppError.test.ts's safe-fallback-message case.
    const error = publicAppErrorSchema.parse({
      category: 'rejected',
      message: 'Unexpected rejection',
      backendCode: 'NOT_A_REAL_CODE',
      retryable: false
    })

    i18n.global.locale.value = 'en'
    expect(localizeAppError(error, i18n.global.t, i18n.global.te)).toBe(
      'Something went wrong. Please try again.'
    )
  })

  it('compiles every catalog message in both locales without a message-syntax error', () => {
    // Regression test: `auth.emailPlaceholder` once held the raw string 'cashier@example.com'.
    // vue-i18n's message format treats `@` as the start of a linked-message reference, so that
    // string failed to compile — not at build time, not at key-parity-check time, but only the
    // first time something actually called t('auth.emailPlaceholder'), which no test exercised.
    // The failure crashed LoginPage's render entirely (a bare :placeholder binding throws), which
    // is why the login screen showed the PublicLayout chrome with nothing inside it. Key parity
    // and interpolation-parity checks are structural; they do not catch a broken message body.
    // This walks every leaf string in both catalogs through the real compiler so a stray `@`,
    // unescaped `{`/`}`, or `|` can never ship silently again.
    for (const locale of ['en', 'ar'] as const) {
      i18n.global.locale.value = locale
      const catalog = locale === 'en' ? en : ar

      for (const key of flattenedKeys(catalog)) {
        expect(() => i18n.global.t(key), `${locale}:${key}`).not.toThrow()
      }
    }
  })
})
