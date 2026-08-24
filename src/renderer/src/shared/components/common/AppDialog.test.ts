// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AppDialog from './AppDialog.vue'

describe('AppDialog', () => {
  let trigger: HTMLButtonElement

  beforeEach(() => {
    trigger = document.createElement('button')
    trigger.textContent = 'Open'
    document.body.appendChild(trigger)
    trigger.focus()
  })

  afterEach(() => {
    trigger.remove()
  })

  it('renders nothing when closed, and a role=dialog labelled by its title when open', async () => {
    const wrapper = mount(AppDialog, {
      props: { open: false },
      slots: { title: 'Confirm', default: 'Body text' },
      attachTo: document.body
    })

    expect(document.querySelector('[role="dialog"]')).toBeNull()

    await wrapper.setProps({ open: true })
    await wrapper.vm.$nextTick()

    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
    const labelledby = dialog?.getAttribute('aria-labelledby')
    expect(document.getElementById(labelledby ?? '')?.textContent).toBe('Confirm')

    wrapper.unmount()
  })

  it('moves focus into the dialog on open and restores it to the trigger on close', async () => {
    const wrapper = mount(AppDialog, {
      props: { open: false },
      slots: {
        title: 'Confirm',
        default: 'Body text',
        actions: '<button id="confirm-btn">Confirm</button>'
      },
      attachTo: document.body
    })

    expect(document.activeElement).toBe(trigger)

    await wrapper.setProps({ open: true })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(document.activeElement).not.toBe(trigger)
    expect(document.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true)

    await wrapper.setProps({ open: false })
    await wrapper.vm.$nextTick()

    expect(document.activeElement).toBe(trigger)

    wrapper.unmount()
  })

  it('emits close on Escape', async () => {
    const wrapper = mount(AppDialog, {
      props: { open: true },
      slots: { title: 'Confirm', default: 'Body text' },
      attachTo: document.body
    })
    await wrapper.vm.$nextTick()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(wrapper.emitted('close')).toHaveLength(1)

    wrapper.unmount()
  })
})
