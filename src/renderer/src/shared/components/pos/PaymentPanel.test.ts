// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import PaymentPanel from './PaymentPanel.vue'
import type { DisplayPaymentMethodOption, DisplaySplitPayment } from './types'

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
    completionLabel: 'Complete sale'
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
  it('never binds a click handler to the completion control', () => {
    // A source sweep, not a DOM assertion: proves no @click appears anywhere near the button in
    // the template, so a future prop change alone cannot make it call anything.
    const completeButtonBlock = source.slice(
      source.indexOf('payment-panel__complete'),
      source.indexOf('</AppButton>', source.indexOf('payment-panel__complete'))
    )
    expect(completeButtonBlock).not.toContain('@click')
  })

  it('renders the completion control disabled with aria-disabled and no paid/saved wording', async () => {
    mountPanel()
    await Promise.resolve()

    const button = document.querySelector('.payment-panel__complete')
    expect(button?.hasAttribute('disabled')).toBe(true)
    expect(button?.getAttribute('aria-disabled')).toBe('true')
    const bodyText = document.body.textContent?.toLowerCase() ?? ''
    expect(bodyText).not.toMatch(/\bpaid\b|\bsaved\b|sale complete/)
    expect(document.body.textContent).toContain('has not been saved')
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
