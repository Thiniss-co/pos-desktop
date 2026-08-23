import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { AuthService } from './service'
import { useAuthStore } from './store'

function authServiceWithGateway(gateway: Partial<Window['posApi']['auth']>): AuthService {
  return new AuthService(gateway as Window['posApi']['auth'])
}

describe('useAuthStore logout', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('clears the local session once the backend confirms logout', async () => {
    const store = useAuthStore()
    store.session = { isAuthenticated: true, userName: 'Manager One', userEmail: 'm@example.test' }

    await store.logout(
      authServiceWithGateway({ logout: async () => ({ ok: true, data: undefined }) })
    )

    expect(store.session).toEqual({ isAuthenticated: false, userName: null, userEmail: null })
    expect(store.isSubmitting).toBe(false)
  })

  it('still clears the local session when the logout request fails (e.g. offline)', async () => {
    const store = useAuthStore()
    store.session = { isAuthenticated: true, userName: 'Cashier One', userEmail: 'c@example.test' }

    await store.logout(
      authServiceWithGateway({
        logout: async () => {
          throw new Error('network unreachable')
        }
      })
    )

    expect(store.session).toEqual({ isAuthenticated: false, userName: null, userEmail: null })
  })

  it('ignores a second concurrent logout call while one is in flight', async () => {
    const store = useAuthStore()
    let calls = 0
    let resolveLogout: (() => void) | undefined

    const service = authServiceWithGateway({
      logout: () =>
        new Promise((resolve) => {
          calls += 1
          resolveLogout = () => resolve({ ok: true, data: undefined })
        })
    })

    const first = store.logout(service)
    const second = store.logout(service)

    resolveLogout?.()
    await Promise.all([first, second])

    expect(calls).toBe(1)
  })
})
