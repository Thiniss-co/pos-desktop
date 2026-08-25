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

  it('uses a safe backend message and reference when a backend code has no catalog entry', () => {
    const error = publicAppErrorSchema.parse({
      category: 'authorization',
      message: 'Desktop device branch and warehouse assignments are required.',
      backendCode: 'UNMAPPED_BACKEND_DENIAL',
      traceId: 'trace-shift-assignment',
      retryable: false
    })

    i18n.global.locale.value = 'en'

    expect(localizeAppError(error, i18n.global.t, i18n.global.te)).toBe(
      'Desktop device branch and warehouse assignments are required. Reference: trace-shift-assignment'
    )
  })
})
