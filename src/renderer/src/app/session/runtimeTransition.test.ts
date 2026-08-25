import { describe, expect, it, vi, type Mock } from 'vitest'
import { publicAppErrorSchema } from '@shared/contracts/api.contract'
import {
  DEVICE_TRANSITION_ERROR_CODES,
  SESSION_ENDING_ERROR_CODES
} from '@shared/constants/sessionTransitions'
import { handleRuntimeTransition } from './runtimeTransition'

interface RuntimeTransitionSpies {
  readonly session: {
    readonly refreshStartup: Mock<() => Promise<void>>
    readonly replaceLogin: Mock<() => Promise<unknown>>
    readonly setAuthMessage: Mock<(message: string) => void>
  }
  readonly device: {
    readonly refreshStartup: Mock<() => Promise<void>>
    readonly replaceActivation: Mock<() => Promise<unknown>>
    readonly setDeviceRecoveryMessage: Mock<() => void>
  }
}

function dependencies(): RuntimeTransitionSpies {
  return {
    session: {
      refreshStartup: vi.fn(async () => undefined),
      replaceLogin: vi.fn(async () => undefined),
      setAuthMessage: vi.fn()
    },
    device: {
      refreshStartup: vi.fn(async () => undefined),
      replaceActivation: vi.fn(async () => undefined),
      setDeviceRecoveryMessage: vi.fn()
    }
  }
}

describe('handleRuntimeTransition', () => {
  it.each(SESSION_ENDING_ERROR_CODES)(
    'routes session-ending code %s only to login',
    async (code) => {
      const transition = dependencies()
      const handled = await handleRuntimeTransition(
        publicAppErrorSchema.parse({
          category: 'authentication',
          message: 'Session ended.',
          backendCode: code,
          retryable: false
        }),
        transition
      )

      expect(handled).toBe(true)
      expect(transition.session.refreshStartup).toHaveBeenCalledOnce()
      expect(transition.session.replaceLogin).toHaveBeenCalledOnce()
      expect(transition.device.refreshStartup).not.toHaveBeenCalled()
      expect(transition.device.replaceActivation).not.toHaveBeenCalled()
    }
  )

  it.each(DEVICE_TRANSITION_ERROR_CODES)(
    'routes device-transition code %s only to activation',
    async (code) => {
      const transition = dependencies()
      const handled = await handleRuntimeTransition(
        publicAppErrorSchema.parse({
          category: 'authentication',
          message: 'Device binding changed.',
          backendCode: code,
          retryable: false
        }),
        transition
      )

      expect(handled).toBe(true)
      expect(transition.device.refreshStartup).toHaveBeenCalledOnce()
      expect(transition.device.setDeviceRecoveryMessage).toHaveBeenCalledOnce()
      expect(transition.device.replaceActivation).toHaveBeenCalledOnce()
      expect(transition.device.refreshStartup.mock.invocationCallOrder[0]).toBeLessThan(
        transition.device.replaceActivation.mock.invocationCallOrder[0]
      )
      expect(transition.session.refreshStartup).not.toHaveBeenCalled()
      expect(transition.session.replaceLogin).not.toHaveBeenCalled()
    }
  )

  it.each(['PERMISSION_DENIED', 'COMPANY_INACTIVE', 'COMMERCIAL_ACCESS_LICENSE_DENIED'])(
    'leaves authorization/commercial denial %s to its caller',
    async (backendCode) => {
      const transition = dependencies()

      await expect(
        handleRuntimeTransition(
          publicAppErrorSchema.parse({
            category: 'authorization',
            message: 'Access denied.',
            backendCode,
            retryable: false
          }),
          transition
        )
      ).resolves.toBe(false)

      expect(transition.session.refreshStartup).not.toHaveBeenCalled()
      expect(transition.device.refreshStartup).not.toHaveBeenCalled()
    }
  )
})
