// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AppButton from './AppButton.vue'

describe('AppButton', () => {
  it('renders a real <button> and forwards clicks as a custom event', async () => {
    const wrapper = mount(AppButton, { slots: { default: 'Save changes' } })

    expect(wrapper.element.tagName).toBe('BUTTON')
    expect(wrapper.text()).toBe('Save changes')

    await wrapper.trigger('click')
    expect(wrapper.emitted('click')).toHaveLength(1)
  })

  it('disables the button and marks it aria-busy while loading, without firing click', async () => {
    const wrapper = mount(AppButton, { props: { loading: true } })

    expect(wrapper.attributes('disabled')).toBeDefined()
    expect(wrapper.attributes('aria-busy')).toBe('true')

    await wrapper.trigger('click')
    expect(wrapper.emitted('click')).toBeUndefined()
  })

  it('disables the button when explicitly disabled, independent of loading', () => {
    const wrapper = mount(AppButton, { props: { disabled: true } })

    expect(wrapper.attributes('disabled')).toBeDefined()
    expect(wrapper.attributes('aria-busy')).toBeUndefined()
  })

  it('renders every documented variant with its own class', () => {
    const variants = ['primary', 'secondary', 'transaction', 'ghost', 'danger'] as const

    for (const variant of variants) {
      const wrapper = mount(AppButton, { props: { variant } })
      expect(wrapper.classes()).toContain(`app-button--${variant}`)
    }
  })

  it('submits a form via type="submit"', () => {
    const wrapper = mount(AppButton, { props: { type: 'submit' } })
    expect(wrapper.attributes('type')).toBe('submit')
  })
})
