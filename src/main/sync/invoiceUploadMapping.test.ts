import { describe, expect, it } from 'vitest'
import type { PublicAppError } from '@shared/contracts/api.contract'
import { mapUploadFailure } from './invoiceUploadMapping'

function error(overrides: Partial<PublicAppError>): PublicAppError {
  return {
    category: 'transport',
    message: 'Something happened',
    retryable: true,
    ...overrides
  } as PublicAppError
}

describe('mapUploadFailure', () => {
  const fixedRandom = (): number => 0.5

  describe('terminal rejections', () => {
    it.each([
      ['VALIDATION_ERROR', 'validation'],
      ['DESKTOP_CATALOG_REVISION_INVALID', 'rejected'],
      ['DESKTOP_ALLOCATION_PROOF_REQUIRED', 'rejected'],
      ['DESKTOP_LEGACY_CONTRACT_UNSUPPORTED', 'rejected'],
      ['DESKTOP_HISTORICAL_ATTRIBUTION_FORBIDDEN', 'authorization']
    ])('maps %s to a terminal rejection without pausing', (backendCode, category) => {
      const disposition = mapUploadFailure(
        error({ category: category as PublicAppError['category'], backendCode }),
        1,
        fixedRandom
      )

      expect(disposition.kind).toBe('outcome')
      expect(disposition.outcome).toMatchObject({ kind: 'rejected', errorCode: backendCode })
    })

    it('does not pause on an attribution refusal, even though it is a 403', () => {
      // It is a fact about one invoice's shift, not about this device's authority. Pausing would
      // stop every other queued sale for a reason that does not apply to them.
      const disposition = mapUploadFailure(
        error({
          category: 'authorization',
          backendCode: 'DESKTOP_HISTORICAL_ATTRIBUTION_FORBIDDEN'
        }),
        1,
        fixedRandom
      )

      expect(disposition.kind).not.toBe('pause')
    })
  })

  describe('conflicts', () => {
    it.each(['IDEMPOTENCY_CONFLICT', 'CONFLICT'])('maps %s to a conflict for review', (code) => {
      const disposition = mapUploadFailure(
        error({
          category: 'conflict',
          backendCode: code,
          message: 'This idempotency key was already used with a different payload.',
          traceId: 'trace-1',
          httpStatus: 409
        }),
        1,
        fixedRandom
      )

      expect(disposition).toMatchObject({
        kind: 'outcome',
        outcome: {
          kind: 'conflict',
          errorCode: code,
          reportedDetails: 'This idempotency key was already used with a different payload.',
          details: { httpStatus: 409, traceId: 'trace-1' }
        }
      })
    })
  })

  describe('worker-wide pauses', () => {
    it.each([
      ['UNAUTHENTICATED', 'session-invalid'],
      ['SESSION_REVOKED', 'session-invalid'],
      ['DESKTOP_TOKEN_DEVICE_MISMATCH', 'device-blocked'],
      ['DESKTOP_TOKEN_NOT_BOUND', 'device-blocked'],
      ['DESKTOP_ACCESS_FORBIDDEN', 'device-blocked'],
      ['FORBIDDEN', 'license-denied'],
      ['PERMISSION_DENIED', 'permission-denied'],
      ['FEATURE_NOT_ENABLED', 'feature-not-enabled'],
      ['COMPANY_INACTIVE', 'company-inactive']
    ])('pauses the worker on %s', (backendCode, reason) => {
      const disposition = mapUploadFailure(
        error({ category: 'authorization', backendCode }),
        3,
        fixedRandom
      )

      expect(disposition).toMatchObject({ kind: 'pause', reason })
    })

    it('releases the item immediately rather than behind a backoff', () => {
      // The pause is what stops the loop. Once authority returns, the item should be eligible at
      // once instead of serving a delay it did not earn.
      const disposition = mapUploadFailure(
        error({ category: 'authorization', backendCode: 'FORBIDDEN' }),
        7,
        fixedRandom
      )

      expect(disposition.outcome).toMatchObject({ kind: 'retryable', retryDelayMs: 0 })
    })

    it('never marks a paused item terminal', () => {
      const disposition = mapUploadFailure(
        error({ category: 'authentication', backendCode: 'UNAUTHENTICATED' }),
        1,
        fixedRandom
      )

      expect(disposition.outcome.kind).toBe('retryable')
    })

    it('pauses on an unconfigured backend', () => {
      expect(mapUploadFailure(error({ category: 'configuration' }), 1, fixedRandom)).toMatchObject({
        kind: 'pause',
        reason: 'not-configured'
      })
    })

    it('pauses on an unrecognized denial rather than assuming it is per-item', () => {
      expect(
        mapUploadFailure(
          error({ category: 'authorization', backendCode: 'ROLE_ASSIGNMENT_FORBIDDEN' }),
          1,
          fixedRandom
        )
      ).toMatchObject({ kind: 'pause', reason: 'unknown' })
    })
  })

  describe('retryable failures', () => {
    it.each([
      ['TOO_MANY_REQUESTS', 'transport'],
      ['SERVER_ERROR', 'transport'],
      ['SERVICE_UNAVAILABLE', 'transport']
    ])('retries %s with backoff', (backendCode, category) => {
      const disposition = mapUploadFailure(
        error({ category: category as PublicAppError['category'], backendCode }),
        2,
        fixedRandom
      )

      expect(disposition.kind).toBe('outcome')
      expect(disposition.outcome.kind).toBe('retryable')
      expect(
        disposition.outcome.kind === 'retryable' ? disposition.outcome.retryDelayMs : 0
      ).toBeGreaterThan(0)
    })

    it('retries a bare transport failure that carries no backend code', () => {
      const disposition = mapUploadFailure(error({ category: 'transport' }), 1, fixedRandom)

      expect(disposition.outcome).toMatchObject({ kind: 'retryable', errorCode: 'transport' })
    })

    it.each([
      'response_envelope_invalid',
      'response_body_not_json',
      'upload_success_code_unrecognized',
      'upload_response_invalid'
    ])('retries the contract failure %s instead of rejecting the sale', (backendCode) => {
      // Each of these can occur *after* the server committed the invoice. Rejecting would strand a
      // sale the server already holds; retrying replays the same idempotency key and converges on
      // the duplicate answer.
      const disposition = mapUploadFailure(
        error({ category: 'unexpected', backendCode }),
        1,
        fixedRandom
      )

      expect(disposition).toMatchObject({ kind: 'outcome', outcome: { kind: 'retryable' } })
    })

    it('retries an unknown backend code rather than terminally rejecting it', () => {
      // The safe direction: a wrongly-retried upload is visible and costs a request; a wrongly
      // rejected one silently strands a real sale.
      const disposition = mapUploadFailure(
        error({ category: 'rejected', backendCode: 'SOME_FUTURE_CODE' }),
        1,
        fixedRandom
      )

      expect(disposition).toMatchObject({ kind: 'outcome', outcome: { kind: 'retryable' } })
    })

    it('grows the delay as attempts accumulate', () => {
      const first = mapUploadFailure(error({ category: 'transport' }), 1, fixedRandom).outcome
      const later = mapUploadFailure(error({ category: 'transport' }), 6, fixedRandom).outcome

      expect(first.kind === 'retryable' ? first.retryDelayMs : 0).toBeLessThan(
        later.kind === 'retryable' ? later.retryDelayMs : 0
      )
    })
  })

  it('carries trace_id through to the persisted diagnostics', () => {
    const disposition = mapUploadFailure(
      error({
        category: 'transport',
        backendCode: 'SERVER_ERROR',
        traceId: 'trace-42',
        httpStatus: 500
      }),
      1,
      fixedRandom
    )

    expect(disposition.outcome).toMatchObject({
      details: { backendCode: 'SERVER_ERROR', httpStatus: 500, traceId: 'trace-42' }
    })
  })
})
