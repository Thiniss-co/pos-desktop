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
})
