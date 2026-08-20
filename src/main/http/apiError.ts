import {
  type ApiErrorEnvelope,
  type PublicAppError,
  publicAppErrorSchema
} from '@shared/contracts/api.contract'
import { isKnownApiErrorCode } from '@shared/constants/apiErrorCodes'

function createPublicError(
  category: PublicAppError['category'],
  message: string,
  retryable: boolean,
  details: Pick<PublicAppError, 'backendCode' | 'fieldErrors' | 'traceId'> = {}
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
    code === 'PERMISSION_DENIED' ||
    code === 'FEATURE_PERMISSION_DENIED' ||
    code === 'FEATURE_NOT_ENABLED' ||
    code === 'LOYALTY_FEATURE_NOT_ENABLED' ||
    code === 'ACCOUNTING_FEATURE_NOT_ENABLED' ||
    code === 'DESKTOP_CONTEXT_REQUIRED' ||
    code === 'DESKTOP_ACCESS_FORBIDDEN' ||
    code === 'DESKTOP_SHIFT_ACCESS_DENIED' ||
    code === 'ROLE_ASSIGNMENT_FORBIDDEN'
  ) {
    return 'authorization'
  }

  if (code === 'VALIDATION_ERROR' || code === 'COMPANY_LIMIT_REACHED') {
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
    code === 'DESKTOP_SHIFT_ACTIVE_PAUSE_NOT_FOUND'
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

  if (name === 'aborterror' || message.includes('timeout')) {
    return 'timeout'
  }

  if (message.includes('enotfound') || message.includes('getaddrinfo')) {
    return 'dns'
  }

  if (
    message.includes('econnrefused') ||
    message.includes('fetch failed') ||
    message.includes('econnreset') ||
    message.includes('connect ')
  ) {
    return 'connection_refused'
  }

  if (message.includes('certificate') || message.includes('tls') || message.includes('ssl')) {
    return 'tls'
  }

  if (message.includes('network') || message.includes('offline')) {
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
