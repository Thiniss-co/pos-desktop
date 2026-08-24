// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AppStatusChip from './AppStatusChip.vue'

describe('AppStatusChip', () => {
  it('pairs an icon with the label so status is never color-only', () => {
    const wrapper = mount(AppStatusChip, {
      props: { variant: 'error' },
      slots: { default: 'Disabled' }
    })

    expect(wrapper.find('svg').exists()).toBe(true)
    expect(wrapper.text()).toBe('Disabled')
  })

  it('renders a distinct class per variant', () => {
    const variants = ['success', 'warning', 'error', 'information', 'neutral'] as const

    for (const variant of variants) {
      const wrapper = mount(AppStatusChip, { props: { variant } })
      expect(wrapper.classes()).toContain(`app-status-chip--${variant}`)
    }
  })

  it('defaults to the neutral variant', () => {
    const wrapper = mount(AppStatusChip)
    expect(wrapper.classes()).toContain('app-status-chip--neutral')
  })
})
