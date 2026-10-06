// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import {
  clonePreset,
  defaultWorkspaceLayout,
  type PosWorkspaceLayout
} from '@shared/contracts/posWorkspace.contract'
import PosWorkspaceShell from './PosWorkspaceShell.vue'

let wrappers: VueWrapper[] = []

afterEach(() => {
  wrappers.forEach((wrapper) => wrapper.unmount())
  wrappers = []
  document.documentElement.dir = 'ltr'
  vi.restoreAllMocks()
})

const SLOTS = {
  'catalog-categories': '<p class="slot-categories">Categories</p>',
  'catalog-search': '<p class="slot-search">Search</p>',
  'catalog-notices': '<p class="slot-notices">Notices</p>',
  'catalog-products': '<p class="slot-products">Products</p>',
  'cart-actions': '<p class="slot-actions">Actions</p>',
  'cart-scan': '<p class="slot-scan">Scan</p>',
  'cart-lines': '<p class="slot-lines">Lines</p>',
  'cart-totals': '<p class="slot-totals">Totals</p>'
}

function rect(width: number, height = 900): DOMRect {
  return {
    left: 0,
    right: width,
    width,
    x: 0,
    top: 0,
    bottom: height,
    height,
    y: 0,
    toJSON: () => ({})
  } as DOMRect
}

/** Mounts with a measured workspace body of `width` (the body has no padding in happy-dom). */
async function mountShell(
  props: { layout?: PosWorkspaceLayout } & Record<string, unknown> = {},
  width = 1896
): Promise<VueWrapper> {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width + 24 })
  const original = HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.classList.contains('pos-workspace-shell__body') ? rect(width) : original.call(this)
  })
  const wrapper = mount(PosWorkspaceShell, {
    props: { layout: defaultWorkspaceLayout(), ...props },
    slots: SLOTS,
    attachTo: document.body
  })
  wrappers.push(wrapper)
  window.dispatchEvent(new Event('resize'))
  await nextTick()
  return wrapper
}

