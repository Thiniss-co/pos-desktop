import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import { useDeviceStore } from './store'

describe('useDeviceStore device recovery message', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    i18n.global.locale.value = 'en'
  })

  afterEach(() => {
    i18n.global.locale.value = 'en'
  })

  it('keeps the device-recovery message localized and reactive', () => {
    const store = useDeviceStore()
    store.setDeviceRecoveryMessage()

    expect(store.error).toBe(
      'This device must be activated again before the workstation can continue.'
    )

    i18n.global.locale.value = 'ar'

    expect(store.error).toBe('يجب تفعيل هذا الجهاز مرة أخرى قبل أن تتمكن محطة العمل من المتابعة.')
  })
})
