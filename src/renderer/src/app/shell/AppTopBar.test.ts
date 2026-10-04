// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import AppTopBar from './AppTopBar.vue'
import { useBrandingStore } from '@renderer/modules/branding/store'
import type { ShellNavItem } from './useShellNavigation'

/*
 * Navigation labels must be readable text at every width the top bar shows navigation (≥ 900px),
 * not only at ≥ 1500px. Below 1500 the compact treatment stacks icon over label; the label is
 * never display-hidden, never aria-hidden, and it is the link's accessible name.
 */

const RouterLinkStub = defineComponent({
  props: { to: { type: String, required: true } },
  setup(props, { slots, attrs }) {
    return () => h('a', { ...attrs, href: props.to }, slots.default?.())
  }
})

const ITEMS = [
  { name: 'pos', to: '/pos', label: 'POS', icon: 'point_of_sale', active: true },
  {
    name: 'offline-stock',
    to: '/offline-stock',
    label: 'Offline stock',
    icon: 'inventory_2',
    active: false
  },
  {
    name: 'company-users',
    to: '/company-users',
    label: 'Company users',
    icon: 'group',
    active: false
  }
] as unknown as ShellNavItem[]

function render(): ReturnType<typeof mount> {
  i18n.global.locale.value = 'en'

  return mount(AppTopBar, {
    props: { items: ITEMS },
    global: {
      plugins: [createPinia(), i18n],
      stubs: { RouterLink: RouterLinkStub, ShiftMenu: true, UserMenu: true }
    }
  })
}

describe('AppTopBar navigation labels', () => {
  it('renders every label as visible link text at compact widths', () => {
    const links = render().findAll('nav a')

    expect(links.map((link) => link.text())).toEqual(['POS', 'Offline stock', 'Company users'])

    for (const link of links) {
      const label = link.get('.app-top-bar__nav-label')

      // Visible by default — not only from the `navlabels` (1500px) breakpoint.
      expect(label.classes()).not.toContain('hidden')
      expect(label.attributes('aria-hidden')).toBeUndefined()
      // The visible text is the accessible name; no duplicate aria-label or tooltip is needed.
      expect(link.attributes('aria-label')).toBeUndefined()
      expect(link.attributes('title')).toBeUndefined()
    }
  })

  it('stacks icon over label below 1500px and lays them side by side from 1500px', () => {
    const link = render().get('nav a')

    expect(link.classes()).toEqual(expect.arrayContaining(['flex-col', 'navlabels:flex-row']))
    expect(link.attributes('aria-current')).toBe('page')
  })
})

describe('AppTopBar company identity (P9)', () => {
  it('shows the product mark and "Thinis POS" without a delivered identity', () => {
    const wrapper = render()
    expect(wrapper.find('[data-testid="top-bar-logo"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="top-bar-name"]').text()).toBe('Thinis POS')
  })

  it('shows the company logo and name when delivered', async () => {
    const pinia = createPinia()
    const wrapper = mount(AppTopBar, {
      props: { items: ITEMS },
      global: {
        plugins: [pinia, i18n],
        stubs: { RouterLink: RouterLinkStub, ShiftMenu: true, UserMenu: true }
      }
    })
    useBrandingStore(pinia).view = {
      companyName: 'Harbour Coffee',
      primaryColor: '#0e9f8e',
      logoDataUrl: 'data:image/png;base64,iVBORw0KGgo='
    }
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-testid="top-bar-logo"]').attributes('src')).toContain(
      'data:image/png;base64,'
    )
    expect(wrapper.get('[data-testid="top-bar-name"]').text()).toBe('Harbour Coffee')
  })
})
