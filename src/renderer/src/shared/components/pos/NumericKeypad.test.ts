// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import NumericKeypad from './NumericKeypad.vue'
import NumericAmountInput from './NumericAmountInput.vue'
import QuantityControl from './QuantityControl.vue'

const labels = { backspace: 'Delete last digit', clear: 'Clear', decimal: 'Decimal point' }

describe('POS improvements Stage 5: touch keypad', () => {
  it('emits each key and disables the separator for whole quantities', async () => {
    const keypad = mount(NumericKeypad, {
      props: {
        backspaceLabel: labels.backspace,
        clearLabel: labels.clear,
        decimalLabel: labels.decimal,
        allowDecimal: false
      }
    })
    for (const key of ['7', '0', 'back', 'clear']) {
      await keypad.get(`[data-key="${key}"]`).trigger('click')
    }
    expect(keypad.emitted('press')?.map(([key]) => key)).toEqual(['7', '0', 'back', 'clear'])
    expect(keypad.get('[data-key="."]').attributes('disabled')).toBeDefined()
    expect(keypad.get('[data-key="back"]').attributes('aria-label')).toBe(labels.backspace)
  })

  it('edits the same amount string a keyboard would, only in touch mode', async () => {
    const input = mount(NumericAmountInput, {
      props: { modelValue: '12', label: 'Cash received', keypadLabels: labels }
    })
    await input.get('[data-key="."]').trigger('click')
    expect(input.emitted('update:modelValue')?.at(-1)).toEqual(['12.'])
    await input.setProps({ modelValue: '12.5' })
    await input.get('[data-key="5"]').trigger('click')
    expect(input.emitted('update:modelValue')?.at(-1)).toEqual(['12.55'])
    await input.setProps({ modelValue: '12.55' })
    await input.get('[data-key="9"]').trigger('click')
    expect(input.emitted('update:modelValue')?.at(-1)).toEqual(['12.55'])

    const keyboardOnly = mount(NumericAmountInput, { props: { modelValue: '', label: 'Cash' } })
    expect(keyboardOnly.find('[data-testid="numeric-keypad"]').exists()).toBe(false)
  })

  it('makes the quantity a button that asks for the keypad only in touch mode', async () => {
    const touch = mount(QuantityControl, {
      props: {
        quantity: 2,
        decreaseLabel: '−',
        increaseLabel: '+',
        editLabel: 'Set quantity of Cola'
      }
    })
    await touch.get('[aria-label="Set quantity of Cola"]').trigger('click')
    expect(touch.emitted('edit')).toHaveLength(1)

    const plain = mount(QuantityControl, {
      props: { quantity: 2, decreaseLabel: '−', increaseLabel: '+' }
    })
    expect(plain.find('[aria-label="Set quantity of Cola"]').exists()).toBe(false)
    expect(plain.findAll('button')).toHaveLength(2)
  })
})
