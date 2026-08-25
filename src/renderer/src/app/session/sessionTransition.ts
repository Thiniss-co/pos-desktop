import { publicAppErrorSchema } from '@shared/contracts/api.contract'
import { isSessionEndingError } from '@shared/constants/sessionTransitions'

export const SESSION_ENDED_MESSAGE =
  'Your account no longer has access. Sign in with an active account or contact your manager.'

export interface SessionTransitionDependencies {
  refreshStartup(): Promise<void>
  replaceLogin(): Promise<unknown>
  setAuthMessage(message: string): void
}

let configuredDependencies: SessionTransitionDependencies | null = null

export function configureSessionTransition(dependencies: SessionTransitionDependencies): void {
  configuredDependencies = dependencies
}

export async function handleSessionEndingTransition(
  dependencies?: SessionTransitionDependencies
): Promise<boolean> {
  const transition = dependencies ?? configuredDependencies

  if (!transition) {
    return false
  }

  await transition.refreshStartup()
  transition.setAuthMessage(SESSION_ENDED_MESSAGE)
  await transition.replaceLogin()

  return true
}

/**
 * Moves the renderer to the login flow only after main has removed the invalid session. This
 * helper deliberately accepts only validated public errors so transport and authorization
 * failures cannot strand a cashier at the login screen.
 */
export async function handleSessionTransition(
  error: unknown,
  dependencies?: SessionTransitionDependencies
): Promise<boolean> {
  const parsed = publicAppErrorSchema.safeParse(error)

  if (!parsed.success || !isSessionEndingError(parsed.data.backendCode)) {
    return false
  }

  return handleSessionEndingTransition(dependencies)
}
