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

  it('uses a localized generic message for an unknown backend code', () => {
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
})
