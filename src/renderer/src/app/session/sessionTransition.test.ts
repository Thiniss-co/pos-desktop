import { describe, expect, it, vi } from 'vitest'
import { publicAppErrorSchema } from '@shared/contracts/api.contract'
import { SESSION_ENDED_MESSAGE, handleSessionTransition } from './sessionTransition'

describe('handleSessionTransition', () => {
  it('refreshes state and replaces the current route with login for a session-ending error', async () => {
    const refreshStartup = vi.fn(async () => undefined)
    const replaceLogin = vi.fn(async () => undefined)
    const setAuthMessage = vi.fn()

    const handled = await handleSessionTransition(
      publicAppErrorSchema.parse({
        category: 'authentication',
        message: 'Session revoked',
        backendCode: 'SESSION_REVOKED',
        retryable: false
      }),
      { refreshStartup, replaceLogin, setAuthMessage }
    )

    expect(handled).toBe(true)
    expect(refreshStartup).toHaveBeenCalledOnce()
    expect(setAuthMessage).toHaveBeenCalledWith(SESSION_ENDED_MESSAGE)
    expect(replaceLogin).toHaveBeenCalledOnce()
    expect(refreshStartup.mock.invocationCallOrder[0]).toBeLessThan(
      replaceLogin.mock.invocationCallOrder[0]
    )
  })

  it('does not route on authorization, transport, or malformed errors', async () => {
    const refreshStartup = vi.fn(async () => undefined)
    const replaceLogin = vi.fn(async () => undefined)
    const setAuthMessage = vi.fn()
    const dependencies = { refreshStartup, replaceLogin, setAuthMessage }

    await expect(
      handleSessionTransition(
        publicAppErrorSchema.parse({
          category: 'authorization',
          message: 'Role assignment denied',
          backendCode: 'ROLE_ASSIGNMENT_FORBIDDEN',
          retryable: false
        }),
        dependencies
      )
    ).resolves.toBe(false)
    await expect(
      handleSessionTransition({ backendCode: 'SESSION_REVOKED' }, dependencies)
    ).resolves.toBe(false)

    expect(refreshStartup).not.toHaveBeenCalled()
    expect(setAuthMessage).not.toHaveBeenCalled()
    expect(replaceLogin).not.toHaveBeenCalled()
  })
})
