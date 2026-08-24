// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import ThemeSwitcher from './ThemeSwitcher.vue'

// ThemeSwitcher calls the theme store's setTheme() with its default (real) PreferencesService,
// which reads window.posApi.preferences — exactly like production. A minimal fake bridge stands
// in for the preload surface, following the repo's IPC-gateway-fake convention used throughout
// (see ConnectivityBanner.test.ts's fake ConnectivityGateway).
function installFakePosApi(): void {
  let stored: 'light' | 'dark' | 'system' | null = null
  Object.defineProperty(window, 'posApi', {
    configurable: true,
    value: {
      preferences: {
        getLocale: async () => ({ ok: true, data: null }),
        setLocale: async (locale: string) => ({ ok: true, data: locale }),
        getTheme: async () => ({ ok: true, data: stored }),
        setTheme: async (theme: 'light' | 'dark' | 'system') => {
          stored = theme
          return { ok: true, data: theme }
        }
      }
    }
  })
}

describe('ThemeSwitcher', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    i18n.global.locale.value = 'en'
    installFakePosApi()
  })

  afterEach(() => {
    // @ts-expect-error -- test-only cleanup of a fake global
    delete window.posApi
  })

  it('renders three options in English and marks the current preference pressed', () => {
    const wrapper = mount(ThemeSwitcher, { global: { plugins: [i18n] } })

    const buttons = wrapper.findAll('button')
    expect(buttons.map((button) => button.text())).toEqual(['Light', 'Dark', 'System'])
    expect(wrapper.get('[role="group"]').attributes('aria-label')).toBe('Theme')

    const systemButton = buttons.find((button) => button.text() === 'System')
    expect(systemButton?.attributes('aria-pressed')).toBe('true')
  })

  it('renders in Arabic with no raw translation keys', () => {
    i18n.global.locale.value = 'ar'
    const wrapper = mount(ThemeSwitcher, { global: { plugins: [i18n] } })

    expect(wrapper.text()).not.toContain('theme.')
    expect(wrapper.get('[role="group"]').attributes('aria-label')).toBe('المظهر')

    i18n.global.locale.value = 'en'
  })

  it('selecting an option persists it and updates the pressed state', async () => {
    const wrapper = mount(ThemeSwitcher, { global: { plugins: [i18n] } })

    const darkButton = wrapper.findAll('button').find((button) => button.text() === 'Dark')
    await darkButton?.trigger('click')
    await wrapper.vm.$nextTick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    expect(darkButton?.attributes('aria-pressed')).toBe('true')
  })

  it('disables every option while a save is in flight', async () => {
    const wrapper = mount(ThemeSwitcher, { global: { plugins: [i18n] } })

    const darkButton = wrapper.findAll('button').find((button) => button.text() === 'Dark')
    const clickPromise = darkButton?.trigger('click')
    await wrapper.vm.$nextTick()

    for (const button of wrapper.findAll('button')) {
      expect(button.attributes('disabled')).toBeDefined()
    }

    await clickPromise
  })
})
