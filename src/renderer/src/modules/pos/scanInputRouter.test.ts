// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import {
  createScanInputRouter,
  useScanInputRouter,
  type ScanInputMode,
  type ScanInputRouter,
  type ScanInputRouterOptions
} from './scanInputRouter'

/*
 * Real KeyboardEvents dispatched on real targets, observed by the router's window capture-phase
 * listeners. happy-dom does not synthesize a browser's key activation, so `press()` does it the
 * way Chromium does, and ONLY when the router left the event's default alone:
 * - keydown Enter on a focused <button> → click
 * - keyup Space on a focused <button> (keydown and keyup both un-prevented) → click
 * - a printable keydown in an <input> → the character is inserted (+ an `input` event)
 * A click spy on the button therefore proves whether a key could have activated it.
 */

let clock = 0

function codeFor(key: string): string {
  if (key === ' ') return 'Space'
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`
  if (/^\d$/.test(key)) return `Digit${key}`
  if (key.length > 1) return key
  return ''
}

function dispatch(
  type: 'keydown' | 'keyup',
  target: EventTarget,
  init: KeyboardEventInit
): KeyboardEvent {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

function press(
  target: HTMLElement,
  key: string,
  init: KeyboardEventInit = {},
  gapMs = 5
): { down: KeyboardEvent; up: KeyboardEvent } {
  clock += gapMs
  const full = { key, code: codeFor(key), ...init }
  const down = dispatch('keydown', target, full)
  if (!down.defaultPrevented) {
    if (target instanceof HTMLButtonElement && key === 'Enter') {
      target.click()
    } else if (target instanceof HTMLInputElement && key.length === 1 && !init.ctrlKey) {
      target.value += key
      target.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }
  const up = dispatch('keyup', target, full)
  if (
    key === ' ' &&
    target instanceof HTMLButtonElement &&
    !down.defaultPrevented &&
    !up.defaultPrevented
  ) {
    target.click()
  }
  return { down, up }
}

/** A keyboard-wedge scanner: uppercase letters arrive as Shift keydown + the character. */
function scan(
  target: HTMLElement,
  text: string,
  suffix: 'Enter' | 'Tab' | null = 'Enter',
  gapMs = 5
): KeyboardEvent[] {
  const downs: KeyboardEvent[] = []
  for (const character of text) {
    const upper = /[A-Z]/.test(character)
    if (upper) {
      clock += 1
      dispatch('keydown', target, { key: 'Shift', code: 'ShiftLeft', shiftKey: true })
    }
    downs.push(press(target, character, { shiftKey: upper }, gapMs).down)
    if (upper) {
      dispatch('keyup', target, { key: 'Shift', code: 'ShiftLeft' })
    }
  }
  if (suffix) {
    downs.push(press(target, suffix, {}, gapMs).down)
  }
  return downs
}

function commitButton(action: string): {
  button: HTMLButtonElement
  clicks: ReturnType<typeof vi.fn>
} {
  const button = document.createElement('button')
  button.type = 'button'
  button.dataset.commitAction = action
  const inner = document.createElement('span')
  inner.textContent = action
  button.append(inner)
  document.body.append(button)
  const clicks = vi.fn()
  button.addEventListener('click', clicks)
  button.focus()
  return { button, clicks }
}

function plainButton(): { button: HTMLButtonElement; clicks: ReturnType<typeof vi.fn> } {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = 'Cash'
  document.body.append(button)
  const clicks = vi.fn()
  button.addEventListener('click', clicks)
  button.focus()
  return { button, clicks }
}

let mode: ScanInputMode
let router: ScanInputRouter | null
const spies = {
  onScan: vi.fn(),
  onDoneCode: vi.fn(),
  onPrimary: vi.fn(),
  onExactCash: vi.fn(),
  onPrint: vi.fn(),
  onEscape: vi.fn(),
  onScannerIgnored: vi.fn(),
  onCollectingChange: vi.fn(),
  onFieldBurstReverted: vi.fn()
}

function createRouter(overrides: Partial<ScanInputRouterOptions> = {}): ScanInputRouter {
  router = createScanInputRouter({
    mode: () => mode,
    ...spies,
    now: () => clock,
    ownsKeyboard: () => false,
    doneIdleCompleteMs: null,
    ...overrides
  })
  return router
}

async function flushQueue(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve()
  }
}

beforeEach(() => {
  clock = 1000
  router = null
  for (const spy of Object.values(spies)) {
    spy.mockReset()
  }
})

afterEach(() => {
  router?.dispose()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('scanInputRouter — commit-class suppression', () => {
  const actions = ['complete', 'exact-cash', 'print', 'acknowledge'] as const

  for (const action of actions) {
    for (const suffix of ['Enter', 'Tab'] as const) {
      it(`payment-done: a scan with a Space and a ${suffix} suffix never clicks a focused "${action}" and is delivered once`, async () => {
        mode = 'payment-done'
        createRouter()
        const { button, clicks } = commitButton(action)

        const downs = scan(button, 'SKU 12345', suffix)
        await flushQueue()

        expect(clicks).not.toHaveBeenCalled()
        expect(downs.every((event) => event.defaultPrevented)).toBe(true)
        expect(spies.onDoneCode).toHaveBeenCalledTimes(1)
        expect(spies.onDoneCode).toHaveBeenCalledWith('SKU 12345')
        expect(spies.onPrimary).not.toHaveBeenCalled()
        expect(spies.onPrint).not.toHaveBeenCalled()
        expect(router?.isCollecting()).toBe(false)
      })
    }
  }

  for (const action of ['complete', 'exact-cash'] as const) {
    for (const suffix of ['Enter', 'Tab'] as const) {
      it(`payment-tender: a scan with a Space and a ${suffix} suffix never clicks a focused "${action}"`, async () => {
        mode = 'payment-tender'
        createRouter()
        const { button, clicks } = commitButton(action)

        scan(button, 'SKU 12345', suffix)
        await flushQueue()

        expect(clicks).not.toHaveBeenCalled()
        expect(spies.onScannerIgnored).toHaveBeenCalledTimes(1)
        expect(spies.onDoneCode).not.toHaveBeenCalled()
        expect(spies.onScan).not.toHaveBeenCalled()
      })
    }
  }

  for (const action of ['retry', 'confirm-abandon'] as const) {
    it(`payment-other: Enter and Space never click a focused "${action}"`, () => {
      mode = 'payment-other'
      createRouter()
      const { button, clicks } = commitButton(action)

      scan(button, 'AB 12', 'Enter')
      press(button, ' ')
      press(button, 'Enter')

      expect(clicks).not.toHaveBeenCalled()
    })
  }

  it('suppresses keyboard Enter/Space (incl. NumpadEnter and auto-repeat) but never a pointer click', () => {
    mode = 'payment-tender'
    createRouter()
    const { button, clicks } = commitButton('complete')

    const enter = press(button, 'Enter')
    const numpad = press(button, 'Enter', { code: 'NumpadEnter' })
    const space = press(button, ' ')
    const held = press(button, 'Enter', { repeat: true })
    expect(enter.down.defaultPrevented).toBe(true)
    expect(numpad.down.defaultPrevented).toBe(true)
    expect(space.down.defaultPrevented).toBe(true)
    expect(space.up.defaultPrevented).toBe(true)
    expect(held.down.defaultPrevented).toBe(true)
    expect(clicks).not.toHaveBeenCalled()

    button.click()
    expect(clicks).toHaveBeenCalledTimes(1)
  })

  it('stops the suppressed key before it reaches a handler on the control itself', () => {
    mode = 'payment-done'
    createRouter()
    const { button } = commitButton('acknowledge')
    const own = vi.fn()
    button.addEventListener('keydown', own)

    press(button, 'Enter')
    press(button, ' ')

    expect(own).not.toHaveBeenCalled()
  })
})

describe('scanInputRouter — payment-done', () => {
  beforeEach(() => {
    mode = 'payment-done'
  })

  it('keeps two back-to-back codes in order', async () => {
    createRouter()
    const { button, clicks } = commitButton('acknowledge')

    scan(button, 'ABC123', 'Enter')
    scan(button, 'XYZ 789', 'Tab')
    await flushQueue()

    expect(spies.onDoneCode.mock.calls).toEqual([['ABC123'], ['XYZ 789']])
    expect(clicks).not.toHaveBeenCalled()
  })

  it('serializes an async onDoneCode handler', async () => {
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    createRouter({
      onDoneCode: async (code) => {
        if (code === 'FIRST1') {
          await gate
        }
        order.push(code)
      }
    })
    const { button } = commitButton('acknowledge')

    scan(button, 'FIRST1')
    scan(button, 'SECOND2')
    await flushQueue()
    expect(order).toEqual([])
    release()
    await vi.waitFor(() => expect(order).toEqual(['FIRST1', 'SECOND2']))
  })

  it('reports collection start and end', () => {
    createRouter()
    const { button } = commitButton('acknowledge')

    press(button, 'A')
    expect(router?.isCollecting()).toBe(true)
    expect(spies.onCollectingChange.mock.calls).toEqual([[true]])
    press(button, 'B')
    press(button, 'C')
    press(button, 'Enter')
    expect(spies.onCollectingChange.mock.calls).toEqual([[true], [false]])
  })

  it('never consumes Tab or Shift+Tab when not collecting', () => {
    createRouter()
    const { button } = commitButton('acknowledge')

    expect(press(button, 'Tab').down.defaultPrevented).toBe(false)
    expect(press(button, 'Tab', { shiftKey: true }).down.defaultPrevented).toBe(false)
    expect(router?.isCollecting()).toBe(false)
  })

  it('Escape discards a partial; a second Escape reaches onEscape', async () => {
    createRouter()
    const { button } = commitButton('acknowledge')

    press(button, 'A')
    press(button, 'B')
    const first = press(button, 'Escape')
    expect(first.down.defaultPrevented).toBe(true)
    expect(spies.onEscape).not.toHaveBeenCalled()
    expect(router?.isCollecting()).toBe(false)
    expect(spies.onCollectingChange.mock.calls).toEqual([[true], [false]])

    press(button, 'Escape')
    expect(spies.onEscape).toHaveBeenCalledTimes(1)

    press(button, 'Enter')
    await flushQueue()
    expect(spies.onDoneCode).not.toHaveBeenCalled()
    expect(spies.onScannerIgnored).not.toHaveBeenCalled()
  })

  it('leaves Escape native when onEscape is not provided (and not collecting)', () => {
    createRouter({ onEscape: undefined })
    const { button } = commitButton('acknowledge')

    expect(press(button, 'Escape').down.defaultPrevented).toBe(false)
  })

  it('drops input shorter than the minimum length with a scanner notice', async () => {
    createRouter()
    const { button, clicks } = commitButton('acknowledge')

    scan(button, 'AB', 'Enter')
    await flushQueue()

    expect(spies.onDoneCode).not.toHaveBeenCalled()
    expect(spies.onScannerIgnored).toHaveBeenCalledTimes(1)
    expect(clicks).not.toHaveBeenCalled()
  })

  it('F9 during a collection discards the partial, then acts', async () => {
    createRouter()
    const { button } = commitButton('acknowledge')

    scan(button, 'AB1', null)
    const f9 = press(button, 'F9')
    press(button, 'Enter')
    await flushQueue()

    expect(f9.down.defaultPrevented).toBe(true)
    expect(spies.onScannerIgnored).toHaveBeenCalledTimes(1)
    expect(spies.onPrimary).toHaveBeenCalledTimes(1)
    expect(spies.onDoneCode).not.toHaveBeenCalled()
  })

  it('Ctrl+P during a collection discards the partial, then prints', async () => {
    createRouter()
    const { button } = commitButton('print')

    scan(button, 'AB1', null)
    const print = press(button, 'p', { ctrlKey: true })
    await flushQueue()

    expect(print.down.defaultPrevented).toBe(true)
    expect(spies.onScannerIgnored).toHaveBeenCalledTimes(1)
    expect(spies.onPrint).toHaveBeenCalledTimes(1)
    expect(spies.onDoneCode).not.toHaveBeenCalled()
  })

  it('Ctrl+P is matched by physical key under a non-Latin layout', () => {
    createRouter()
    const { button } = commitButton('print')

    press(button, 'ح', { ctrlKey: true, code: 'KeyP' })
    expect(spies.onPrint).toHaveBeenCalledTimes(1)
  })

  it('a leading Space starts nothing and stays native on an ordinary control', () => {
    createRouter()
    const { button, clicks } = plainButton()

    const space = press(button, ' ')
    expect(space.down.defaultPrevented).toBe(false)
    expect(router?.isCollecting()).toBe(false)
    expect(clicks).toHaveBeenCalledTimes(1)
  })

  it('ignores an auto-repeated Enter while collecting', async () => {
    createRouter()
    const { button } = commitButton('acknowledge')

    scan(button, 'ABC', null)
    press(button, 'Enter', { repeat: true })
    await flushQueue()
    expect(spies.onDoneCode).not.toHaveBeenCalled()
    expect(router?.isCollecting()).toBe(true)

    press(button, 'Enter')
    await flushQueue()
    expect(spies.onDoneCode).toHaveBeenCalledWith('ABC')
  })

  it('Shift+F9 is not F9 here', () => {
    createRouter()
    const { button } = commitButton('acknowledge')

    press(button, 'F9', { shiftKey: true })
    expect(spies.onPrimary).not.toHaveBeenCalled()
    expect(spies.onExactCash).not.toHaveBeenCalled()
  })

  it('completes a suffix-less scan after the idle window, but never after the mode moved on', async () => {
    vi.useFakeTimers()
    createRouter({ doneIdleCompleteMs: 150 })
    const { button } = commitButton('acknowledge')

    scan(button, 'ABC123', null)
    vi.advanceTimersByTime(150)
    await flushQueue()
    expect(spies.onDoneCode).toHaveBeenCalledWith('ABC123')

    scan(button, 'LATE99', null)
    mode = 'page'
    vi.advanceTimersByTime(150)
    await flushQueue()
    expect(spies.onDoneCode).toHaveBeenCalledTimes(1)
  })
})

describe('scanInputRouter — payment-tender', () => {
  beforeEach(() => {
    mode = 'payment-tender'
  })

  it('swallows printable keys on controls and reports the scan after its terminator', () => {
    createRouter()
    const { button, clicks } = plainButton()

    const downs = scan(button, '12345', 'Enter')

    expect(downs.every((event) => event.defaultPrevented)).toBe(true)
    expect(clicks).not.toHaveBeenCalled()
    expect(spies.onScannerIgnored).toHaveBeenCalledTimes(1)
  })

  it('keeps native Enter and Space on a non-commit control when nothing was swallowed', () => {
    createRouter()
    const { button, clicks } = plainButton()

    const enter = press(button, 'Enter')
    const space = press(button, ' ')

    expect(enter.down.defaultPrevented).toBe(false)
    expect(space.down.defaultPrevented).toBe(false)
    expect(space.up.defaultPrevented).toBe(false)
    expect(clicks).toHaveBeenCalledTimes(2)
    expect(spies.onScannerIgnored).not.toHaveBeenCalled()
  })

  it('Escape drops swallowed keys, so a later Enter is native again', () => {
    createRouter()
    const { button, clicks } = plainButton()

    press(button, 'a')
    press(button, 'Escape')
    press(button, 'Enter')

    expect(clicks).toHaveBeenCalledTimes(1)
    expect(spies.onScannerIgnored).not.toHaveBeenCalled()
  })

  it('reverts a fast burst ending in Enter in the amount field', () => {
    createRouter()
    const input = document.createElement('input')
    input.value = '10.00'
    document.body.append(input)
    input.focus()
    const inputEvents = vi.fn()
    input.addEventListener('input', () => inputEvents(input.value))
    const fieldEnter = vi.fn()
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') fieldEnter()
    })

    const downs = scan(input, '4006381333931', 'Enter', 10)
    const enter = downs[downs.length - 1]

    expect(enter.defaultPrevented).toBe(true)
    expect(fieldEnter).not.toHaveBeenCalled()
    expect(input.value).toBe('10.00')
    expect(inputEvents).toHaveBeenLastCalledWith('10.00')
    expect(spies.onFieldBurstReverted).toHaveBeenCalledTimes(1)
  })

  it('does not revert slow typing (gaps over 30 ms)', () => {
    createRouter()
    const input = document.createElement('input')
    document.body.append(input)

    const downs = scan(input, '123456', 'Enter', 40)

    expect(downs[downs.length - 1].defaultPrevented).toBe(false)
    expect(input.value).toBe('123456')
    expect(spies.onFieldBurstReverted).not.toHaveBeenCalled()
  })

  it('does not revert a fast burst shorter than six characters', () => {
    createRouter()
    const input = document.createElement('input')
    document.body.append(input)

    const downs = scan(input, '12345', 'Enter', 5)

    expect(downs[downs.length - 1].defaultPrevented).toBe(false)
    expect(input.value).toBe('12345')
  })

  it('never touches IME composition', () => {
    createRouter()
    const input = document.createElement('input')
    document.body.append(input)

    scan(input, '123456', null, 5)
    const composing = press(input, 'Enter', { isComposing: true }, 5)
    const processKey = press(input, 'Process', { keyCode: 229 }, 5)

    expect(composing.down.defaultPrevented).toBe(false)
    expect(processKey.down.defaultPrevented).toBe(false)
    expect(spies.onFieldBurstReverted).not.toHaveBeenCalled()
  })

  it('ignores an auto-repeated Enter at the end of a burst', () => {
    createRouter()
    const input = document.createElement('input')
    document.body.append(input)

    scan(input, '123456', null, 5)
    const held = press(input, 'Enter', { repeat: true }, 5)

    expect(held.down.defaultPrevented).toBe(false)
    expect(spies.onFieldBurstReverted).not.toHaveBeenCalled()
  })

  it('F9 and Shift+F9 are distinct and work from an editable field', () => {
    createRouter()
    const input = document.createElement('input')
    document.body.append(input)

    const f9 = press(input, 'F9')
    const shiftF9 = press(input, 'F9', { shiftKey: true })
    press(input, 'F9', { repeat: true })

    expect(f9.down.defaultPrevented).toBe(true)
    expect(shiftF9.down.defaultPrevented).toBe(true)
    expect(spies.onPrimary).toHaveBeenCalledTimes(1)
    expect(spies.onExactCash).toHaveBeenCalledTimes(1)
  })
})

describe('scanInputRouter — page mode', () => {
  beforeEach(() => {
    mode = 'page'
  })

  it('delivers an uppercase code intact across Shift and CapsLock keydowns', async () => {
    createRouter()

    scan(document.body, 'AbC-12', null)
    dispatch('keydown', document.body, { key: 'CapsLock', code: 'CapsLock' })
    scan(document.body, 'XY', 'Enter')
    await vi.waitFor(() => expect(spies.onScan).toHaveBeenCalledWith('AbC-12XY'))
    expect(spies.onScan).toHaveBeenCalledTimes(1)
  })

  it('delivers rapid consecutive scans in order through a serialized queue', async () => {
    const order: string[] = []
    createRouter({
      onScan: async (code) => {
        await new Promise((resolve) => setTimeout(resolve, code === 'ALPHA1' ? 20 : 0))
        order.push(code)
      }
    })

    scan(document.body, 'ALPHA1')
    scan(document.body, 'BETA22')
    scan(document.body, 'GAMMA3')
    await vi.waitFor(() => expect(order).toEqual(['ALPHA1', 'BETA22', 'GAMMA3']))
  })

  it('a Space inside a scan never activates the focused page control', async () => {
    createRouter()
    const { button, clicks } = plainButton()

    scan(button, 'AB 12', 'Enter')
    await vi.waitFor(() => expect(spies.onScan).toHaveBeenCalledWith('AB 12'))
    expect(clicks).not.toHaveBeenCalled()
  })

  it('accepts a Tab suffix', async () => {
    createRouter()

    const downs = scan(document.body, '12345', 'Tab')
    expect(downs[downs.length - 1].defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(spies.onScan).toHaveBeenCalledWith('12345'))
  })

  it('leaves plain F9 to the page shortcuts and routes Shift+F9 to onExactCash', () => {
    createRouter()

    const f9 = press(document.body, 'F9')
    const shiftF9 = press(document.body, 'F9', { shiftKey: true })

    expect(f9.down.defaultPrevented).toBe(false)
    expect(spies.onPrimary).not.toHaveBeenCalled()
    expect(shiftF9.down.defaultPrevented).toBe(true)
    expect(spies.onExactCash).toHaveBeenCalledTimes(1)
  })

  it('pauses while another surface owns the keyboard', async () => {
    createRouter({ ownsKeyboard: () => true })

    scan(document.body, '12345', 'Enter')
    press(document.body, 'F9', { shiftKey: true })
    await flushQueue()

    expect(spies.onScan).not.toHaveBeenCalled()
    expect(spies.onExactCash).not.toHaveBeenCalled()
  })

  it('ignores editable targets and Ctrl/Alt/Meta combinations, like useBarcodeScanner', async () => {
    createRouter()
    const input = document.createElement('input')
    document.body.append(input)

    scan(input, '12345', 'Enter')
    for (const character of '67890') {
      press(document.body, character, { ctrlKey: true })
    }
    press(document.body, 'Enter')
    await flushQueue()

    expect(spies.onScan).not.toHaveBeenCalled()
  })
})

describe('scanInputRouter — lifecycle', () => {
  it('a mode change discards a partial collection', () => {
    mode = 'payment-done'
    createRouter()
    const { button } = commitButton('acknowledge')

    press(button, 'A')
    expect(router?.isCollecting()).toBe(true)
    mode = 'page'
    press(document.body, 'Shift')
    expect(router?.isCollecting()).toBe(false)
    expect(spies.onCollectingChange.mock.calls).toEqual([[true], [false]])
  })

  it('inactive mode is hands-off', () => {
    mode = 'inactive'
    createRouter()
    const { button, clicks } = commitButton('complete')

    press(button, 'Enter')
    press(button, 'F9')
    expect(clicks).toHaveBeenCalledTimes(1)
    expect(spies.onPrimary).not.toHaveBeenCalled()
  })

  it('dispose removes both listeners', () => {
    mode = 'payment-tender'
    const created = createRouter()
    const { button, clicks } = commitButton('complete')

    created.dispose()
    router = null
    press(button, 'Enter')
    press(button, 'F9')
    expect(clicks).toHaveBeenCalledTimes(1)
    expect(spies.onPrimary).not.toHaveBeenCalled()
  })

  it('useScanInputRouter attaches on mount, mirrors collecting, and detaches on unmount', async () => {
    mode = 'payment-done'
    const holder: { api?: ReturnType<typeof useScanInputRouter> } = {}
    const Host = defineComponent({
      setup() {
        holder.api = useScanInputRouter({
          mode: () => mode,
          ...spies,
          now: () => clock,
          doneIdleCompleteMs: null
        })
        return () => h('div')
      }
    })
    const wrapper = mount(Host, { attachTo: document.body })
    const { button } = commitButton('acknowledge')

    press(button, 'A')
    expect(holder.api?.collecting.value).toBe(true)
    press(button, 'Escape')
    expect(holder.api?.collecting.value).toBe(false)

    wrapper.unmount()
    press(button, 'F9')
    expect(spies.onPrimary).not.toHaveBeenCalled()
  })
})

describe('scanInputRouter — layout-edit (POS workspace layout editor)', () => {
  for (const suffix of ['Enter', 'Tab'] as const) {
    it(`a scan with a Space and a ${suffix} suffix never activates the focused editor button and is delivered once`, async () => {
      mode = 'layout-edit'
      createRouter()
      const { button, clicks } = plainButton()

      const downs = scan(button, 'SKU 12345', suffix)
      await flushQueue()

      expect(clicks).not.toHaveBeenCalled()
      expect(downs.at(-1)?.defaultPrevented).toBe(true)
      expect(spies.onScan).toHaveBeenCalledTimes(1)
      expect(spies.onScan).toHaveBeenCalledWith('SKU 12345')
    })
  }

  it('a suffix-less scan is delivered by the completion timer and activates nothing', async () => {
    vi.useFakeTimers()
    mode = 'layout-edit'
    createRouter()
    const { button, clicks } = plainButton()

    scan(button, '6291000000001', null)
    vi.advanceTimersByTime(200)
    await flushQueue()

    expect(clicks).not.toHaveBeenCalled()
    expect(spies.onScan).toHaveBeenCalledWith('6291000000001')
  })

  it('consumes a stray terminator right after a burst (double Enter), but not a later intentional Enter', async () => {
    mode = 'layout-edit'
    createRouter()
    const { button, clicks } = plainButton()

    scan(button, '6291000000001', 'Enter')
    const stray = press(button, 'Enter', {}, 40)
    expect(stray.down.defaultPrevented).toBe(true)
    expect(clicks).not.toHaveBeenCalled()

    // A person pressing Enter well after the burst activates the focused control natively.
    const intentional = press(button, 'Enter', {}, 1000)
    expect(intentional.down.defaultPrevented).toBe(false)
    expect(clicks).toHaveBeenCalledTimes(1)
    const space = press(button, ' ', {}, 1000)
    expect(space.up.defaultPrevented).toBe(false)
    expect(clicks).toHaveBeenCalledTimes(2)
  })

  it('consumes F9 and Shift+F9: nothing pays while the layout is edited', () => {
    mode = 'layout-edit'
    createRouter()
    const { button } = plainButton()

    const f9 = press(button, 'F9')
    const shiftF9 = press(button, 'F9', { shiftKey: true })

    expect(f9.down.defaultPrevented).toBe(true)
    expect(shiftF9.down.defaultPrevented).toBe(true)
    expect(spies.onPrimary).not.toHaveBeenCalled()
    expect(spies.onExactCash).not.toHaveBeenCalled()
  })

  it('does not suppress keyboard activation of a commit-class control (the editor has none)', () => {
    mode = 'layout-edit'
    createRouter()
    const { button, clicks } = commitButton('apply')

    press(button, 'Enter', {}, 1000)
    expect(clicks).toHaveBeenCalledTimes(1)
  })
})
