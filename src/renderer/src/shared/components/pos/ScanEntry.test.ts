// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import ScanEntry from './ScanEntry.vue'

let wrappers: VueWrapper[] = []

function mountEntry(props: Record<string, unknown> = {}): VueWrapper {
  const wrapper = mount(ScanEntry, {
    props: {
      modelValue: '',
      label: 'Scan or type code',
      placeholder: 'Scan barcode',
      hint: 'Scans go straight to the sale.',
      multiplierLabel: 'Next scan',
      clearMultiplierLabel: 'Reset',
      pendingMultiplier: null,
      result: null,
      ...props
    },
    attachTo: document.body
  })
  wrappers.push(wrapper)
  return wrapper
}

afterEach(() => {
  for (const wrapper of wrappers) {
    wrapper.unmount()
  }
  wrappers = []
})

describe('ScanEntry', () => {
  it('is an add-to-cart field, not a search box', () => {
    const wrapper = mountEntry()
    expect(wrapper.find('form').attributes('role')).toBeUndefined()
    expect(wrapper.find('input').attributes('type')).toBe('text')
    expect(wrapper.text()).toContain('Scans go straight to the sale.')
  })

  it('submits the typed code on Enter', async () => {
    const wrapper = mountEntry({ modelValue: '3*6221234567890' })
    await wrapper.find('form').trigger('submit')
    expect(wrapper.emitted('submit')).toEqual([['3*6221234567890']])
  })

  it('does not submit while disabled', async () => {
    const wrapper = mountEntry({ modelValue: '123', disabled: true })
    await wrapper.find('form').trigger('submit')
    expect(wrapper.emitted('submit')).toBeUndefined()
  })

  it('toggles a pending multiplier and shows it beside the field', async () => {
    const wrapper = mountEntry()
    const tiles = wrapper.findAll('.scan-entry__multiplier')
    await tiles[1].trigger('click')
    expect(wrapper.emitted('setMultiplier')).toEqual([[3]])

    await wrapper.setProps({ pendingMultiplier: 3 })
    expect(wrapper.find('[data-testid="scan-entry-pending"]').text()).toBe('×3')

    await wrapper.findAll('.scan-entry__multiplier')[1].trigger('click')
    expect(wrapper.emitted('setMultiplier')?.[1]).toEqual([null])
  })

  it('renders the last scan outcome in place of the hint', () => {
    const wrapper = mountEntry({
      result: {
        sequence: 1,
        code: '999',
        tone: 'error',
        message: 'No product matches this barcode'
      }
    })
    expect(wrapper.find('.scan-entry__result--error').text()).toContain('999')
    expect(wrapper.text()).not.toContain('Scans go straight to the sale.')
  })
})
