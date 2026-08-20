import { describe, expect, it } from 'vitest'
import { UNKNOWN_API_ERROR_CODE, isKnownApiErrorCode, toApiErrorCode } from './apiErrorCodes'

describe('API error code normalization', () => {
  it('keeps documented error codes', () => {
    expect(isKnownApiErrorCode('UNAUTHENTICATED')).toBe(true)
    expect(toApiErrorCode('UNAUTHENTICATED')).toBe('UNAUTHENTICATED')
    expect(isKnownApiErrorCode('SESSION_REVOKED')).toBe(true)
    expect(isKnownApiErrorCode('COMPANY_INACTIVE')).toBe(true)
    expect(isKnownApiErrorCode('ROLE_ASSIGNMENT_FORBIDDEN')).toBe(true)
  })

  it('maps future backend codes to the safe fallback', () => {
    expect(toApiErrorCode('FUTURE_BACKEND_CODE')).toBe(UNKNOWN_API_ERROR_CODE)
  })
})
