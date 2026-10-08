// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import PaymentPanel from './PaymentPanel.vue'
import type {
  DisplayPaymentMethodOption,
  DisplaySplitPayment,
  PaymentPanelRecoveryState
} from './types'

const source = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/shared/components/pos/PaymentPanel.vue'),
  'utf8'
)

const cashOption: DisplayPaymentMethodOption = {
  method: { id: 'cash-uuid', kind: 'cash', label: 'Cash' },
  eligible: true
}
const loyaltyOption: DisplayPaymentMethodOption = {
  method: { id: 'loyalty-uuid', kind: 'loyalty', label: 'Loyalty points' },
  eligible: false,
  ineligibleReason: 'Loyalty tender is not supported yet'
}

function baseProps(): InstanceType<typeof PaymentPanel>['$props'] {
  return {
    open: true,
    title: 'Payment',
    statusChipLabel: 'Validation preview — this sale has not been saved',
    subtotalLabel: 'Subtotal',
    subtotal: 'E£10.00',
    taxLabel: 'Tax',
    tax: 'E£0.00',
    totalLabel: 'Total',
    total: 'E£10.00',
    methodOptions: [cashOption, loyaltyOption],
    noMethodsTitle: 'No payment methods',
    noMethodsDescription: 'No methods are configured for this company.',
    rows: [],
    editRowLabel: 'Edit',
    removeRowLabel: 'Remove',
    isEditingDraft: false,
    draftAmountLabel: 'Amount',
    draftAmount: '',
    draftReferenceLabel: 'Reference',
    draftReference: '',
    requiresReference: false,
    cancelDraftLabel: 'Cancel',
    commitDraftLabel: 'Add',
    paidTotalLabel: 'Tendered',
    paidTotal: 'E£0.00',
    previewPending: false,
    previewPendingLabel: 'Validating…',
    previewIsError: false,
    completionLabel: 'Complete sale',
    completionEnabled: true,
    completionPending: false,
    completionPendingLabel: 'Completing sale…',
    completionIsError: false,
    completionRefreshAvailable: false,
    completionRefreshPending: false,
    refreshWorkstationLabel: 'Refresh workstation data',
    recoveryState: { kind: 'clear' } as PaymentPanelRecoveryState,
    retryLabel: 'Retry',
    abandonLabel: 'Abandon',
    acknowledgeLabel: 'Done',
    abandonWarning: 'Abandoning does not mean cash was returned. Verify the till first.',
    confirmAbandonLabel: 'Confirm abandon',
    cancelConfirmLabel: 'Never mind'
  }
}

let wrappers: VueWrapper[] = []

