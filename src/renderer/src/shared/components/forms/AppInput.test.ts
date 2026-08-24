// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AppInput from './AppInput.vue'

describe('AppInput', () => {
  it('pairs the label with the input via a real for/id relationship', () => {
    const wrapper = mount(AppInput, { props: { modelValue: '', label: 'Email' } })

    const label = wrapper.get('label')
    const input = wrapper.get('input')
    expect(label.attributes('for')).toBe(input.attributes('id'))
    expect(label.text()).toContain('Email')
  })

  it('emits update:modelValue as the user types, without mutating the prop itself', async () => {
    const wrapper = mount(AppInput, { props: { modelValue: '', label: 'Email' } })

    await wrapper.get('input').setValue('cashier@example.com')

    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['cashier@example.com'])
  })

  it('marks the field invalid and wires aria-describedby to the error, as role=alert', async () => {
    const wrapper = mount(AppInput, {
      props: { modelValue: '', label: 'Email', error: 'Email is required' }
    })

    const input = wrapper.get('input')
    expect(input.attributes('aria-invalid')).toBe('true')

    const error = wrapper.get('[role="alert"]')
    expect(error.text()).toBe('Email is required')
    expect(input.attributes('aria-describedby')).toContain(error.attributes('id'))
  })

  it('hides the hint once an error is present, so only one is announced', () => {
    const wrapper = mount(AppInput, {
      props: {
        modelValue: '',
        label: 'Email',
        hint: 'We only use this for receipts',
        error: 'Required'
      }
    })

    expect(wrapper.text()).not.toContain('We only use this for receipts')
  })

  it('disables the control and required stays wired through', () => {
    const wrapper = mount(AppInput, {
      props: { modelValue: '', label: 'Email', disabled: true, required: true }
    })

    const input = wrapper.get('input')
    expect(input.attributes('disabled')).toBeDefined()
    expect(input.attributes('required')).toBeDefined()
  })
})
