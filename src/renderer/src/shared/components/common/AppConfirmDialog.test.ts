// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AppConfirmDialog from './AppConfirmDialog.vue'

describe('AppConfirmDialog', () => {
  it('emits confirm and cancel from their respective buttons, never a real transaction side effect', async () => {
    const wrapper = mount(AppConfirmDialog, {
      props: {
        open: true,
        title: 'Disable user?',
        message: 'This prevents sign-in.',
        confirmLabel: 'Disable',
        cancelLabel: 'Cancel'
      },
      attachTo: document.body
    })
    await wrapper.vm.$nextTick()

    const buttons = document.querySelectorAll('[role="dialog"] button')
    const cancelButton = Array.from(buttons).find((el) => el.textContent?.trim() === 'Cancel')
    const confirmButton = Array.from(buttons).find((el) => el.textContent?.trim() === 'Disable')

    cancelButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(wrapper.emitted('cancel')).toHaveLength(1)

    confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(wrapper.emitted('confirm')).toHaveLength(1)

    wrapper.unmount()
  })

  it('disables both actions while loading so a second click cannot double-submit', async () => {
    const wrapper = mount(AppConfirmDialog, {
      props: {
        open: true,
        title: 'Disable user?',
        message: 'This prevents sign-in.',
        confirmLabel: 'Disable',
        cancelLabel: 'Cancel',
        loading: true
      },
      attachTo: document.body
    })
    await wrapper.vm.$nextTick()

    const buttons = document.querySelectorAll('[role="dialog"] button')
    for (const button of buttons) {
      expect(button.hasAttribute('disabled')).toBe(true)
    }

    wrapper.unmount()
  })

  it('defaults to the danger variant for a destructive confirmation', () => {
    const wrapper = mount(AppConfirmDialog, {
      props: {
        open: true,
        title: 'Disable user?',
        message: 'This prevents sign-in.',
        confirmLabel: 'Disable',
        cancelLabel: 'Cancel'
      }
    })

    expect(wrapper.props('variant')).toBe('danger')
  })
})
