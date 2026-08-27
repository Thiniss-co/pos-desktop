import type { IpcMainInvokeEvent } from 'electron'
import { publicAppErrorSchema, type PublicAppError } from '@shared/contracts/api.contract'
import { getDevelopmentRendererUrl, isAllowedNavigation } from '../security/securityPolicy'

function untrustedSenderError(): PublicAppError {
  return publicAppErrorSchema.parse({
    category: 'authorization',
    message: 'This request could not be verified.',
    retryable: false
  })
}

/**
 * Requires the invoking frame to be the application's own main frame at a trusted origin — the
 * same allow-list `applyWindowSecurityPolicy` already enforces for `will-navigate` (the dev
 * renderer origin, otherwise `file:`). No existing IPC channel calls this; extending it to every
 * channel is a hardening follow-up out of scope for Phase 3E (see the checkout preview plan).
 */
export function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const frame = event.senderFrame

  if (!frame || frame.parent !== null) {
    throw untrustedSenderError()
  }

  if (!isAllowedNavigation(frame.url, getDevelopmentRendererUrl())) {
    throw untrustedSenderError()
  }
}
