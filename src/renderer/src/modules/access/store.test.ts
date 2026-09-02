import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { publicAppErrorSchema } from '@shared/contracts/api.contract'
import { i18n } from '@renderer/i18n'
import { useAccessStore } from './store'

describe('useAccessStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    i18n.global.locale.value = 'en'
  })

  afterEach(() => {
    i18n.global.locale.value = 'en'
  })

  it('renders the default blocked message in the active locale, not the locale at module load', () => {
    // Regression test: the default message must not be baked once via a module-scope i18n.t()
    // call (which would run before the persisted locale is even resolved and never update again).
    const store = useAccessStore()

    expect(store.state.message).toBe('Desktop access is not available for this workstation.')

    i18n.global.locale.value = 'ar'

    expect(store.state.message).toBe('وصول سطح المكتب غير متاح لمحطة العمل هذه.')
  })

  it('re-localizes a backend-driven block message when the language changes afterwards', () => {
    const store = useAccessStore()
    const companyInactive = publicAppErrorSchema.parse({
      category: 'authorization',
      message: 'This company is inactive.',
      backendCode: 'COMPANY_INACTIVE',
      retryable: false
    })

    store.setFromError(companyInactive)

    expect(store.state.message).toBe('This company is inactive.')

    i18n.global.locale.value = 'ar'

    expect(store.state.message).toBe('هذه الشركة غير نشطة.')
  })

  describe('refreshWorkstation', () => {
    const overdue = publicAppErrorSchema.parse({
      category: 'authorization',
      message: 'License validation is overdue. Connect to the desktop service to continue.',
      backendCode: 'COMMERCIAL_ACCESS_VALIDATION_OVERDUE',
      retryable: false
    })

    function decision(allowed: boolean, action: 'sell' | 'sync'): Record<string, unknown> {
      return {
        allowed,
        reason: allowed ? null : 'validation-overdue',
        warning: null,
        action
      }
    }

    function refreshService(overrides: Record<string, unknown> = {}): never {
      return {
        refresh: async () => ({
          status: {
            status: 'fresh',
            isReadable: true,
            catalogValid: true,
            lastSyncedAt: '2026-01-01T02:00:00Z',
            contract: null
          },
          refreshedAt: '2026-01-01T02:00:00.000Z',
          previousRevision: null,
          revisionChanged: false,
          counts: {},
          access: { sell: decision(true, 'sell'), sync: decision(true, 'sync') },
          licenseValidatedAt: '2026-01-01T02:00:00+00:00'
        }),
        ...overrides
      } as never
    }

    it('clears an overdue-license block and records the server-derived timestamp', async () => {
      const store = useAccessStore()
      store.setFromError(overdue)

      const recovered = await store.refreshWorkstation(refreshService())

      expect(recovered).toBe(true)
      // The block is gone, so the warning disappears immediately without a second round trip.
      expect(store.state.message).toBe(String(i18n.global.t('access.defaultMessage')))
      // Server-derived and main-persisted; the renderer only displays it.
      expect(store.lastValidatedAt).toBe('2026-01-01T02:00:00+00:00')
      expect(store.isRefreshing).toBe(false)
    })

    it('retains the block when validation succeeds but access is still denied', async () => {
      const store = useAccessStore()
      store.setFromError(overdue)

      const recovered = await store.refreshWorkstation(
        refreshService({
          refresh: async () => ({
            status: {
              status: 'stale',
              isReadable: true,
              catalogValid: false,
              lastSyncedAt: null,
              contract: null
            },
            refreshedAt: '2026-01-01T02:00:00.000Z',
            previousRevision: null,
            revisionChanged: false,
            counts: {},
            access: { sell: decision(false, 'sell'), sync: decision(false, 'sync') },
            licenseValidatedAt: null
          })
        })
      )

      expect(recovered).toBe(false)
      // Fail-closed: a request that merely *completed* never unblocks the workstation.
      expect(store.state.message).toBe(
        'License validation is overdue. Connect to the desktop service to continue.'
      )
    })

    it('retains the block and shows the real transport error when validation fails', async () => {
      const store = useAccessStore()
      store.setFromError(overdue)

      const recovered = await store.refreshWorkstation(
        refreshService({
          refresh: async () => {
            throw publicAppErrorSchema.parse({
              category: 'transport',
              message: 'The desktop service could not be reached.',
              retryable: true
            })
          }
        })
      )

      expect(recovered).toBe(false)
      // The actual failure replaces the stale overdue text, localized through the app's existing
      // `localizeAppError` rules (a `transport` category renders the localized transport message
      // rather than the raw backend string). What matters is that the real error is surfaced and
      // the block is retained — never cleared, never left showing the previous reason.
      expect(store.state.message).toBe(String(i18n.global.t('errors.transport')))
      expect(store.state.message).not.toContain('overdue')
      expect(store.isRefreshing).toBe(false)
    })

    it('surfaces a business error under its own backend code', async () => {
      const store = useAccessStore()
      store.setFromError(overdue)

      const recovered = await store.refreshWorkstation(
        refreshService({
          refresh: async () => {
            throw publicAppErrorSchema.parse({
              category: 'authorization',
              message: 'This company is inactive.',
              backendCode: 'COMPANY_INACTIVE',
              retryable: false
            })
          }
        })
      )

      expect(recovered).toBe(false)
      expect(store.state.message).toBe('This company is inactive.')
    })

    it('keeps the original block when the failure carries no public error', async () => {
      const store = useAccessStore()
      store.setFromError(overdue)

      await store.refreshWorkstation(
        refreshService({
          refresh: async () => {
            throw new Error('boom')
          }
        })
      )

      expect(store.state.message).toBe(
        'License validation is overdue. Connect to the desktop service to continue.'
      )
    })

    it('refuses a duplicate refresh while one is already in flight', async () => {
      let calls = 0
      let release: (() => void) | undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const store = useAccessStore()
      const service = refreshService({
        refresh: async () => {
          calls += 1
          await gate
          return {
            status: {
              status: 'fresh',
              isReadable: true,
              catalogValid: true,
              lastSyncedAt: null,
              contract: null
            },
            refreshedAt: '2026-01-01T02:00:00.000Z',
            previousRevision: null,
            revisionChanged: false,
            counts: {},
            access: { sell: decision(true, 'sell'), sync: decision(true, 'sync') },
            licenseValidatedAt: '2026-01-01T02:00:00+00:00'
          }
        }
      })

      const first = store.refreshWorkstation(service)
      const second = await store.refreshWorkstation(service)

      expect(second).toBe(false)
      release?.()
      await first

      expect(calls).toBe(1)
    })
  })
})
