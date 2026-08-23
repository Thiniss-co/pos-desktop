import { describe, expect, it } from 'vitest'
import { publicAppErrorSchema } from '@shared/contracts/api.contract'
import { i18n } from '@renderer/i18n'
import { localizeAppError } from './localizeAppError'

describe('localizeAppError', () => {
  it('keeps a safe backend message only when no stable localization route exists', () => {
    const error = publicAppErrorSchema.parse({
      category: 'rejected',
      message: 'A safe, sanitized backend message',
      retryable: false
    })

    i18n.global.locale.value = 'en'

    expect(localizeAppError(error, i18n.global.t, i18n.global.te)).toBe(
      'A safe, sanitized backend message'
    )
  })
})
