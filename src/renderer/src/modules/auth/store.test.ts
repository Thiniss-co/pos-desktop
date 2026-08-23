import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { publicAppErrorSchema } from '@shared/contracts/api.contract'
import { i18n } from '@renderer/i18n'
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

describe('useAuthStore login error localization', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    i18n.global.locale.value = 'en'
  })

  afterEach(() => {
    i18n.global.locale.value = 'en'
  })

  it('re-localizes an already-displayed error when the user switches language afterwards', async () => {
    // Regression test: earlier code called localizeAppError() once and stored the result in a
    // plain string ref, so a login error shown in English stayed English even after switching to
    // Arabic — this asserts the displayed error text is reactive to i18n.global.locale instead.
    const store = useAuthStore()
    const invalidCredentials = publicAppErrorSchema.parse({
      category: 'authentication',
      message: 'The provided credentials are invalid.',
      backendCode: 'INVALID_CREDENTIALS',
      retryable: false
    })

    await store.login(
      { email: 'cashier@example.test', password: 'wrong' },
      authServiceWithGateway({ login: async () => ({ ok: false, error: invalidCredentials }) })
    )

    expect(store.error).toBe('The provided credentials are invalid.')

    i18n.global.locale.value = 'ar'

    expect(store.error).toBe('بيانات الاعتماد المدخلة غير صحيحة.')
  })
})