describe('PosWorkspaceShell', () => {
  it('lays out Cart first: a wide cart, a compact catalog panel, compact density', async () => {
    const wrapper = await mountShell()
    const root = wrapper.get('.pos-workspace-shell')
    expect(root.attributes('data-preset')).toBe('cartFirst')
    expect(root.attributes('data-density')).toBe('compact')
    expect(root.attributes('data-catalog-mode')).toBe('panel')
    const catalog = wrapper.get('.pos-workspace-shell__catalog').element as HTMLElement
    expect(catalog.style.width).toBe(`${1896 - Math.round(1896 * 0.64) - 12}px`)
  })

  it('has no separator and no drag handle during normal selling', async () => {
    const wrapper = await mountShell()
    expect(wrapper.find('[role="separator"]').exists()).toBe(false)
    expect(wrapper.find('.pos-workspace-section__handle').exists()).toBe(false)
    expect(wrapper.find('.pos-workspace-shell__swap').exists()).toBe(false)
    expect(wrapper.find('[inert]').exists()).toBe(false)
  })

  it('renders regions and sections in DOM order = visual order', async () => {
    const wrapper = await mountShell({
      layout: {
        ...defaultWorkspaceLayout(),
        cartSide: 'start',
        sections: {
          cart: ['scan', 'lines', 'actions', 'totals'],
          catalog: ['search', 'categories', 'products']
        }
      }
    })
    const body = wrapper.get('.pos-workspace-shell__body').element
    const regions = Array.from(body.children).map((element) =>
      element.classList.contains('pos-workspace-shell__cart') ? 'cart' : 'catalog'
    )
    expect(regions).toEqual(['cart', 'catalog'])
    const cartSections = wrapper
      .findAll('.pos-workspace-shell__cart [data-section]')
      .map((element) => element.attributes('data-section'))
    expect(cartSections).toEqual(['scan', 'lines', 'actions', 'totals'])
    const catalogSections = wrapper
      .findAll('.pos-workspace-shell__catalog [data-section]')
      .map((element) => element.attributes('data-section'))
    expect(catalogSections).toEqual(['search', 'categories'])
  })

  it('collapses products to the rail (Scanner focused) and opens the browser beside the cart', async () => {
    const wrapper = await mountShell({ layout: clonePreset('scanner') })
    expect(wrapper.get('.pos-workspace-shell').attributes('data-catalog-mode')).toBe('rail')
    expect(wrapper.find('.slot-products').exists()).toBe(false)
    const toggle = wrapper.get('.pos-workspace-shell__rail-toggle')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    await toggle.trigger('click')
    expect(wrapper.emitted('update:railOpen')?.[0]).toEqual([true])
    await wrapper.setProps({ railOpen: true })
    expect(wrapper.find('.pos-workspace-shell__browser .slot-products').exists()).toBe(true)
    // The browser never covers the cart: both stay in the row.
    expect(wrapper.find('.pos-workspace-shell__cart .slot-totals').exists()).toBe(true)
  })

  it('uses the rail below 900px wide, keeping the cart visible', async () => {
    const wrapper = await mountShell({}, 776)
    expect(wrapper.get('.pos-workspace-shell').attributes('data-catalog-mode')).toBe('rail')
    expect(wrapper.find('.pos-workspace-shell__cart .slot-lines').exists()).toBe(true)
  })

  it('forces the comfortable density in touch mode', async () => {
    const wrapper = await mountShell({ touchMode: true })
    expect(wrapper.get('.pos-workspace-shell').attributes('data-density')).toBe('comfortable')
  })

  describe('while editing', () => {
    it('shows the separator, section handles and makes non-line sections inert', async () => {
      const wrapper = await mountShell({ editing: true })
      const separator = wrapper.get('[role="separator"]')
      expect(separator.attributes('aria-valuenow')).toBe('64')
      expect(wrapper.findAll('.pos-workspace-section__handle').length).toBeGreaterThan(0)
      const inert = wrapper.findAll('.pos-workspace-shell__cart [inert]')
      expect(inert.some((element) => element.find('.slot-lines').exists())).toBe(false)
      expect(inert.some((element) => element.find('.slot-totals').exists())).toBe(true)
    })

    it('resizes from the keyboard in the visual direction (LTR and RTL)', async () => {
      const wrapper = await mountShell({ editing: true })
      const separator = wrapper.get('[role="separator"]')
      // Cart on the right (LTR, end): ArrowLeft moves the handle left and widens the cart.
      await separator.trigger('keydown', { key: 'ArrowLeft' })
      expect(wrapper.emitted('resize')?.at(-1)).toEqual([66])
      await separator.trigger('keydown', { key: 'ArrowRight', shiftKey: true })
      expect(wrapper.emitted('resize')?.at(-1)).toEqual([59])

      document.documentElement.dir = 'rtl'
      const rtlWrapper = await mountShell({ editing: true })
      ;(rtlWrapper.get('.pos-workspace-shell__body').element as HTMLElement).style.direction = 'rtl'
      window.dispatchEvent(new Event('resize'))
      await nextTick()
      await rtlWrapper.get('[role="separator"]').trigger('keydown', { key: 'ArrowLeft' })
      // RTL: the cart is on the left, so ArrowLeft narrows it.
      expect(rtlWrapper.emitted('resize')?.at(-1)).toEqual([62])
    })

    it('emits Move up / Move down requests and disables the moves the page refuses', async () => {
      const wrapper = await mountShell({
        editing: true,
        canMove: (_column: string, id: string, direction: number) =>
          !(id === 'scan' && direction === 1)
      })
      const scan = wrapper.get('.pos-workspace-shell__cart [data-section="scan"]')
      const [up, down] = scan.findAll('button')
      expect(down.attributes('disabled')).toBeDefined()
      await up.trigger('click')
      expect(wrapper.emitted('move')?.[0]).toEqual([{ column: 'cart', id: 'scan', direction: -1 }])
      const totals = wrapper.get('.pos-workspace-shell__cart [data-section="totals"]')
      expect(totals.findAll('button')).toHaveLength(0)
    })

    it('swaps the cart side from the catalog handle button', async () => {
      const wrapper = await mountShell({ editing: true })
      await wrapper.get('.pos-workspace-shell__swap-button').trigger('click')
      expect(wrapper.emitted('swapSide')).toHaveLength(1)
    })
  })
})
