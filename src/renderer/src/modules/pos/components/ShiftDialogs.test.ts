// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import { useUserPreferencesStore } from '@renderer/modules/preferences/userPreferences.store'
import { useShiftStore } from '../shift.store'
import { useShiftDialogStore } from '../shiftDialog.store'
import ShiftDialogs from './ShiftDialogs.vue'

let wrapper: VueWrapper | null = null

function key(name: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`[role="dialog"] [data-key="${name}"]`)
  if (!button) {
    throw new Error(`keypad key ${name} is not rendered`)
  }
  return button
}

async function press(...names: string[]): Promise<void> {
  for (const name of names) {
    key(name).click()
    await flushPromises()
  }
}

function cashField(): HTMLInputElement {
  const field = document.querySelector<HTMLInputElement>('[role="dialog"] input')
  if (!field) {
    throw new Error('the cash field is not rendered')
  }
  return field
}

async function openDialog(touchMode: boolean): Promise<ReturnType<typeof useShiftStore>> {
  useUserPreferencesStore().preferences = { touchMode, autoPrint: true }
  const shift = useShiftStore()
  wrapper = mount(ShiftDialogs, { global: { plugins: [i18n] }, attachTo: document.body })
  useShiftDialogStore().request('open')
  await flushPromises()
  return shift
}

beforeEach(() => {
  setActivePinia(createPinia())
  // The stores build their services from the bridge; nothing here reaches it (`open` is stubbed).
  ;(window as unknown as { posApi: unknown }).posApi = {
    preferences: { getUser: vi.fn(), setUser: vi.fn() }
  }
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('shift dialogs: touch numeric input', () => {
  it('opens a shift with an opening cash typed on the on-screen keypad by touch only', async () => {
    const shift = await openDialog(true)
    const open = vi.spyOn(shift, 'open').mockResolvedValue(true)

    // The pre-filled "0.00" is selected when the dialog focuses it, so the first key replaces it
    // (appending would be silently capped at two decimals and leave "0.00").
    expect(cashField().value).toBe('0.00')
    expect(document.activeElement).toBe(cashField())
    expect(cashField().selectionStart).toBe(0)
    expect(cashField().selectionEnd).toBe(4)

    await press('1', '5', '0', '.', '7', '5')
    expect(cashField().value).toBe('150.75')

    document
      .getElementById('shift-dialog-form')
      ?.dispatchEvent(new Event('submit', { cancelable: true }))
    await flushPromises()
    expect(open).toHaveBeenCalledWith({ openingCashAmount: 15075, notes: null })
  })

  it('keeps the keyboard field (no keypad) outside touch mode', async () => {
    await openDialog(false)
    expect(document.querySelector('[role="dialog"] [data-testid="numeric-keypad"]')).toBeNull()
    expect(cashField().value).toBe('0.00')
  })
})
