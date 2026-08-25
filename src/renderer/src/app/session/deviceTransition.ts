import { publicAppErrorSchema } from '@shared/contracts/api.contract'
import { isDeviceTransitionError } from '@shared/constants/sessionTransitions'

export interface DeviceTransitionDependencies {
  refreshStartup(): Promise<void>
  replaceActivation(): Promise<unknown>
  setDeviceRecoveryMessage(): void
}

let configuredDependencies: DeviceTransitionDependencies | null = null

export function configureDeviceTransition(dependencies: DeviceTransitionDependencies): void {
  configuredDependencies = dependencies
}

export async function handleDeviceRecoveryTransition(
  dependencies?: DeviceTransitionDependencies
): Promise<boolean> {
  const transition = dependencies ?? configuredDependencies

  if (!transition) {
    return false
  }

  await transition.refreshStartup()
  transition.setDeviceRecoveryMessage()
  await transition.replaceActivation()

  return true
}

/**
 * Routes only a validated device-binding failure to activation. It deliberately does not clear
 * local device identity, bootstrap data, invoices, or the queue; the recovery path reuses them.
 */
export async function handleDeviceTransition(
  error: unknown,
  dependencies?: DeviceTransitionDependencies
): Promise<boolean> {
  const parsed = publicAppErrorSchema.safeParse(error)

  if (!parsed.success || !isDeviceTransitionError(parsed.data.backendCode)) {
    return false
  }

  return handleDeviceRecoveryTransition(dependencies)
}
