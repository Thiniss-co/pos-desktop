import { describe, expect, it } from 'vitest'
import { applyKeypadKey, type KeypadKey } from './keypad'

function type(keys: readonly KeypadKey[], maxDecimals = 2, start = ''): string {
  return keys.reduce((value, key) => applyKeypadKey(value, key, maxDecimals), start)
}

describe('applyKeypadKey', () => {
  it('types digits and one decimal separator, capped at the allowed decimals', () => {
    expect(type(['1', '2', '.', '5', '0', '9'])).toBe('12.50')
    expect(type(['.', '5'])).toBe('0.5')
    expect(type(['1', '.', '.', '2'])).toBe('1.2')
  })

  it('replaces a lone leading zero instead of repeating it', () => {
    expect(type(['0', '0', '7'])).toBe('7')
  })

  it('refuses a separator when no decimals are allowed (whole quantities)', () => {
    expect(type(['3', '.', '5'], 0)).toBe('35')
  })

  it('allows three decimals for a fractional quantity', () => {
    expect(type(['1', '.', '2', '5', '0', '9'], 3)).toBe('1.250')
  })

  it('backspace removes one character and clear empties the field', () => {
    expect(type(['back'], 2, '12.5')).toBe('12.')
    expect(type(['clear'], 2, '12.5')).toBe('')
    expect(type(['back'], 2, '')).toBe('')
  })
})
