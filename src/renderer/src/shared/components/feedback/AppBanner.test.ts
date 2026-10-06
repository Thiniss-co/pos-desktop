// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AppBanner from './AppBanner.vue'

describe('AppBanner', () => {
  it('separates an inline bar title from its body with a space', () => {
    const wrapper = mount(AppBanner, {
      props: { bar: true, title: 'Suspended', variant: 'error' },
      slots: { default: 'New sales are paused.' }
    })

    expect(wrapper.find('.app-banner__content').text()).toBe('Suspended New sales are paused.')
  })
})
