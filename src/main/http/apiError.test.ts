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
    [new Error('net::ERR_CONNECTION_REFUSED'), 'connection_refused'],
    [new Error('net::ERR_CONNECTION_RESET'), 'connection_refused'],
    [new Error('net::ERR_CONNECTION_ABORTED'), 'connection_refused'],
    [new Error('net::ERR_CONNECTION_CLOSED'), 'connection_refused'],
    [new Error('net::ERR_NAME_NOT_RESOLVED'), 'dns'],
    [new Error('net::ERR_INTERNET_DISCONNECTED'), 'offline'],
    [new Error('net::ERR_TIMED_OUT'), 'timeout'],
    [new Error('net::ERR_CERT_AUTHORITY_INVALID'), 'tls'],
    [new Error('net::ERR_SSL_PROTOCOL_ERROR'), 'tls'],
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

  it('maps session revocation, company inactivity, and role-assignment denial without activation reset', () => {
    const sessionRevoked = normalizeApiEnvelopeError({
      success: false,
      message: 'Session revoked.',
      code: 'SESSION_REVOKED',
      errors: {},
      meta: {}
    })
    const roleDenied = normalizeApiEnvelopeError({
      success: false,
      message: 'Role assignment is not allowed.',
      code: 'ROLE_ASSIGNMENT_FORBIDDEN',
      errors: {},
      meta: {}
    })
    const companyInactive = normalizeApiEnvelopeError({
      success: false,
      message: 'The company is inactive.',
      code: 'COMPANY_INACTIVE',
      errors: {},
      meta: {}
    })

    expect(sessionRevoked).toMatchObject({ category: 'authentication', retryable: false })
    expect(companyInactive).toMatchObject({ category: 'authorization', retryable: false })
    expect(roleDenied).toMatchObject({ category: 'authorization', retryable: false })
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

  it('strips an unrecognized backend code, keeping only the sanitized message', () => {
    // The renderer's localizeAppError() only ever sees a `backendCode` for a code this app
    // already knows about (isKnownApiErrorCode). A genuinely unknown code therefore never reaches
    // the catalog-lookup path — it always falls back to this sanitized message. If a future
    // backend code is added to apiErrorCodes.ts without a matching en/ar catalog entry, that
    // (different) case is what localizeAppError.ts's own generic-fallback branch guards against.
    const publicError = normalizeApiEnvelopeError({
      success: false,
      message: 'A future backend code the desktop app does not recognize yet.',
      code: 'SOME_FUTURE_CODE_NOT_YET_ADDED',
      errors: {},
      meta: {}
    })

    expect(publicError.backendCode).toBeUndefined()
    expect(publicError.message).toBe(
      'A future backend code the desktop app does not recognize yet.'
    )
  })

  describe('invoice upload codes (CP-3G-1)', () => {
    function normalize(
      code: string,
      message = 'Rejected.'
    ): ReturnType<typeof normalizeApiEnvelopeError> {
      return normalizeApiEnvelopeError({ success: false, message, code, errors: {}, meta: {} })
    }

    it('maps DESKTOP_HISTORICAL_ATTRIBUTION_FORBIDDEN to a non-retryable authorization failure', () => {
      expect(normalize('DESKTOP_HISTORICAL_ATTRIBUTION_FORBIDDEN')).toMatchObject({
        category: 'authorization',
        retryable: false
      })
    })

    it.each([
      'DESKTOP_ALLOCATION_PROOF_REQUIRED',
      'DESKTOP_LEGACY_CONTRACT_UNSUPPORTED',
      'DESKTOP_HISTORICAL_STOCK_TRACKING_UNVERIFIABLE'
    ])('maps %s to a non-retryable terminal rejection', (code) => {
      expect(normalize(code)).toMatchObject({ category: 'rejected', retryable: false })
    })

    it.each([
      'DESKTOP_HISTORICAL_ATTRIBUTION_FORBIDDEN',
      'DESKTOP_ALLOCATION_PROOF_REQUIRED',
      'DESKTOP_LEGACY_CONTRACT_UNSUPPORTED',
      'DESKTOP_HISTORICAL_STOCK_TRACKING_UNVERIFIABLE'
    ])('preserves %s as backendCode so the upload worker can branch on it', (code) => {
      // The point of listing these in apiErrorCodes.ts. Before CP-3G-1 they were unknown codes and
      // normalizeApiEnvelopeError stripped backendCode entirely, leaving a terminal rejection
      // indistinguishable from any other failure.
      expect(normalize(code).backendCode).toBe(code)
    })

    it('keeps a stock-tracking baseline 503 retryable, so a rollout window is not terminal', () => {
      // PS9: the backend answers SERVICE_UNAVAILABLE while a tenant's tracking baseline is still
      // being built. That is a deployment window, not a verdict on the sale — if it mapped to a
      // terminal rejection the worker would permanently give up on a perfectly good invoice.
      expect(normalize('SERVICE_UNAVAILABLE')).toMatchObject({
        category: 'transport',
        retryable: true
      })
    })

    it('keeps validation field errors on a plain upload VALIDATION_ERROR', () => {
      expect(
        normalizeApiEnvelopeError({
          success: false,
          message: 'The given data was invalid.',
          code: 'VALIDATION_ERROR',
          errors: { shift_uuid: ['A cancelled shift cannot receive an invoice upload.'] },
          meta: { trace_id: 'trace-9' }
        })
      ).toMatchObject({
        category: 'validation',
        retryable: false,
        traceId: 'trace-9',
        fieldErrors: { shift_uuid: ['A cancelled shift cannot receive an invoice upload.'] }
      })
    })
  })
})
