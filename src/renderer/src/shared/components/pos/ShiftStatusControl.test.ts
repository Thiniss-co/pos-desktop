// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ShiftStatusControl from './ShiftStatusControl.vue'

describe('ShiftStatusControl', () => {
  it('renders cancelled as a neutral terminal state without lifecycle actions', () => {
    const wrapper = mount(ShiftStatusControl, {
      props: {
        phase: 'cancelled',
        phaseLabel: 'Shift cancelled',
        openLabel: 'Open shift',
        pauseLabel: 'Pause',
        resumeLabel: 'Resume',
        closeLabel: 'Close shift'
      }
    })

    expect(wrapper.text()).toContain('Shift cancelled')
    expect(wrapper.find('.app-status-chip').classes()).toContain('app-status-chip--neutral')
    expect(wrapper.findAll('button')).toHaveLength(0)
  })

  it('keeps the matching lifecycle action visible and busy during a mutation', () => {
    const wrapper = mount(ShiftStatusControl, {
      props: {
        phase: 'opening',
        phaseLabel: 'Opening shift',
        openLabel: 'Open shift',
        pauseLabel: 'Pause',
        resumeLabel: 'Resume',
        closeLabel: 'Close shift'
      }
    })

    expect(wrapper.text()).toContain('Open shift')
    expect(wrapper.find('button').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.app-button__spinner').exists()).toBe(true)
  })
})