function mountPanel(props: Partial<ReturnType<typeof baseProps>> = {}): VueWrapper {
  const wrapper = mount(PaymentPanel, {
    props: { ...baseProps(), ...props },
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

describe('PaymentPanel', () => {
  it('binds the completion control to a bare complete emit, never renderer-supplied content', () => {
    // A source sweep, not a DOM assertion: the completion control (the normal-flow button, the
    // last `payment-panel__complete` block in the template) forwards no arguments, so a future
    // prop change alone cannot make it submit anything the parent did not already resolve.
    const start = source.indexOf(':disabled="!completionEnabled')
    const completeButtonBlock = source.slice(start, source.indexOf('</AppButton>', start))
    expect(completeButtonBlock).toContain('@click="emit(\'complete\')"')
  })

  it('renders the completion control enabled when completionEnabled is true', async () => {
    mountPanel()
    await Promise.resolve()

    const button = document.querySelector('.payment-panel__complete')
    expect(button?.hasAttribute('disabled')).toBe(false)
  })

  it('disables the completion control when completionEnabled is false or a completion is pending', async () => {
    const disabled = mountPanel({ completionEnabled: false })
    await Promise.resolve()
    expect(document.querySelector('.payment-panel__complete')?.hasAttribute('disabled')).toBe(true)
    disabled.unmount()

    mountPanel({ completionPending: true })
    await Promise.resolve()
    expect(document.querySelector('.payment-panel__complete')?.hasAttribute('disabled')).toBe(true)
    expect(document.body.textContent).toContain('Completing sale…')
  })

  it('emits complete when the completion control is activated', async () => {
    const wrapper = mountPanel()
    await Promise.resolve()

    const button = document.querySelector('.payment-panel__complete') as HTMLButtonElement
    button.click()
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('complete')).toHaveLength(1)
  })

  it('renders a completion rejection as an inline error alongside the enabled control', async () => {
    mountPanel({ completionMessage: 'The catalog changed, please retry', completionIsError: true })
    await Promise.resolve()

    const error = document.querySelector('.app-inline-error')
    expect(error?.textContent).toContain('The catalog changed, please retry')
  })

  it('offers the explicit workstation refresh action for an allocation rejection', async () => {
    const wrapper = mountPanel({
      completionMessage: 'This tracked product lacks workstation allocation.',
      completionIsError: true,
      completionRefreshAvailable: true
    })
    await Promise.resolve()

    const refreshButton = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Refresh workstation data')
    ) as HTMLButtonElement
    refreshButton.click()
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('refreshWorkstation')).toHaveLength(1)
  })

  it('shows the blocked recovery banner instead of the completion control, and wires retry', async () => {
    const wrapper = mountPanel({
      recoveryState: {
        kind: 'blocked',
        message: 'You have an unresolved sale. Retry or abandon it first.'
      }
    })
    await Promise.resolve()

    expect(document.body.textContent).toContain('unresolved sale')
    expect(document.querySelector('.payment-panel__complete')).toBeNull()

    const retryButton = Array.from(
      document.querySelectorAll('.payment-panel__recovery-actions button')
    ).find((button) => button.textContent?.includes('Retry')) as HTMLButtonElement
    retryButton.click()
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('retry')).toHaveLength(1)
    expect(wrapper.emitted('abandon')).toBeUndefined()
  })

  it('requires explicit confirmation with the tender warning before abandon actually fires', async () => {
    const wrapper = mountPanel({
      recoveryState: {
        kind: 'blocked',
        message: 'You have an unresolved sale. Retry or abandon it first.'
      }
    })
    await Promise.resolve()

    const abandonButton = Array.from(
      document.querySelectorAll('.payment-panel__recovery-actions button')
    ).find((button) => button.textContent?.includes('Abandon')) as HTMLButtonElement
    abandonButton.click()
    await wrapper.vm.$nextTick()

    // First click only reveals the warning — it must never fire the emit directly.
    expect(wrapper.emitted('abandon')).toBeUndefined()
    expect(document.body.textContent).toContain('Verify the till first')

    const confirmButton = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Confirm abandon')
    ) as HTMLButtonElement
    confirmButton.click()
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('abandon')).toHaveLength(1)
  })

  it('never mind cancels the abandon confirmation without emitting anything', async () => {
    const wrapper = mountPanel({
      recoveryState: {
        kind: 'blocked',
        message: 'You have an unresolved sale. Retry or abandon it first.'
      }
    })
    await Promise.resolve()

    const abandonButton = Array.from(
      document.querySelectorAll('.payment-panel__recovery-actions button')
    ).find((button) => button.textContent?.includes('Abandon')) as HTMLButtonElement
    abandonButton.click()
    await wrapper.vm.$nextTick()

    const cancelButton = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Never mind')
    ) as HTMLButtonElement
    cancelButton.click()
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('abandon')).toBeUndefined()
    expect(document.body.textContent).toContain('unresolved sale')
  })

  it('shows the awaiting-acknowledgment state and wires the acknowledge action, no complete control', async () => {
    const wrapper = mountPanel({
      recoveryState: { kind: 'awaiting-acknowledgment', message: 'Sale complete. Offline #1.' }
    })
    await Promise.resolve()

    expect(document.body.textContent).toContain('Sale complete')
    const doneButton = document.querySelector('.payment-panel__complete') as HTMLButtonElement
    expect(doneButton).not.toBeNull()
    expect(doneButton.hasAttribute('disabled')).toBe(false)

    doneButton.click()
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('acknowledge')).toHaveLength(1)
    expect(wrapper.emitted('complete')).toBeUndefined()
  })

  it('shows an explicit unavailable state for an empty method list rather than a synthesized method', async () => {
    mountPanel({ methodOptions: [] })
    await Promise.resolve()

    expect(document.body.textContent).toContain('No payment methods')
    expect(document.querySelectorAll('.payment-method-tile')).toHaveLength(0)
  })

  it('renders an ineligible method disabled with its reason, never hidden', async () => {
    mountPanel()
    await Promise.resolve()

    const buttons = document.querySelectorAll('.payment-method-tile')
    expect(buttons).toHaveLength(2)
    const loyaltyButton = buttons[1]
    expect(loyaltyButton.hasAttribute('disabled')).toBe(true)
    expect(loyaltyButton.getAttribute('title')).toBe('Loyalty tender is not supported yet')
  })

  it('emits selectMethod for an eligible tile', async () => {
    const wrapper = mountPanel()
    await Promise.resolve()

    const cashButton = document.querySelectorAll('.payment-method-tile')[0] as HTMLButtonElement
    cashButton.click()
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('selectMethod')).toEqual([['cash-uuid']])
  })

  it('activates edit when a row is clicked, but not when its remove button is clicked', async () => {
    const rows: DisplaySplitPayment[] = [{ id: 'row-1', methodLabel: 'Cash', amount: 'E£10.00' }]
    const wrapper = mountPanel({ rows })
    await Promise.resolve()

    const amount = document.querySelector('.split-payment-row__amount') as HTMLElement
    amount.click()
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('editRow')).toEqual([['row-1']])

    const removeButton = document.querySelector('.split-payment-row button') as HTMLButtonElement
    removeButton.click()
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('removeRow')).toEqual([['row-1']])
    expect(wrapper.emitted('editRow')).toHaveLength(1)
  })

  it('shows the reference field only when the active method requires one', async () => {
    const withoutReference = mountPanel({ isEditingDraft: true, requiresReference: false })
    await Promise.resolve()
    expect(document.querySelector('.payment-panel__reference')).toBeNull()
    withoutReference.unmount()

    mountPanel({ isEditingDraft: true, requiresReference: true })
    await Promise.resolve()
    expect(document.querySelector('.payment-panel__reference')).not.toBeNull()
  })

  it('touch mode: the on-screen keypad edits the tender amount in place', async () => {
    const wrapper = mountPanel({
      isEditingDraft: true,
      draftAmount: '1',
      keypadLabels: { backspace: 'Delete last digit', clear: 'Clear', decimal: 'Decimal point' }
    })
    await Promise.resolve()
    const press = async (key: string): Promise<void> => {
      ;(document.querySelector(`[data-key="${key}"]`) as HTMLButtonElement).click()
      await wrapper.vm.$nextTick()
    }

    await press('5')
    expect(wrapper.emitted('update:draftAmount')?.at(-1)).toEqual(['15'])
    await wrapper.setProps({ draftAmount: '15' })
    await press('.')
    expect(wrapper.emitted('update:draftAmount')?.at(-1)).toEqual(['15.'])
    await press('back')
    expect(wrapper.emitted('update:draftAmount')?.at(-1)).toEqual(['1'])
    // The keypad never commits or completes on its own: only the draft amount changes.
    expect(wrapper.emitted('commitDraft')).toBeUndefined()
    expect(wrapper.emitted('complete')).toBeUndefined()
  })

  it('outside touch mode the tender amount has no on-screen keypad', async () => {
    mountPanel({ isEditingDraft: true, draftAmount: '1' })
    await Promise.resolve()

    expect(document.querySelector('.numeric-amount-input__control')).not.toBeNull()
    expect(document.querySelector('[data-key]')).toBeNull()
  })

  it('commits the draft on Enter and cancels on Escape from the amount field', async () => {
    const wrapper = mountPanel({ isEditingDraft: true, draftAmount: '10.00' })
    await Promise.resolve()

    const input = document.querySelector('.numeric-amount-input__control') as HTMLInputElement
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('commitDraft')).toHaveLength(1)

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('cancelDraft')).toHaveLength(1)
  })

  it('shows the pending message while a preview is in flight and hides it otherwise', async () => {
    const pending = mountPanel({ previewPending: true, previewPendingLabel: 'Validating…' })
    await Promise.resolve()
    expect(document.body.textContent).toContain('Validating…')
    pending.unmount()

    mountPanel()
    await Promise.resolve()
    expect(document.querySelector('.payment-panel__pending')).toBeNull()
  })

  it('renders a business rejection as an inline error', async () => {
    mountPanel({
      previewMessage: 'Reduce the cash amount to avoid a rejection',
      previewIsError: true
    })
    await Promise.resolve()

    const error = document.querySelector('.app-inline-error')
    expect(error?.textContent).toContain('Reduce the cash amount to avoid a rejection')
  })

  it('always renders as a modal compact-sheet dialog, never in place', async () => {
    mountPanel()
    await Promise.resolve()

    const dialog = document.querySelector('[aria-modal="true"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.classList.contains('app-dialog--xl')).toBe(true)
    expect(dialog?.classList.contains('app-dialog--sheet')).toBe(true)
    expect(dialog?.classList.contains('payment-panel')).toBe(true)
    expect(document.querySelector('.inline-panel-frame')).toBeNull()
    expect(document.querySelector('.payment-panel__complete')).not.toBeNull()
  })

  it('emits the chosen quick tender and hides quick tenders while recovery is pending', async () => {
    const wrapper = mountPanel({
      quickTenders: [
        { id: '3740', label: 'Exact 37.40', exact: true },
        { id: '5000', label: '50.00' }
      ]
    })
    await Promise.resolve()

    const tenders = document.querySelectorAll<HTMLButtonElement>('.payment-panel__quick-tender')
    expect(tenders).toHaveLength(2)
    tenders[1].click()
    expect(wrapper.emitted('quickTender')).toEqual([['5000']])

    await wrapper.setProps({ recoveryState: { kind: 'blocked', message: 'Blocked' } })
    expect(document.querySelectorAll('.payment-panel__quick-tender')).toHaveLength(0)
  })
})

