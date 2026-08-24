/**
 * Backend codes that conclusively end the currently authenticated desktop session.
 *
 * Device-state failures deliberately stay out of this list: they have their own recovery
 * workflow and must not be treated as account deactivation.
 */
export const SESSION_ENDING_ERROR_CODES = [
  'USER_INACTIVE',
  'SESSION_REVOKED',
  'UNAUTHENTICATED',
  'DESKTOP_TOKEN_NOT_BOUND'
] as const

export type SessionEndingErrorCode = (typeof SESSION_ENDING_ERROR_CODES)[number]

/** Device failures have an activation/recovery workflow and must never be redirected to login. */
export const DEVICE_TRANSITION_ERROR_CODES = ['DESKTOP_TOKEN_DEVICE_MISMATCH'] as const

export type DeviceTransitionErrorCode = (typeof DEVICE_TRANSITION_ERROR_CODES)[number]

export function isSessionEndingError(code: string | undefined): code is SessionEndingErrorCode {
  return Boolean(code && (SESSION_ENDING_ERROR_CODES as readonly string[]).includes(code))
}

export function isDeviceTransitionError(
  code: string | undefined
): code is DeviceTransitionErrorCode {
  return Boolean(code && (DEVICE_TRANSITION_ERROR_CODES as readonly string[]).includes(code))
}
