// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
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
})