interface PanelKeyboardApi {
  activatePrimary: () => string | null
  activateExactCash: () => string | null
  activatePrint: () => string | null
}

const doneState: PaymentPanelRecoveryState = {
  kind: 'awaiting-acknowledgment',
  message: 'Sale complete. Offline #1.'
}
const blockedState: PaymentPanelRecoveryState = {
  kind: 'blocked',
  message: 'You have an unresolved sale. Retry or abandon it first.'
}

function commitControl(action: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`[data-commit-action="${action}"]`)
}

function describedText(element: Element | null): string | null | undefined {
  const id = element?.getAttribute('aria-describedby')
  return id ? document.getElementById(id)?.textContent : null
}

describe('PaymentPanel — keyboard safety contract', () => {
  it('marks every commit-class control, with its key hint and aria-keyshortcuts', async () => {
    const wrapper = mountPanel({
      exactCash: { label: 'Complete · Exact cash · Cash · E£10.00', keyHint: 'Shift+F9' },
      keyDescriptions: {
        complete: 'Press F9 to complete the sale',
        'exact-cash': 'Press Shift+F9 to complete with exact cash',
        print: 'Press Ctrl+P to print the receipt',
        acknowledge: 'Press F9 to start a new sale',
        retry: 'Press F9 to retry',
        'confirm-abandon': 'Press F9 to confirm'
      },
      printReceiptLabel: 'Print receipt'
    })
    await flushPromises()

    const complete = commitControl('complete')
    expect(complete?.classList.contains('payment-panel__complete')).toBe(true)
    expect(complete?.getAttribute('aria-keyshortcuts')).toBe('F9')
    expect(complete?.textContent).toContain('F9')
    expect(describedText(complete)).toBe('Press F9 to complete the sale')

    const exact = commitControl('exact-cash')
    expect(exact?.textContent).toContain('Complete · Exact cash · Cash · E£10.00')
    expect(exact?.textContent).toContain('Shift+F9')
    expect(exact?.getAttribute('aria-keyshortcuts')).toBe('Shift+F9')
    expect(describedText(exact)).toBe('Press Shift+F9 to complete with exact cash')

    await wrapper.setProps({ recoveryState: doneState })
    await flushPromises()
    const print = commitControl('print')
    expect(print?.textContent).toContain('Ctrl+P')
    expect(print?.getAttribute('aria-keyshortcuts')).toBe('Control+P')
    expect(describedText(print)).toBe('Press Ctrl+P to print the receipt')
    const acknowledge = commitControl('acknowledge')
    expect(acknowledge?.getAttribute('aria-keyshortcuts')).toBe('F9')
    expect(describedText(acknowledge)).toBe('Press F9 to start a new sale')
    expect(commitControl('complete')).toBeNull()

    await wrapper.setProps({ recoveryState: blockedState })
    await flushPromises()
    const retry = commitControl('retry')
    expect(retry?.textContent).toContain('Retry')
    expect(retry?.getAttribute('aria-keyshortcuts')).toBe('F9')
    expect(describedText(retry)).toBe('Press F9 to retry')

    const abandon = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.payment-panel__recovery-actions button')
    ).find((button) => button.textContent?.includes('Abandon'))
    expect(abandon?.hasAttribute('data-commit-action')).toBe(false)
    abandon?.click()
    await flushPromises()
    const confirm = commitControl('confirm-abandon')
    expect(confirm?.textContent).toContain('Confirm abandon')
    expect(confirm?.getAttribute('aria-keyshortcuts')).toBe('F9')
    expect(describedText(confirm)).toBe('Press F9 to confirm')
  })

  it('omits aria-describedby when no description is supplied, and honours custom key hints', async () => {
    mountPanel({ primaryKeyHint: 'F10' })
    await flushPromises()

    const complete = commitControl('complete')
    expect(complete?.hasAttribute('aria-describedby')).toBe(false)
    expect(complete?.getAttribute('aria-keyshortcuts')).toBe('F10')
    expect(complete?.textContent).toContain('F10')
  })

  it('renders no <form> in any step, and no editable field once the sale is committed', async () => {
    const wrapper = mountPanel({ isEditingDraft: true, requiresReference: true })
    await flushPromises()
    expect(document.querySelector('.app-dialog')).not.toBeNull()
    expect(document.querySelector('form')).toBeNull()

    await wrapper.setProps({ recoveryState: blockedState })
    await flushPromises()
    expect(document.querySelector('form')).toBeNull()

    await wrapper.setProps({ recoveryState: doneState, printReceiptLabel: 'Print receipt' })
    await flushPromises()
    expect(document.querySelector('form')).toBeNull()
    expect(
      document.querySelector(
        '.app-dialog input, .app-dialog textarea, .app-dialog select, .app-dialog [contenteditable]'
      )
    ).toBeNull()
  })

  it('opens the tender step with focus on the Total due heading, never the amount field or Complete', async () => {
    mountPanel({ isEditingDraft: true, draftMethodLabel: 'Cash', draftAmount: '10.00' })
    await flushPromises()

    const heading = document.querySelector('.payment-panel__total-heading') as HTMLElement
    expect(heading.tagName).toBe('H3')
    expect(heading.getAttribute('tabindex')).toBe('-1')
    expect(heading.hasAttribute('data-autofocus')).toBe(true)
    expect(heading.textContent).toContain('Total')
    expect(heading.textContent).toContain('E£10.00')
    expect(document.activeElement).toBe(heading)

    expect(
      document.querySelector('.numeric-amount-input__control')?.hasAttribute('data-autofocus')
    ).toBe(false)
    expect(document.querySelector('.payment-panel__complete')?.hasAttribute('data-autofocus')).toBe(
      false
    )
    expect(document.querySelectorAll('.app-dialog [data-autofocus]')).toHaveLength(1)
  })

  it('moves focus to the amount field when a payment method tile is activated', async () => {
    const wrapper = mountPanel({
      onSelectMethod: () => {
        void wrapper.setProps({
          isEditingDraft: true,
          draftMethodLabel: 'Cash',
          draftAmount: '10.00'
        })
      }
    })
    await flushPromises()

    const tile = document.querySelectorAll<HTMLButtonElement>('.payment-method-tile')[0]
    tile.focus()
    tile.click()
    await flushPromises()

    expect(wrapper.emitted('selectMethod')).toEqual([['cash-uuid']])
    expect(document.activeElement).toBe(document.querySelector('.numeric-amount-input__control'))
  })

  it('moves focus to each step’s own target as the dialog advances', async () => {
    const wrapper = mountPanel({ printReceiptLabel: 'Print receipt' })
    await flushPromises()

    await wrapper.setProps({ recoveryState: doneState })
    await flushPromises()
    expect(document.activeElement).toBe(commitControl('acknowledge'))

    await wrapper.setProps({ recoveryState: blockedState })
    await flushPromises()
    expect(document.activeElement).toBe(commitControl('retry'))
  })

  it('renders exactCash and addRemaining, each with its own emit', async () => {
    const wrapper = mountPanel({
      exactCash: { label: 'Complete · Exact cash · Cash · E£10.00', keyHint: 'Shift+F9' },
      addRemaining: { label: 'Add remaining E£10.00' }
    })
    await flushPromises()

    commitControl('exact-cash')?.click()
    expect(wrapper.emitted('exactCash')).toHaveLength(1)
    expect(wrapper.emitted('complete')).toBeUndefined()

    const addRemaining = document.querySelector<HTMLButtonElement>('.payment-panel__add-remaining')
    expect(addRemaining?.textContent).toContain('Add remaining E£10.00')
    expect(addRemaining?.hasAttribute('data-commit-action')).toBe(false)
    addRemaining?.click()
    expect(wrapper.emitted('addRemaining')).toHaveLength(1)
    expect(wrapper.emitted('complete')).toBeUndefined()
  })

  it('hides exactCash and addRemaining when null (the default)', async () => {
    mountPanel()
    await flushPromises()

    expect(commitControl('exact-cash')).toBeNull()
    expect(document.querySelector('.payment-panel__add-remaining')).toBeNull()
  })

  it('renders every supplied notice in the footer live region', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    const region = document.querySelector('.payment-panel__notices') as HTMLElement
    expect(region.getAttribute('role')).toBe('status')
    expect(region.textContent?.trim()).toBe('')

    await wrapper.setProps({
      scannerNotice: 'Scanner input ignored while paying',
      largeChangeWarning: 'Change due is unusually large — check the amount',
      collectingHint: 'Scanning… (Esc to cancel)',
      heldScansNotice: '2 scans held for the next sale'
    })
    expect(region.textContent).toContain('Scanner input ignored while paying')
    expect(region.textContent).toContain('Change due is unusually large')
    expect(region.textContent).toContain('Scanning… (Esc to cancel)')
    expect(region.textContent).toContain('2 scans held for the next sale')
    expect(region.querySelectorAll('.payment-panel__notice')).toHaveLength(4)
    // Advisory only: the completion control stays as enabled as the parent says.
    expect(document.querySelector('.payment-panel__complete')?.hasAttribute('disabled')).toBe(false)
  })

  it('ignores Enter from IME composition, auto-repeat, or an event already handled upstream', async () => {
    const wrapper = mountPanel({ isEditingDraft: true, draftAmount: '10.00' })
    await flushPromises()
    const input = document.querySelector('.numeric-amount-input__control') as HTMLInputElement

    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })
    )
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true }))
    const upstream = (event: Event): void => event.preventDefault()
    window.addEventListener('keydown', upstream, { capture: true })
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    )
    window.removeEventListener('keydown', upstream, { capture: true })
    expect(wrapper.emitted('commitDraft')).toBeUndefined()

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(wrapper.emitted('commitDraft')).toHaveLength(1)
    expect(wrapper.emitted('complete')).toBeUndefined()
  })

  it('Escape in the draft field cancels the draft without closing the dialog', async () => {
    const wrapper = mountPanel({ isEditingDraft: true, requiresReference: true })
    await flushPromises()

    const reference = document.querySelector('.payment-panel__reference-input') as HTMLInputElement
    reference.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()

    expect(wrapper.emitted('cancelDraft')).toHaveLength(1)
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  it('exposes the keyboard path, which does exactly what the visible control would', async () => {
    const wrapper = mountPanel({
      completionEnabled: false,
      exactCash: { label: 'Complete · Exact cash', keyHint: 'Shift+F9' }
    })
    await flushPromises()
    const api = wrapper.vm as unknown as PanelKeyboardApi

    expect(api.activatePrimary()).toBeNull()
    expect(wrapper.emitted('complete')).toBeUndefined()
    expect(api.activatePrint()).toBeNull()
    expect(api.activateExactCash()).toBe('exact-cash')
    expect(wrapper.emitted('exactCash')).toHaveLength(1)

    await wrapper.setProps({ completionEnabled: true })
    expect(api.activatePrimary()).toBe('complete')
    expect(wrapper.emitted('complete')).toHaveLength(1)

    await wrapper.setProps({ recoveryState: blockedState })
    expect(api.activatePrimary()).toBe('retry')
    expect(wrapper.emitted('retry')).toHaveLength(1)
    expect(api.activateExactCash()).toBeNull()

    const abandon = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.payment-panel__recovery-actions button')
    ).find((button) => button.textContent?.includes('Abandon'))
    abandon?.click()
    await flushPromises()
    expect(api.activatePrimary()).toBe('confirm-abandon')
    expect(wrapper.emitted('abandon')).toHaveLength(1)

    await wrapper.setProps({ recoveryState: doneState, printReceiptLabel: 'Print receipt' })
    expect(api.activatePrint()).toBe('print')
    expect(wrapper.emitted('print')).toHaveLength(1)
    expect(api.activatePrimary()).toBe('acknowledge')
    expect(wrapper.emitted('acknowledge')).toHaveLength(1)
  })
})

describe('PaymentPanel — draft focus return', () => {
  it('returns focus to the Total due heading when the focused draft field goes away', async () => {
    const wrapper = mountPanel({ isEditingDraft: true, draftAmount: '10.00' })
    await flushPromises()
    const input = document.querySelector('.numeric-amount-input__control') as HTMLInputElement
    input.focus()
    expect(document.activeElement).toBe(input)

    await wrapper.setProps({ isEditingDraft: false })
    await flushPromises()

    expect(document.activeElement).toBe(document.querySelector('.payment-panel__total-heading'))
  })
})
