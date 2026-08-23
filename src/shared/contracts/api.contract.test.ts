import { describe, expect, it } from 'vitest'
import { apiEnvelopeSchema } from './api.contract'

describe('apiEnvelopeSchema', () => {
  it('parses a success envelope', () => {
    const result = apiEnvelopeSchema.safeParse({
      success: true,
      message: 'Done',
      code: 'OK',
      data: { id: '123' },
      meta: {}
    })

    expect(result.success).toBe(true)
  })

  it('parses an error envelope with a trace id', () => {
    const result = apiEnvelopeSchema.safeParse({
      success: false,
      message: 'Invalid request',
      code: 'VALIDATION_FAILED',
      errors: { email: ['Enter a valid email address'] },
      meta: { trace_id: 'trace-123' }
    })

    expect(result.success).toBe(true)
    if (result.success && !result.data.success) {
      expect(result.data.meta.trace_id).toBe('trace-123')
    }
  })

  it('rejects malformed envelopes', () => {
    expect(apiEnvelopeSchema.safeParse({ message: 'Missing fields' }).success).toBe(false)
  })

  it('normalizes an explicit null errors field to an empty object', () => {
    // Laravel's ApiResponse::error() sends `errors: null` (not an omitted field) for every
    // non-validation failure — INVALID_CREDENTIALS, FORBIDDEN, TOO_MANY_REQUESTS, etc. This is
    // the real response shape, not a hypothetical: `zod`'s `.default()` only substitutes for
    // `undefined`, so this must be handled explicitly or the whole envelope fails to parse.
    const result = apiEnvelopeSchema.safeParse({
      success: false,
      message: 'Invalid company code or activation code.',
      code: 'INVALID_CREDENTIALS',
      errors: null,
      meta: { trace_id: 'trace-null-errors' }
    })

    expect(result.success).toBe(true)
    if (result.success && !result.data.success) {
      expect(result.data.errors).toEqual({})
    }
  })
})
