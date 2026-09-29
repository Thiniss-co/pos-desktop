import { describe, expect, it, vi } from 'vitest'
import { publicAppErrorSchema } from '@shared/contracts/api.contract'
import type { SessionContext } from '../repositories/sessionMetadata.repository'
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
  it('keeps the epoch stable on refresh and clears authority only when the binding changes', () => {
    let context: SessionContext = {
      isAuthenticated: true,
      userUuid: '11111111-1111-4111-8111-111111111111',
      userIsActive: true,
      companyUuid: '22222222-2222-4222-8222-222222222222',
      deviceUuid: '33333333-3333-4333-8333-333333333333',
      serverDeviceId: '44444444-4444-4444-8444-444444444444'
    }
    const increment = vi.fn()
    const clearObservation = vi.fn()
    const service = new SessionService(
      {
        getSummary: () => ({
          isAuthenticated: context.isAuthenticated,
          userName: 'Cashier',
          userEmail: 'cashier@example.test'
        }),
        getContext: () => context,
        establish: (input) => {
          context = {
            isAuthenticated: true,
            userUuid: input.userUuid ?? null,
            userIsActive: input.userIsActive === true,
            companyUuid: input.companyUuid ?? null,
            deviceUuid: input.deviceUuid ?? null,
            serverDeviceId: input.serverDeviceId ?? null
          }
        },
        clear: () => undefined
      },
      { deleteSecret: () => undefined },
      { epoch: { increment }, observations: { clear: clearObservation } }
    )
    const input = {
      userName: 'Cashier',
      userEmail: 'cashier@example.test',
      userUuid: '11111111-1111-4111-8111-111111111111',
      userIsActive: true,
      companyUuid: '22222222-2222-4222-8222-222222222222',
      deviceUuid: '33333333-3333-4333-8333-333333333333',
      serverDeviceId: '44444444-4444-4444-8444-444444444444'
    }

    service.refreshSession(input)
    service.refreshSession({ ...input, companyUuid: '55555555-5555-4555-8555-555555555555' })

    expect(increment).not.toHaveBeenCalled()
    expect(clearObservation).toHaveBeenCalledTimes(1)
  })

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

  describe('onChanged', () => {
    const input = {
      userName: 'Cashier',
      userEmail: 'cashier@example.test',
      userUuid: '11111111-1111-4111-8111-111111111111',
      userIsActive: true,
      companyUuid: '22222222-2222-4222-8222-222222222222',
      deviceUuid: '33333333-3333-4333-8333-333333333333',
      serverDeviceId: '44444444-4444-4444-8444-444444444444'
    }

    function serviceWith(
      onChanged: () => void,
      overrides: { establish?: () => void; clear?: () => void } = {}
    ): SessionService {
      return new SessionService(
        {
          getSummary: () => ({ isAuthenticated: true, userName: null, userEmail: null }),
          getContext: () => ({
            isAuthenticated: true,
            userUuid: input.userUuid,
            userIsActive: true,
            companyUuid: input.companyUuid,
            deviceUuid: input.deviceUuid,
            serverDeviceId: input.serverDeviceId
          }),
          establish: overrides.establish ?? (() => undefined),
          clear: overrides.clear ?? (() => undefined)
        },
        { deleteSecret: () => undefined },
        { onChanged }
      )
    }

    it('fires after start, successful refresh and end', () => {
      const onChanged = vi.fn()
      const service = serviceWith(onChanged)

      service.startSession(input)
      expect(onChanged).toHaveBeenCalledTimes(1)
      service.refreshSession(input)
      expect(onChanged).toHaveBeenCalledTimes(2)
      service.endSession()
      expect(onChanged).toHaveBeenCalledTimes(3)
    })

    it('fires on applyApiFailure only when it ends the session', () => {
      const onChanged = vi.fn()
      const service = serviceWith(onChanged)

      service.applyApiFailure(publicError('DESKTOP_TOKEN_DEVICE_MISMATCH'))
      expect(onChanged).not.toHaveBeenCalled()
      service.applyApiFailure(publicError('SESSION_REVOKED'))
      expect(onChanged).toHaveBeenCalledTimes(1)
    })

    it('does not fire for a refresh or start that failed', () => {
      const onChanged = vi.fn()
      const service = serviceWith(onChanged, {
        establish: () => {
          throw new Error('disk full')
        }
      })

      expect(() => service.refreshSession(input)).toThrow('disk full')
      expect(() => service.startSession(input)).toThrow('disk full')
      expect(onChanged).not.toHaveBeenCalled()
    })

    it('still fires when ending the session fails part-way, and the error propagates', () => {
      const onChanged = vi.fn()
      const service = serviceWith(onChanged, {
        clear: () => {
          throw new Error('disk full')
        }
      })

      expect(() => service.endSession()).toThrow('disk full')
      expect(onChanged).toHaveBeenCalledTimes(1)
    })

    it('never lets a throwing listener break the transition', () => {
      const service = serviceWith(() => {
        throw new Error('listener exploded')
      })

      expect(() => service.startSession(input)).not.toThrow()
      expect(() => service.refreshSession(input)).not.toThrow()
      expect(() => service.endSession()).not.toThrow()
    })
  })
})
