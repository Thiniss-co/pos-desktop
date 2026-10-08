// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import TouchModeSwitch from './components/TouchModeSwitch.vue'
import { useUserPreferencesStore } from './userPreferences.store'

type Preferences = { touchMode: boolean; autoPrint: boolean }

function ok(data: Preferences): { ok: true; data: Preferences } {
  return { ok: true, data }
}

let getUser: ReturnType<typeof vi.fn>
let setUser: ReturnType<typeof vi.fn>

beforeEach(() => {
  setActivePinia(createPinia())
  getUser = vi.fn().mockResolvedValue(ok({ touchMode: false, autoPrint: true }))
  setUser = vi.fn(async ({ value }: { key: string; value: boolean }) =>
    ok({ touchMode: value, autoPrint: true })
  )
  ;(window as unknown as { posApi: unknown }).posApi = { preferences: { getUser, setUser } }
})

afterEach(() => {
  delete document.documentElement.dataset.touch
})

describe('touch mode (POS improvements, Stage 5)', () => {
  it("turns the touch layout on and off through main's stored answer", async () => {
    const store = useUserPreferencesStore()

    await store.set('ui.touchMode', true)
    expect(setUser).toHaveBeenCalledWith({ key: 'ui.touchMode', value: true })
    expect(document.documentElement.dataset.touch).toBe('on')

    await store.set('ui.touchMode', false)
    expect(document.documentElement.dataset.touch).toBeUndefined()
  })

  it('keeps the current layout and reports a failed write', async () => {
    const store = useUserPreferencesStore()
    await store.set('ui.touchMode', true)
    setUser.mockRejectedValueOnce(new Error('main refused'))

    await store.set('ui.touchMode', false)

    expect(store.failed).toBe(true)
    expect(document.documentElement.dataset.touch).toBe('on')
  })

  it('never lets a slow answer for a signed-out user switch the layout back on', async () => {
    const store = useUserPreferencesStore()
    let answer: (value: unknown) => void = () => undefined
    setUser.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))

    const pending = store.set('ui.touchMode', true)
    store.reset()
    answer(ok({ touchMode: true, autoPrint: true }))
    await pending

    expect(document.documentElement.dataset.touch).toBeUndefined()
    expect(store.preferences.touchMode).toBe(false)
  })

  it('the switch reflects and flips the stored value', async () => {
    const i18n = createI18n({
      legacy: false,
      locale: 'en',
      missingWarn: false,
      fallbackWarn: false
    })
    const wrapper = mount(TouchModeSwitch, { global: { plugins: [i18n] } })
    const control = wrapper.get('[data-testid="touch-mode-switch"]')

    expect(control.attributes('aria-checked')).toBe('false')
    await control.trigger('click')
    await flushPromises()

    expect(setUser).toHaveBeenLastCalledWith({ key: 'ui.touchMode', value: true })
    expect(control.attributes('aria-checked')).toBe('true')
    expect(document.documentElement.dataset.touch).toBe('on')
  })
})
