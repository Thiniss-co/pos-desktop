import {
  type ApiErrorEnvelope,
  MAX_RETRY_AFTER_SECONDS,
  type PublicAppError,
  publicAppErrorSchema
} from '@shared/contracts/api.contract'
import { isKnownApiErrorCode } from '@shared/constants/apiErrorCodes'

export function createPublicError(
  category: PublicAppError['category'],
  message: string,
  retryable: boolean,
  details: Pick<
    PublicAppError,
    'backendCode' | 'fieldErrors' | 'traceId' | 'httpStatus' | 'contentType'
  > = {}
): PublicAppError {
  return publicAppErrorSchema.parse({
    category,
    message,
    retryable,
    ...details
  })
}

function categoryForBackendCode(code: string): PublicAppError['category'] {
  if (
    code === 'UNAUTHENTICATED' ||
    code === 'INVALID_CREDENTIALS' ||
    code === 'USER_INACTIVE' ||
    code === 'SESSION_REVOKED' ||
    code === 'DESKTOP_LOGIN_FORBIDDEN' ||
    code === 'DESKTOP_TOKEN_NOT_BOUND' ||
    code === 'DESKTOP_TOKEN_DEVICE_MISMATCH'
  ) {
    return 'authentication'
  }

  if (
    code === 'FORBIDDEN' ||
    code === 'COMPANY_INACTIVE' ||
    // Phase 3: the platform suspended the company. One operation is refused; the session stays valid.
    code === 'COMPANY_SUSPENDED' ||
    code === 'PERMISSION_DENIED' ||
    code === 'FEATURE_PERMISSION_DENIED' ||
    code === 'FEATURE_NOT_ENABLED' ||
    code === 'LOYALTY_FEATURE_NOT_ENABLED' ||
    code === 'ACCOUNTING_FEATURE_NOT_ENABLED' ||
    code === 'DESKTOP_CONTEXT_REQUIRED' ||
    code === 'DESKTOP_ACCESS_FORBIDDEN' ||
    code === 'DESKTOP_SHIFT_ACCESS_DENIED' ||
    // The shift is unknown to this company, or belongs to another device. The backend returns one
    // opaque response for both on purpose, so the desktop must not try to distinguish them.
    code === 'DESKTOP_HISTORICAL_ATTRIBUTION_FORBIDDEN' ||
    code === 'ROLE_ASSIGNMENT_FORBIDDEN' ||
    code === 'RECEIPT_PROFILE_ADMINISTRATION_FORBIDDEN'
  ) {
    return 'authorization'
  }

  // Terminal 422s from invoice upload. They are business rejections of this exact payload, never
  // transient: re-sending the identical frozen payload can only produce the identical rejection.
  if (
    code === 'DESKTOP_ALLOCATION_PROOF_REQUIRED' ||
    code === 'DESKTOP_LEGACY_CONTRACT_UNSUPPORTED' ||
    // PS9: the server cannot verify what the catalog issued for a line's product when the sale was
    // rung. Nothing in the payload asserts trackedness, so no resend and no client-side change can
    // supply the missing evidence. Classified explicitly rather than falling through to the
    // default, so the intent is visible next to its siblings.
    code === 'DESKTOP_HISTORICAL_STOCK_TRACKING_UNVERIFIABLE'
  ) {
    return 'rejected'
  }

  if (
    code === 'VALIDATION_ERROR' ||
    code === 'COMPANY_LIMIT_REACHED' ||
    code === 'RECEIPT_PROFILE_ASSET_INVALID'
  ) {
    return 'validation'
  }

  if (
    code === 'IDEMPOTENCY_CONFLICT' ||
    code === 'CONFLICT' ||
    code === 'COMPANY_LAST_ADMIN' ||
    code === 'DESKTOP_SHIFT_ALREADY_OPEN' ||
    code === 'DESKTOP_SHIFT_NOT_OPEN' ||
    code === 'DESKTOP_SHIFT_ALREADY_PAUSED' ||
    code === 'DESKTOP_SHIFT_NOT_PAUSED' ||
    code === 'DESKTOP_SHIFT_ACTIVE_PAUSE_NOT_FOUND' ||
    code === 'RECEIPT_PROFILE_REVISION_CONFLICT'
  ) {
    return 'conflict'
  }

  if (code === 'TOO_MANY_REQUESTS' || code === 'SERVER_ERROR' || code === 'SERVICE_UNAVAILABLE') {
    return 'transport'
  }

  return 'rejected'
}

