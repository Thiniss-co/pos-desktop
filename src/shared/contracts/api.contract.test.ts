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
})
