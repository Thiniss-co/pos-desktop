// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { usePosShortcuts, type PosShortcutOptions } from './usePosShortcuts'

function key(
  value: string,
  init: KeyboardEventInit = {},
  target: EventTarget = document.body
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: value,
    bubbles: true,
    cancelable: true,
    ...init
  })
  target.dispatchEvent(event)
  return event
}

let wrapper: VueWrapper | null = null

function mountShortcuts(options: PosShortcutOptions): void {
  wrapper = mount(
    defineComponent({
      setup() {
        usePosShortcuts(options)
        return () => h('div')
      }
    }),
    { attachTo: document.body }
  )
}

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('usePosShortcuts', () => {
  it('keeps plain F9 and Shift+F9 distinct', () => {
    const f9 = vi.fn()
    const shiftF9 = vi.fn()
    mountShortcuts({
      focusSearch: vi.fn(),
      showHelp: vi.fn(),
      bindings: { F9: f9, ShiftF9: shiftF9 }
    })

    key('F9')
    expect(f9).toHaveBeenCalledTimes(1)
    expect(shiftF9).not.toHaveBeenCalled()

    const shifted = key('F9', { shiftKey: true })
    expect(shifted.defaultPrevented).toBe(true)
    expect(shiftF9).toHaveBeenCalledTimes(1)
    expect(f9).toHaveBeenCalledTimes(1)
  })

  it('never falls back to the F9 binding for Shift+F9 when ShiftF9 is unbound', () => {
    const f9 = vi.fn()
    mountShortcuts({ focusSearch: vi.fn(), showHelp: vi.fn(), bindings: { F9: f9 } })

    const shifted = key('F9', { shiftKey: true })
    expect(f9).not.toHaveBeenCalled()
    expect(shifted.defaultPrevented).toBe(false)
  })

  it('still lets Shift reach the other function-key bindings', () => {
    const f4 = vi.fn()
    mountShortcuts({ focusSearch: vi.fn(), showHelp: vi.fn(), bindings: { F4: f4 } })

    key('F4', { shiftKey: true })
    expect(f4).toHaveBeenCalledTimes(1)
  })

  it('fires a binding once for a held key, from an input, and never under Ctrl/Alt/Meta or a modal', () => {
    const f9 = vi.fn()
    mountShortcuts({ focusSearch: vi.fn(), showHelp: vi.fn(), bindings: { F9: f9 } })
    const input = document.createElement('input')
    document.body.append(input)

    key('F9', {}, input)
    const held = key('F9', { repeat: true }, input)
    expect(held.defaultPrevented).toBe(true)
    expect(f9).toHaveBeenCalledTimes(1)

    key('F9', { ctrlKey: true })
    key('F9', { altKey: true })
    key('F9', { metaKey: true })
    const dialog = document.createElement('div')
    dialog.setAttribute('aria-modal', 'true')
    document.body.append(dialog)
    key('F9')
    expect(f9).toHaveBeenCalledTimes(1)
  })
})