function safeMessage(message: string, fallback: string): string {
  const normalized = message.trim()
  return normalized ? normalized.slice(0, 300) : fallback
}

export function invalidResponseEnvelopeError(): PublicAppError {
  return createPublicError(
    'unexpected',
    'The desktop service returned an invalid response envelope',
    false,
    { backendCode: 'response_envelope_invalid' }
  )
}

export function responseBodyNotJsonError(
  httpStatus: number,
  contentType: string | null
): PublicAppError {
  const normalizedContentType = contentType?.trim().slice(0, 200) || undefined

  return createPublicError(
    'unexpected',
    'The desktop service returned a response body that is not JSON',
    false,
    {
      backendCode: 'response_body_not_json',
      httpStatus,
      contentType: normalizedContentType
    }
  )
}

export function normalizeApiEnvelopeError(envelope: ApiErrorEnvelope): PublicAppError {
  const category = categoryForBackendCode(envelope.code)

  return createPublicError(
    category,
    safeMessage(envelope.message, 'The desktop service rejected the request'),
    category === 'transport',
    {
      backendCode: isKnownApiErrorCode(envelope.code) ? envelope.code : undefined,
      fieldErrors: Object.keys(envelope.errors).length > 0 ? envelope.errors : undefined,
      traceId: envelope.meta.trace_id
    }
  )
}

export function normalizeHttpError(status: number, envelope?: ApiErrorEnvelope): PublicAppError {
  if (envelope) {
    return normalizeApiEnvelopeError(envelope)
  }

  if (status === 401) {
    return createPublicError('authentication', 'Authentication is required', false)
  }

  if (status === 403) {
    return createPublicError('authorization', 'Access is not allowed', false)
  }

  if (status === 409) {
    return createPublicError('conflict', 'The request conflicts with existing data', false)
  }

  if (status === 422) {
    return createPublicError('validation', 'The request could not be validated', false)
  }

  if (status === 429 || status >= 500) {
    return createPublicError('transport', 'The desktop service is temporarily unavailable', true)
  }

  return createPublicError(
    'unexpected',
    'The desktop service returned an unexpected response',
    false
  )
}

export type TransportErrorClassification =
  'timeout' | 'dns' | 'connection_refused' | 'tls' | 'offline' | 'unknown'

export function classifyTransportError(error: unknown): TransportErrorClassification {
  const name = error instanceof Error ? error.name.toLowerCase() : ''
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  const source = `${name} ${message}`

  if (
    name === 'aborterror' ||
    source.includes('timeout') ||
    source.includes('net::err_timed_out')
  ) {
    return 'timeout'
  }

  if (
    source.includes('enotfound') ||
    source.includes('getaddrinfo') ||
    source.includes('net::err_name_not_resolved')
  ) {
    return 'dns'
  }

  if (
    source.includes('econnrefused') ||
    source.includes('fetch failed') ||
    source.includes('econnreset') ||
    source.includes('connect ') ||
    source.includes('net::err_connection_refused') ||
    source.includes('net::err_connection_reset') ||
    source.includes('net::err_connection_aborted') ||
    source.includes('net::err_connection_closed')
  ) {
    return 'connection_refused'
  }

  if (
    source.includes('certificate') ||
    source.includes('tls') ||
    source.includes('ssl') ||
    source.includes('net::err_cert')
  ) {
    return 'tls'
  }

  if (
    source.includes('network') ||
    source.includes('offline') ||
    source.includes('net::err_internet_disconnected')
  ) {
    return 'offline'
  }

  return 'unknown'
}

