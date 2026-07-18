import { describe, expect, it } from 'vitest'
import {
  backendNotConfiguredError,
  classifyTransportError,
  normalizeApiEnvelopeError,
  normalizeHttpError,
  normalizeTransportError,
  redactSensitiveText
} from './apiError'

describe('API error normalization', () => {
  it('classifies rate limits as retryable transport failures', () => {
    expect(normalizeHttpError(429)).toMatchObject({ category: 'transport', retryable: true })
  })

  it('classifies DNS failures as retryable transport failures', () => {
    expect(
      normalizeTransportError(new Error('getaddrinfo ENOTFOUND api.example.test'))
    ).toMatchObject({ category: 'transport', retryable: true })
  })

  it.each([
    [new DOMException('The operation timed out', 'AbortError'), 'timeout'],
    [new Error('getaddrinfo ENOTFOUND api.example.test'), 'dns'],
    [new Error('connect ECONNREFUSED 127.0.0.1:8000'), 'connection_refused'],
    [new Error('certificate verify failed'), 'tls'],
    [new Error('network is offline'), 'offline'],
    [new Error('unexpected transport failure'), 'unknown']
  ] as const)('classifies %s transport errors as %s', (error, classification) => {
    expect(classifyTransportError(error)).toBe(classification)
  })

  it.each([new Error('ECONNREFUSED'), new Error('fetch failed')])(
    'surfaces connection refusal distinctly for %s',
    (error) => {
      expect(normalizeTransportError(error)).toMatchObject({
        category: 'transport',
        retryable: true,
        message: 'The desktop service refused the connection'
      })
    }
  )

  it('returns a non-retryable configuration error when no backend is configured', () => {
    expect(backendNotConfiguredError()).toMatchObject({
      category: 'configuration',
      retryable: false,
      message: 'The desktop backend is not configured'
    })
  })

  it('redacts secret-like values from loggable text', () => {
    expect(redactSensitiveText('Bearer secret-token password=hunter2')).toBe(
      'Bearer [REDACTED] password=[REDACTED]'
    )
  })

  it('maps INVALID_CREDENTIALS to a non-retryable authentication failure', () => {
    expect(
      normalizeApiEnvelopeError({
        success: false,
        message: 'Invalid company or activation code.',
        code: 'INVALID_CREDENTIALS',
        errors: {},
        meta: { trace_id: 'trace-1' }
      })
    ).toMatchObject({
      category: 'authentication',
      retryable: false,
      backendCode: 'INVALID_CREDENTIALS'
    })
  })

  it('maps DESKTOP_TOKEN_DEVICE_MISMATCH to an authentication failure', () => {
    expect(
      normalizeApiEnvelopeError({
        success: false,
        message: 'Desktop token is not valid for this device.',
        code: 'DESKTOP_TOKEN_DEVICE_MISMATCH',
        errors: {},
        meta: {}
      })
    ).toMatchObject({ category: 'authentication' })
  })

  it('maps VALIDATION_ERROR to a validation failure with field errors', () => {
    expect(
      normalizeApiEnvelopeError({
        success: false,
        message: 'The given data was invalid.',
        code: 'VALIDATION_ERROR',
        errors: { email: ['The email field is required.'] },
        meta: {}
      })
    ).toMatchObject({
      category: 'validation',
      fieldErrors: { email: ['The email field is required.'] }
    })
  })

  it('maps server-side backend codes to retryable transport failures', () => {
    expect(
      normalizeApiEnvelopeError({
        success: false,
        message: 'Too many requests.',
        code: 'TOO_MANY_REQUESTS',
        errors: {},
        meta: {}
      })
    ).toMatchObject({ category: 'transport', retryable: true })
  })

  it('maps DESKTOP_ACCESS_FORBIDDEN to an authorization failure', () => {
    expect(
      normalizeApiEnvelopeError({
        success: false,
        message: 'Desktop access is not permitted.',
        code: 'DESKTOP_ACCESS_FORBIDDEN',
        errors: {},
        meta: {}
      })
    ).toMatchObject({ category: 'authorization', retryable: false })
  })
})
