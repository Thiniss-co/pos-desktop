// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import { useUserPreferencesStore } from '@renderer/modules/preferences/userPreferences.store'
import QuickCreateDialog from './QuickCreateDialog.vue'

const OPTIONS = {
  // A three-digit currency proves the keypad follows the catalog's minor units, not a fixed two.
  currency: 'KWD',
  currencyExponent: 3,
  categories: [{ uuid: '00000000-0000-4000-8000-000000000001', name: 'Drinks' }],
  taxes: []
}

let wrapper: VueWrapper | null = null

function priceField(): HTMLInputElement {
  const field = document.querySelector<HTMLInputElement>(
    '[role="dialog"] [data-testid="quick-create-price"] input'
  )
  if (!field) {
    throw new Error('the price field is not rendered')
  }
  return field
}

async function openProductDialog(touchMode: boolean): Promise<void> {
  useUserPreferencesStore().preferences = { touchMode, autoPrint: true }
  wrapper = mount(QuickCreateDialog, {
    props: { open: true, kind: 'product' },
    global: { plugins: [i18n] },
    attachTo: document.body
  })
  await flushPromises()
}

beforeEach(() => {
  setActivePinia(createPinia())
  ;(window as unknown as { posApi: unknown }).posApi = {
    preferences: { getUser: vi.fn(), setUser: vi.fn() },
    quickCreate: {
      productOptions: vi.fn().mockResolvedValue({ ok: true, data: OPTIONS }),
      onChanged: vi.fn(() => () => undefined)
    }
  }
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('quick-create product: touch numeric input', () => {
  it('enters the price on the on-screen keypad, capped at the currency minor units', async () => {
    await openProductDialog(true)

    for (const name of ['1', '2', '.', '5', '0', '0', '9']) {
      document.querySelector<HTMLButtonElement>(`[role="dialog"] [data-key="${name}"]`)?.click()
      await flushPromises()
    }

    // "9" is a fourth decimal for a three-digit currency, so the keypad ignores it.
    expect(priceField().value).toBe('12.500')
  })

  it('keeps the keyboard price field (no keypad) outside touch mode', async () => {
    await openProductDialog(false)

    expect(document.querySelector('[role="dialog"] [data-testid="numeric-keypad"]')).toBeNull()
    expect(priceField().value).toBe('')
  })
})
