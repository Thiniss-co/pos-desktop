// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { nextTick } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import type { PosCartWidthPreference } from '@shared/contracts/preferences.contract'
import { useCartLayoutStore } from '@renderer/modules/preferences/cartLayout.store'
import PosWorkspaceShell from './PosWorkspaceShell.vue'

type CartLayoutStore = ReturnType<typeof useCartLayoutStore>

let wrappers: VueWrapper[] = []
let pinia: Pinia
let store: CartLayoutStore
let setWidthSpy: MockInstance<CartLayoutStore['setWidth']>
let resetSpy: MockInstance<CartLayoutStore['reset']>
let setPosCartWidth: ReturnType<typeof vi.fn>

function mountShell(props: Record<string, unknown> = {}): VueWrapper {
  const wrapper = mount(PosWorkspaceShell, {
    props,
    slots: {
      catalog: '<p>Catalog</p>',
      cart: '<p>Cart</p>'
    },
    global: { plugins: [pinia] },
    attachTo: document.body
  })
  wrappers.push(wrapper)
  return wrapper
}

function handleOf(wrapper: VueWrapper): HTMLElement {
  return wrapper.get('[role="separator"]').element as HTMLElement
}

function cartOf(wrapper: VueWrapper): HTMLElement {
  return wrapper.get('aside').element as HTMLElement
}

function rect(left: number, width: number): DOMRect {
  return {
    left,
    right: left + width,
    width,
    x: left,
    top: 0,
    bottom: 600,
    height: 600,
    y: 0,
    toJSON: () => ({})
  } as DOMRect
}

/** Pins the measured workspace (catalog + cart row) width and fires a window resize. */
async function setWorkspaceWidth(wrapper: VueWrapper, width: number): Promise<void> {
  const body = wrapper.get('.pos-workspace-shell__body').element as HTMLElement
  vi.spyOn(body, 'getBoundingClientRect').mockReturnValue(rect(0, width))
  window.dispatchEvent(new Event('resize'))
  await nextTick()
}

function pointer(type: string, clientX: number, init: PointerEventInit = {}): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 7,
    button: 0,
    isPrimary: true,
    clientX,
    ...init
  })
}

function stubPointerCapture(handle: HTMLElement): {
  setPointerCapture: ReturnType<typeof vi.fn>
  releasePointerCapture: ReturnType<typeof vi.fn>
} {
  let captured: number | null = null
  const setPointerCapture = vi.fn((id: number) => {
    captured = id
  })
  const releasePointerCapture = vi.fn(() => {
    captured = null
  })
  Object.assign(handle, {
    setPointerCapture,
    releasePointerCapture,
    hasPointerCapture: (id: number) => captured === id
  })
  return { setPointerCapture, releasePointerCapture }
}

async function press(wrapper: VueWrapper, key: string, shiftKey = false): Promise<void> {
  await wrapper.get('[role="separator"]').trigger('keydown', { key, shiftKey })
}

function lastWidth(): number | undefined {
  return setWidthSpy.mock.calls.at(-1)?.[0]
}

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  store = useCartLayoutStore(pinia)
  setWidthSpy = vi.spyOn(store, 'setWidth')
  resetSpy = vi.spyOn(store, 'reset')
  setPosCartWidth = vi.fn(async (width: PosCartWidthPreference) => ({ ok: true, data: width }))
  Object.assign(window, {
    posApi: {
      preferences: {
        getPosCartWidth: vi.fn(async () => ({ ok: true, data: null })),
        setPosCartWidth
      }
    }
  })
  document.documentElement.dir = 'ltr'
})

afterEach(() => {
  for (const wrapper of wrappers) {
    wrapper.unmount()
  }
  wrappers = []
  document.documentElement.dir = ''
  delete (window as unknown as { posApi?: unknown }).posApi
  vi.restoreAllMocks()
})

