import { describe, expect, it } from 'vitest'
import { normalizeHttpError, normalizeTransportError, redactSensitiveText } from './apiError'

describe('API error normalization', () => {
  it('classifies rate limits as retryable transport failures', () => {
    expect(normalizeHttpError(429)).toMatchObject({ category: 'transport', retryable: true })
  })

  it('classifies DNS failures as retryable transport failures', () => {
    expect(
      normalizeTransportError(new Error('getaddrinfo ENOTFOUND api.example.test'))
    ).toMatchObject({ category: 'transport', retryable: true })
  })

  it('redacts secret-like values from loggable text', () => {
    expect(redactSensitiveText('Bearer secret-token password=hunter2')).toBe(
      'Bearer [REDACTED] password=[REDACTED]'
    )
  })
})
