import { publicAppErrorSchema } from '@shared/contracts/api.contract'
import { isDeviceTransitionError, isSessionEndingError } from '@shared/constants/sessionTransitions'
import {
  handleDeviceRecoveryTransition,
  type DeviceTransitionDependencies
} from './deviceTransition'
import {
  handleSessionEndingTransition,
  type SessionTransitionDependencies
} from './sessionTransition'

export interface RuntimeTransitionDependencies {
  readonly session?: SessionTransitionDependencies
  readonly device?: DeviceTransitionDependencies
}

/**
 * The one renderer entry point for protected-operation recovery. It classifies a public error
 * exactly once, keeping device recovery separate from session loss and leaving ordinary denials
 * to their caller's existing display/access-blocked path.
 */
export async function handleRuntimeTransition(
  error: unknown,
  dependencies?: RuntimeTransitionDependencies
): Promise<boolean> {
  const parsed = publicAppErrorSchema.safeParse(error)

  if (!parsed.success) {
    return false
  }

  if (isSessionEndingError(parsed.data.backendCode)) {
    return handleSessionEndingTransition(dependencies?.session)
  }

  if (isDeviceTransitionError(parsed.data.backendCode)) {
    return handleDeviceRecoveryTransition(dependencies?.device)
  }

  return false
}