export function normalizeTransportError(error: unknown): PublicAppError {
  const classification = classifyTransportError(error)

  if (classification === 'timeout') {
    return createPublicError('transport', 'The request timed out', true)
  }

  if (classification === 'dns' || classification === 'offline') {
    return createPublicError('transport', 'The desktop service is unreachable', true)
  }

  if (classification === 'connection_refused') {
    return createPublicError('transport', 'The desktop service refused the connection', true)
  }

  if (classification === 'tls') {
    return createPublicError(
      'transport',
      'A secure connection to the desktop service could not be established',
      false
    )
  }

  return createPublicError('transport', 'The desktop service request failed', true)
}

export function backendNotConfiguredError(): PublicAppError {
  return createPublicError('configuration', 'The desktop backend is not configured', false)
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .replace(
      /\b(authorization|cookie|token|password|secret|company_code|activation_code|fingerprint(?:_hash)?)\b\s*[:=]\s*([^\s,&}\]]+)/gi,
      '$1=[REDACTED]'
    )
}

export function isPublicAppError(value: unknown): value is PublicAppError {
  return publicAppErrorSchema.safeParse(value).success
}

/** The HTTP statuses whose `Retry-After` header this client honors (RFC 9110 §10.2.3). */
export const RETRY_AFTER_STATUSES: ReadonlySet<number> = new Set([429, 503])

// RFC 9110 §5.6.7 IMF-fixdate, e.g. `Sun, 06 Nov 1994 08:49:37 GMT`. Only this form is accepted:
// `Date.parse` alone also accepts bare years, negative numbers and local-time strings, and treating
// any of those as a server instruction would be a guess.
const IMF_FIXDATE_PATTERN =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/

function parseImfFixdate(value: string | null | undefined): number | null {
  const trimmed = value?.trim()

  if (!trimmed || !IMF_FIXDATE_PATTERN.test(trimmed)) {
    return null
  }

  const parsed = Date.parse(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Parses an HTTP `Retry-After` header into whole seconds to wait.
 *
 * - delta-seconds (`/^\d+$/`) → that many seconds, honored in full up to
 *   {@link MAX_RETRY_AFTER_SECONDS}; larger values are not a usable delay.
 * - an IMF-fixdate → the seconds until that date, measured against the response's own `Date`
 *   header when it is a valid IMF-fixdate (so a skewed local clock cannot shorten or stretch the
 *   wait), otherwise against `nowMs`. A date at or before the reference → 0.
 * - anything else (empty, negative, fractional, malformed, another date format) → `undefined`, and
 *   the caller keeps its own backoff.
 *
 * Pure: the caller supplies `nowMs` (wall-clock epoch milliseconds).
 */
export function parseRetryAfter(
  headerValue: string | null | undefined,
  responseDateHeader: string | null | undefined,
  nowMs: number
): number | undefined {
  const value = headerValue?.trim()

  if (!value) {
    return undefined
  }

  if (/^\d+$/.test(value)) {
    const seconds = Number(value)
    return Number.isSafeInteger(seconds) && seconds <= MAX_RETRY_AFTER_SECONDS ? seconds : undefined
  }

  const retryAt = parseImfFixdate(value)

  if (retryAt === null) {
    return undefined
  }

  const reference = parseImfFixdate(responseDateHeader) ?? nowMs

  if (!Number.isFinite(reference)) {
    return undefined
  }

  const seconds = Math.ceil((retryAt - reference) / 1000)

  if (seconds <= 0) {
    return 0
  }

  return Number.isSafeInteger(seconds) && seconds <= MAX_RETRY_AFTER_SECONDS ? seconds : undefined
}

/**
 * Attaches the HTTP status and, when the header was usable, the server's `Retry-After` delay to an
 * error produced for a 429 or 503 response. Every other status is returned unchanged.
 */
export function withRetryAfterDetails(
  error: PublicAppError,
  httpStatus: number,
  retryAfterSeconds: number | undefined
): PublicAppError {
  if (!RETRY_AFTER_STATUSES.has(httpStatus)) {
    return error
  }

  return publicAppErrorSchema.parse({
    ...error,
    httpStatus,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds })
  })
}