describe('PosWorkspaceShell — resizable cart', () => {
  it('exposes the resize handle as an accessible vertical separator', () => {
    const wrapper = mountShell({ cartLabel: 'Cart' })
    const handle = wrapper.get('[role="separator"]')

    expect(handle.attributes('aria-orientation')).toBe('vertical')
    expect(handle.attributes('tabindex')).toBe('0')
    expect(handle.attributes('aria-label')).toBe('Resize cart')
    expect(handle.attributes('aria-valuemin')).toBe('320')
    // Unmeasured workspace: only the 640px cap applies.
    expect(handle.attributes('aria-valuemax')).toBe('640')
    // happy-dom's default viewport is 1024px wide, so the design default is 340px.
    expect(handle.attributes('aria-valuenow')).toBe('340')
    expect(handle.attributes('aria-valuetext')).toBe('340 pixels')
    expect(handle.attributes('aria-controls')).toBe(wrapper.get('aside').attributes('id'))
    expect(handle.classes()).toContain('cursor-col-resize')
  })

  it('uses the translated labels and value text supplied by the page', async () => {
    const wrapper = mountShell({
      resizeLabel: 'تغيير عرض السلة',
      resetWidthLabel: 'إعادة ضبط عرض السلة',
      widthValueText: (px: number) => `${px} بكسل`
    })
    const handle = wrapper.get('[role="separator"]')

    expect(handle.attributes('aria-label')).toBe('تغيير عرض السلة')
    expect(handle.attributes('aria-valuetext')).toBe('340 بكسل')

    store.width = 400
    await nextTick()
    const reset = wrapper.get('.pos-workspace-shell__reset-width')
    expect(reset.attributes('aria-label')).toBe('إعادة ضبط عرض السلة')
    expect(reset.attributes('title')).toBe('إعادة ضبط عرض السلة')
  })

  it('shows the handle only from the `wide` breakpoint, and never for the compact sheet', async () => {
    const wrapper = mountShell()
    const resizer = wrapper.get('.pos-workspace-shell__resizer')

    expect(resizer.classes()).toEqual(expect.arrayContaining(['hidden', 'wide:flex']))

    await wrapper.setProps({ sheetOpen: true })
    expect(wrapper.find('[role="separator"]').exists()).toBe(false)
    expect(wrapper.find('.pos-workspace-shell__reset-width').exists()).toBe(false)
  })

  it('keeps the per-breakpoint defaults when no width is set, and applies a set width', async () => {
    const wrapper = mountShell()
    const cart = wrapper.get('aside')

    expect(cart.classes()).toEqual(
      expect.arrayContaining([
        'w-(--cart-w)',
        '[--cart-w:340px]',
        'cartlg:[--cart-w:380px]',
        'hd:[--cart-w:420px]'
      ])
    )
    expect(cartOf(wrapper).style.getPropertyValue('--cart-w')).toBe('')
    expect(cart.classes()).not.toContain('max-w-[min(640px,50%)]')

    store.width = 456
    await nextTick()

    expect(cartOf(wrapper).style.getPropertyValue('--cart-w')).toBe('456px')
    expect(cart.classes()).toContain('max-w-[min(640px,50%)]')
    expect(wrapper.get('[role="separator"]').attributes('aria-valuenow')).toBe('456')

    // The full-screen sheet never inherits a desktop width.
    await wrapper.setProps({ sheetOpen: true })
    expect(cartOf(wrapper).style.getPropertyValue('--cart-w')).toBe('')
    expect(cart.classes()).toContain('fixed')
  })

  it('clamps the applied width to half the workspace on resize without rewriting the preference', async () => {
    const wrapper = mountShell()
    store.width = 600
    await nextTick()

    await setWorkspaceWidth(wrapper, 950) // e.g. a 1024x768 window
    const handle = wrapper.get('[role="separator"]')
    expect(handle.attributes('aria-valuemax')).toBe('475')
    expect(handle.attributes('aria-valuenow')).toBe('475')
    expect(cartOf(wrapper).style.getPropertyValue('--cart-w')).toBe('475px')
    expect(store.width).toBe(600)

    await setWorkspaceWidth(wrapper, 1800) // e.g. a 1920x1080 window
    expect(handle.attributes('aria-valuemax')).toBe('640')
    expect(cartOf(wrapper).style.getPropertyValue('--cart-w')).toBe('600px')
    expect(setWidthSpy).not.toHaveBeenCalled()
  })

  it('never offers less than the 320px minimum, even in a very narrow workspace', async () => {
    const wrapper = mountShell()
    await setWorkspaceWidth(wrapper, 500)

    expect(wrapper.get('[role="separator"]').attributes('aria-valuemax')).toBe('320')
  })

  describe('keyboard', () => {
    it('in LTR, ArrowLeft widens and ArrowRight narrows by 16px (Shift: 64px)', async () => {
      const wrapper = mountShell()

      await press(wrapper, 'ArrowLeft')
      expect(lastWidth()).toBe(356)
      await press(wrapper, 'ArrowLeft', true)
      expect(lastWidth()).toBe(420)
      await press(wrapper, 'ArrowRight')
      expect(lastWidth()).toBe(404)
      await press(wrapper, 'ArrowRight', true)
      expect(lastWidth()).toBe(340)
      expect(store.width).toBe(340)
    })

    it('in RTL, the arrows are mirrored so the handle moves the way the arrow points', async () => {
      document.documentElement.dir = 'rtl'
      const wrapper = mountShell()

      await press(wrapper, 'ArrowRight')
      expect(lastWidth()).toBe(356)
      await press(wrapper, 'ArrowRight', true)
      expect(lastWidth()).toBe(420)
      await press(wrapper, 'ArrowLeft')
      expect(lastWidth()).toBe(404)
      await press(wrapper, 'ArrowLeft', true)
      expect(lastWidth()).toBe(340)
    })

    it('Home jumps to the minimum and End to the current maximum, and steps clamp at both ends', async () => {
      const wrapper = mountShell()
      await setWorkspaceWidth(wrapper, 1000)

      await press(wrapper, 'Home')
      expect(lastWidth()).toBe(320)
      await press(wrapper, 'ArrowRight', true)
      expect(lastWidth()).toBe(320)

      await press(wrapper, 'End')
      expect(lastWidth()).toBe(500)
      await press(wrapper, 'ArrowLeft', true)
      expect(lastWidth()).toBe(500)
      expect(wrapper.get('[role="separator"]').attributes('aria-valuenow')).toBe('500')
    })

    it('Enter restores the design default and persists null', async () => {
      const wrapper = mountShell()
      store.width = 480
      await nextTick()

      await press(wrapper, 'Enter')

      expect(resetSpy).toHaveBeenCalledTimes(1)
      expect(store.width).toBeNull()
      expect(setPosCartWidth).toHaveBeenCalledWith(null)
      expect(wrapper.get('[role="separator"]').attributes('aria-valuenow')).toBe('340')
    })

    it('leaves unrelated keys alone (no preventDefault, no width change)', async () => {
      const wrapper = mountShell()
      const event = new KeyboardEvent('keydown', { key: '5', bubbles: true, cancelable: true })

      handleOf(wrapper).dispatchEvent(event)
      await nextTick()

      expect(event.defaultPrevented).toBe(false)
      expect(setWidthSpy).not.toHaveBeenCalled()
      expect(resetSpy).not.toHaveBeenCalled()
    })
  })

  it('double-clicking the handle resets the width', async () => {
    const wrapper = mountShell()
    store.width = 512
    await nextTick()

    await wrapper.get('[role="separator"]').trigger('dblclick')

    expect(resetSpy).toHaveBeenCalledTimes(1)
    expect(store.width).toBeNull()
  })

  it('offers a keyboard-reachable reset button only while a custom width is set', async () => {
    const wrapper = mountShell()
    expect(wrapper.find('.pos-workspace-shell__reset-width').exists()).toBe(false)

    store.width = 512
    await nextTick()
    const reset = wrapper.get('.pos-workspace-shell__reset-width')
    expect(reset.element.tagName).toBe('BUTTON')
    expect(reset.attributes('type')).toBe('button')
    expect(reset.attributes('aria-label')).toBe('Reset cart width')

    await reset.trigger('click')

    expect(resetSpy).toHaveBeenCalledTimes(1)
    expect(store.width).toBeNull()
    expect(wrapper.find('.pos-workspace-shell__reset-width').exists()).toBe(false)
    // Focus lands on the separator instead of being lost with the removed button.
    expect(document.activeElement).toBe(handleOf(wrapper))
  })

  describe('pointer drag', () => {
    it('in LTR, sizes the cart from its right (inline-end) edge to the pointer', async () => {
      const wrapper = mountShell()
      const handle = handleOf(wrapper)
      const capture = stubPointerCapture(handle)
      vi.spyOn(cartOf(wrapper), 'getBoundingClientRect').mockReturnValue(rect(600, 400))

      // Grab the handle 8px outside the cart's start edge: the grab offset keeps it from jumping.
      handle.dispatchEvent(pointer('pointerdown', 592))
      await nextTick()
      expect(capture.setPointerCapture).toHaveBeenCalledWith(7)
      expect(wrapper.get('.pos-workspace-shell').classes()).toEqual(
        expect.arrayContaining(['select-none', 'cursor-col-resize'])
      )

      handle.dispatchEvent(pointer('pointermove', 492)) // dragged 100px left
      expect(lastWidth()).toBe(500)
      handle.dispatchEvent(pointer('pointermove', 642)) // then 150px right
      expect(lastWidth()).toBe(350)

      handle.dispatchEvent(pointer('pointerup', 642))
      await nextTick()
      expect(capture.releasePointerCapture).toHaveBeenCalledWith(7)
      expect(wrapper.get('.pos-workspace-shell').classes()).not.toContain('select-none')
      // Drag end writes the final width straight away instead of waiting for the debounce.
      await vi.waitFor(() => expect(setPosCartWidth).toHaveBeenCalledWith(350))
      expect(setPosCartWidth).toHaveBeenCalledTimes(1)

      handle.dispatchEvent(pointer('pointermove', 400))
      expect(lastWidth()).toBe(350)
    })

    it('in RTL, sizes the cart from its left (inline-end) edge to the pointer', async () => {
      document.documentElement.dir = 'rtl'
      const wrapper = mountShell()
      const handle = handleOf(wrapper)
      stubPointerCapture(handle)
      vi.spyOn(cartOf(wrapper), 'getBoundingClientRect').mockReturnValue(rect(24, 400))

      handle.dispatchEvent(pointer('pointerdown', 432)) // 8px outside the cart's right edge
      handle.dispatchEvent(pointer('pointermove', 532)) // dragged 100px right: wider
      expect(lastWidth()).toBe(500)
      handle.dispatchEvent(pointer('pointermove', 382)) // then 150px left: narrower
      expect(lastWidth()).toBe(350)
    })

    it('clamps a drag to [320, max]', async () => {
      const wrapper = mountShell()
      await setWorkspaceWidth(wrapper, 1100)
      const handle = handleOf(wrapper)
      stubPointerCapture(handle)
      vi.spyOn(cartOf(wrapper), 'getBoundingClientRect').mockReturnValue(rect(700, 400))

      handle.dispatchEvent(pointer('pointerdown', 700))
      handle.dispatchEvent(pointer('pointermove', 0))
      expect(lastWidth()).toBe(550)
      handle.dispatchEvent(pointer('pointermove', 1090))
      expect(lastWidth()).toBe(320)
    })

    it('pointercancel and lostpointercapture both end the drag', async () => {
      const wrapper = mountShell()
      const handle = handleOf(wrapper)
      stubPointerCapture(handle)
      vi.spyOn(cartOf(wrapper), 'getBoundingClientRect').mockReturnValue(rect(600, 400))

      handle.dispatchEvent(pointer('pointerdown', 600))
      handle.dispatchEvent(pointer('pointercancel', 600))
      handle.dispatchEvent(pointer('pointermove', 500))
      expect(setWidthSpy).not.toHaveBeenCalled()

      handle.dispatchEvent(pointer('pointerdown', 600))
      handle.dispatchEvent(pointer('lostpointercapture', 600))
      await nextTick()
      handle.dispatchEvent(pointer('pointermove', 500))
      expect(setWidthSpy).not.toHaveBeenCalled()
      expect(wrapper.get('.pos-workspace-shell').classes()).not.toContain('select-none')
    })

    it('ignores secondary buttons and non-primary pointers', async () => {
      const wrapper = mountShell()
      const handle = handleOf(wrapper)
      const capture = stubPointerCapture(handle)
      vi.spyOn(cartOf(wrapper), 'getBoundingClientRect').mockReturnValue(rect(600, 400))

      handle.dispatchEvent(pointer('pointerdown', 600, { button: 2 }))
      handle.dispatchEvent(pointer('pointermove', 500))
      handle.dispatchEvent(pointer('pointerdown', 600, { isPrimary: false }))
      handle.dispatchEvent(pointer('pointermove', 500))

      expect(capture.setPointerCapture).not.toHaveBeenCalled()
      expect(setWidthSpy).not.toHaveBeenCalled()
    })

    it('does not start a text selection or steal keyboard focus on mouse down', () => {
      const wrapper = mountShell()
      const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })

      handleOf(wrapper).dispatchEvent(event)

      expect(event.defaultPrevented).toBe(true)
    })
  })
})
