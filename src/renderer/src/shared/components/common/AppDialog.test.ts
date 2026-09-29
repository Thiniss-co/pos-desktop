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

  it('becomes a full-screen compact sheet only with sheet="compact"', async () => {
    const regular = mount(AppDialog, {
      props: { open: true, size: 'xl' },
      slots: { title: 'Payment', default: 'Body', actions: '<button>Complete</button>' },
      attachTo: document.body
    })
    await regular.vm.$nextTick()

    const SHEET_PANEL = [
      'app-dialog--sheet',
      'max-wide:h-full',
      'max-wide:max-h-none',
      'max-wide:max-w-none',
      'max-wide:rounded-none',
      'short:h-full',
      'short:max-h-none',
      'short:max-w-none',
      'short:rounded-none'
    ]
    let scrim = document.querySelector('.app-dialog__scrim') as HTMLElement
    let panel = document.querySelector('.app-dialog') as HTMLElement
    for (const name of SHEET_PANEL) {
      expect(panel.classList.contains(name), name).toBe(false)
    }
    expect(scrim.classList.contains('short:p-0')).toBe(false)
    regular.unmount()

    const sheet = mount(AppDialog, {
      props: { open: true, size: 'xl', sheet: 'compact' },
      slots: { title: 'Payment', default: 'Body', actions: '<button>Complete</button>' },
      attachTo: document.body
    })
    await sheet.vm.$nextTick()

    scrim = document.querySelector('.app-dialog__scrim') as HTMLElement
    panel = document.querySelector('.app-dialog') as HTMLElement
    for (const name of SHEET_PANEL) {
      expect(panel.classList.contains(name), name).toBe(true)
    }
    expect(scrim.classList.contains('max-wide:p-0')).toBe(true)
    expect(scrim.classList.contains('short:p-0')).toBe(true)
    // Wide and tall viewports keep the regular xl dialog.
    expect(panel.classList.contains('max-w-[1040px]')).toBe(true)
    expect(panel.classList.contains('rounded-xl')).toBe(true)
    // Header and footer never scroll; the body is the only scrolling region.
    expect(panel.querySelector('.app-dialog__header')?.classList.contains('flex-none')).toBe(true)
    expect(panel.querySelector('.app-dialog__actions')?.classList.contains('flex-none')).toBe(true)
    const body = panel.querySelector('.app-dialog__body') as HTMLElement
    for (const name of ['min-h-0', 'flex-1', 'overflow-auto', 'overscroll-contain']) {
      expect(body.classList.contains(name), name).toBe(true)
    }
    expect(panel.classList.contains('overflow-hidden')).toBe(true)

    sheet.unmount()
  })

  it('renders header-end after the spacer, before the close button, and forwards attrs to the panel', async () => {
    const wrapper = mount(AppDialog, {
      props: { open: true, closeLabel: 'Close' },
      attrs: { class: 'payment-hook', 'data-testid': 'the-dialog' },
      slots: { title: 'Payment', 'header-end': '<span id="header-end">Total</span>' },
      attachTo: document.body
    })
    await wrapper.vm.$nextTick()

    const panel = document.querySelector('.app-dialog') as HTMLElement
    expect(panel.classList.contains('payment-hook')).toBe(true)
    expect(panel.getAttribute('data-testid')).toBe('the-dialog')

    const end = panel.querySelector('#header-end') as HTMLElement
    const close = panel.querySelector('.app-dialog__header button') as HTMLElement
    expect(end.parentElement?.classList.contains('app-dialog__header')).toBe(true)
    expect(end.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    wrapper.unmount()
  })

  it('keeps Shift+Tab inside the dialog from a programmatically focused heading', async () => {
    const wrapper = mount(AppDialog, {
      props: { open: false },
      slots: {
        title: 'Payment',
        default:
          '<h3 id="heading" tabindex="-1" data-autofocus>Total</h3><button id="a">A</button>',
        actions: '<button id="b">B</button>'
      },
      attachTo: document.body
    })
    await wrapper.setProps({ open: true })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(document.activeElement?.id).toBe('heading')

    const tab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true })
    document.dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(false)

    const shiftTab = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true })
    document.dispatchEvent(shiftTab)
    expect(shiftTab.defaultPrevented).toBe(true)
    expect(document.activeElement?.id).toBe('b')

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
