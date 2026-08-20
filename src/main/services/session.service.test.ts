import { describe, expect, it } from 'vitest'
import { publicAppErrorSchema } from '@shared/contracts/api.contract'
import type { SessionSummary } from '@shared/contracts/auth.contract'
import { DESKTOP_ACCESS_TOKEN_KEY, SessionService } from './session.service'

function publicError(backendCode: string): ReturnType<typeof publicAppErrorSchema.parse> {
  return publicAppErrorSchema.parse({
    category: 'authentication',
    message: 'Session is no longer valid',
    backendCode,
    retryable: false
  })
}

function createService(): {
  service: SessionService
  retainedState: Record<string, string>
  deletedKeys: string[]
} {
  let session: SessionSummary = {
    isAuthenticated: true,
    userName: 'Cashier',
    userEmail: 'cashier@example.test'
  }
  const retainedState = {
    deviceIdentity: 'device-uuid',
    license: 'validated-license-state',
    bootstrap: 'cached-bootstrap',
    syncQueue: 'pending-sale'
  }
  const deletedKeys: string[] = []
  const service = new SessionService(
    {
      getSummary: () => session,
      clear: () => {
        session = { isAuthenticated: false, userName: null, userEmail: null }
      }
    },
    { deleteSecret: (key) => deletedKeys.push(key) }
  )

  return { service, retainedState, deletedKeys }
}

describe('SessionService', () => {
  it.each(['USER_INACTIVE', 'SESSION_REVOKED', 'UNAUTHENTICATED', 'DESKTOP_TOKEN_NOT_BOUND'])(
    'ends only the current session for %s',
    (backendCode) => {
      const { service, retainedState, deletedKeys } = createService()
      const before = structuredClone(retainedState)

      service.applyApiFailure(publicError(backendCode))

      expect(service.getSummary().isAuthenticated).toBe(false)
      expect(deletedKeys).toEqual([DESKTOP_ACCESS_TOKEN_KEY])
      expect(retainedState).toEqual(before)
    }
  )

  it.each([
    'PERMISSION_DENIED',
    'FEATURE_NOT_ENABLED',
    'ROLE_ASSIGNMENT_FORBIDDEN',
    'DESKTOP_TOKEN_DEVICE_MISMATCH',
    'FUTURE_BACKEND_CODE'
  ])('does not end the session for %s', (backendCode) => {
    const { service, deletedKeys } = createService()

    service.applyApiFailure(publicError(backendCode))

    expect(service.getSummary().isAuthenticated).toBe(true)
    expect(deletedKeys).toEqual([])
  })
})
