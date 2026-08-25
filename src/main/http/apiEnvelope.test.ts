import { describe, expect, it } from 'vitest'
import { parseApiEnvelope } from './apiEnvelope'

describe('parseApiEnvelope', () => {
  it('reports an invalid envelope as a typed unexpected error', () => {
    let failure: unknown

    try {
      parseApiEnvelope({ success: true, data: {} })
    } catch (error) {
      failure = error
    }

    expect(failure).toMatchObject({
      category: 'unexpected',
      backendCode: 'response_envelope_invalid',
      retryable: false
    })
  })
})
