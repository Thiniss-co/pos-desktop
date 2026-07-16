export const API_ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'FEATURE_NOT_ENABLED',
  'PERMISSION_DENIED',
  'FEATURE_PERMISSION_DENIED',
  'DESKTOP_LOGIN_FORBIDDEN',
  'DESKTOP_TOKEN_NOT_BOUND',
  'DESKTOP_TOKEN_DEVICE_MISMATCH',
  'DESKTOP_CONTEXT_REQUIRED',
  'DESKTOP_ACCESS_FORBIDDEN',
  'IDEMPOTENCY_CONFLICT',
  'SHIFT_ALREADY_OPEN',
  'SHIFT_NOT_OPEN',
  'SHIFT_CLOSED',
  'SHIFT_PAUSED',
  'SHIFT_NOT_PAUSED',
  'VALIDATION_FAILED',
  'ROUTE_NOT_FOUND'
] as const

export const UNKNOWN_API_ERROR_CODE = 'UNKNOWN' as const

export type KnownApiErrorCode = (typeof API_ERROR_CODES)[number]
export type ApiErrorCode = KnownApiErrorCode | typeof UNKNOWN_API_ERROR_CODE

export function isKnownApiErrorCode(code: string): code is KnownApiErrorCode {
  return (API_ERROR_CODES as readonly string[]).includes(code)
}

export function toApiErrorCode(code: string): ApiErrorCode {
  return isKnownApiErrorCode(code) ? code : UNKNOWN_API_ERROR_CODE
}
