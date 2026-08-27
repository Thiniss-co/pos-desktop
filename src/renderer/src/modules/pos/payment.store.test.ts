import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { CheckoutIntent, CheckoutPreviewOutcome } from '@shared/contracts/checkout.contract'
import { publicAppErrorSchema } from '@shared/contracts/api.contract'
import type { CheckoutRendererService } from './checkout.service'
import { usePaymentStore } from './payment.store'

function baseIntent(): CheckoutIntent {
  return {
    draftRevision: 1,
    catalogRevision: 'a'.repeat(64),
    items: [
      {
        id: 'item-1',
        productUuid: '11111111-1111-4111-8111-111111111111',
        quantity: '1.000',
        discountType: null,
        discountValue: 0
      }
    ],
    invoiceDiscount: { discountType: null, discountValue: 0 },
    customerUuid: null,
    payments: [
      {
        id: 'payment-1',
        paymentMethodUuid: '22222222-2222-4222-8222-222222222222',
        amount: 1000,
        reference: null
      }
    ]
  }
}

const validOutcome: CheckoutPreviewOutcome = {
  outcome: 'valid',
  totals: {
    lines: [
      { id: 'item-1', subtotalAmount: 1000, discountAmount: 0, taxAmount: 0, totalAmount: 1000 }
    ],
    subtotalAmount: 1000,
    discountTotalAmount: 0,
    taxTotalAmount: 0,
    grandTotalAmount: 1000
  },
  payments: {
    rows: [
      {
        id: 'payment-1',
        methodUuid: '22222222-2222-4222-8222-222222222222',
        type: 'cash',
        amount: 1000,
        reference: null
      }
    ],
    paidTotalAmount: 1000,
    changeDueAmount: 0,
    dueAmount: 0
  },
  changeDueAmount: 0,
  dueAmount: 0,
  warnings: [],
  catalogRevision: 'a'.repeat(64),
  draftRevision: 1,
  shiftObservedAt: '2026-01-01T00:00:00Z',
  evaluatedAt: '2026-01-01T00:00:00Z'
}

describe('usePaymentStore', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('adds a new row on commit and clears the draft', () => {
    const store = usePaymentStore()
    store.beginAddRow('method-cash')
    store.setDraftAmountText('10.00')

    expect(store.commitDraftRow(2)).toBe(true)
    expect(store.rows).toEqual([
      { id: expect.any(String), methodUuid: 'method-cash', amount: 1000, reference: null }
    ])
    expect(store.isEditingDraft).toBe(false)
    expect(store.draftAmountText).toBe('')
    expect(store.paymentRevision).toBe(1)
  })

  it('rejects a malformed draft amount without adding a row', () => {
    const store = usePaymentStore()
    store.beginAddRow('method-cash')
    store.setDraftAmountText('not a number')

    expect(store.commitDraftRow(2)).toBe(false)
    expect(store.rows).toHaveLength(0)
    expect(store.draftErrorCode).toBe('MONEY_INPUT_INVALID')
    expect(store.paymentRevision).toBe(0)
  })

  it('edits an existing row in place rather than adding a second one', () => {
    const store = usePaymentStore()
    store.beginAddRow('method-cash')
    store.setDraftAmountText('10.00')
    store.commitDraftRow(2)
    const rowId = store.rows[0].id

    store.beginEditRow(rowId)
    expect(store.activeMethodUuid).toBe('method-cash')
    store.setDraftAmountText('15.00')
    store.setDraftReferenceText('auth-123')
    expect(store.commitDraftRow(2)).toBe(true)

    expect(store.rows).toEqual([
      { id: rowId, methodUuid: 'method-cash', amount: 1500, reference: 'auth-123' }
    ])
  })

  it('cancels the draft without changing any committed row', () => {
    const store = usePaymentStore()
    store.beginAddRow('method-cash')
    store.setDraftAmountText('10.00')
    store.commitDraftRow(2)

    store.beginEditRow(store.rows[0].id)
    store.setDraftAmountText('999.00')
    store.cancelDraftRow()

    expect(store.isEditingDraft).toBe(false)
    expect(store.rows[0].amount).toBe(1000)
  })

  it('removes a row and cancels an in-progress edit of that same row', () => {
    const store = usePaymentStore()
    store.beginAddRow('method-cash')
    store.setDraftAmountText('10.00')
    store.commitDraftRow(2)
    const rowId = store.rows[0].id

    store.beginEditRow(rowId)
    store.removeRow(rowId)

    expect(store.rows).toHaveLength(0)
    expect(store.isEditingDraft).toBe(false)
  })

  it('keeps duplicate-method rows independent (split tender is never aggregated)', () => {
    const store = usePaymentStore()
    store.beginAddRow('method-cash')
    store.setDraftAmountText('5.00')
    store.commitDraftRow(2)
    store.beginAddRow('method-cash')
    store.setDraftAmountText('5.00')
    store.commitDraftRow(2)

    expect(store.rows).toHaveLength(2)
    expect(store.paidTotalAmount).toBe(1000)
  })

  it('resets to empty and bumps contextGeneration on resetPayment', () => {
    const store = usePaymentStore()
    store.beginAddRow('method-cash')
    store.setDraftAmountText('10.00')
    store.commitDraftRow(2)
    const generationBefore = store.contextGeneration

    store.resetPayment()

    expect(store.rows).toHaveLength(0)
    expect(store.isEditingDraft).toBe(false)
    expect(store.contextGeneration).toBe(generationBefore + 1)
    expect(store.previewOutcome).toBeNull()
  })

  it('accepts a valid preview reply and clears any prior error', async () => {
    const store = usePaymentStore()
    const service: Pick<CheckoutRendererService, 'validate'> = {
      validate: async () => validOutcome
    }

    await store.refreshPreview(() => 'cart-token', baseIntent(), service)

    expect(store.previewOutcome).toEqual(validOutcome)
    expect(store.previewPending).toBe(false)
  })

  it('drops a stale reply when the cart context changes while the request is in flight', async () => {
    let resolveFirst!: (value: CheckoutPreviewOutcome) => void
    const first = new Promise<CheckoutPreviewOutcome>((resolve) => {
      resolveFirst = resolve
    })
    const store = usePaymentStore()
    let token = 'context-1'
    const service: Pick<CheckoutRendererService, 'validate'> = { validate: () => first }

    const pending = store.refreshPreview(() => token, baseIntent(), service)
    token = 'context-2'
    resolveFirst({ ...validOutcome, draftRevision: 999 })
    await pending

    expect(store.previewOutcome).toBeNull()
  })

  it('drops a stale reply when a row is committed while the request is in flight', async () => {
    let resolveFirst!: (value: CheckoutPreviewOutcome) => void
    const first = new Promise<CheckoutPreviewOutcome>((resolve) => {
      resolveFirst = resolve
    })
    const store = usePaymentStore()
    const service: Pick<CheckoutRendererService, 'validate'> = { validate: () => first }

    const pending = store.refreshPreview(() => 'cart-token', baseIntent(), service)
    store.beginAddRow('method-card')
    store.setDraftAmountText('1.00')
    store.commitDraftRow(2)
    resolveFirst(validOutcome)
    await pending

    expect(store.previewOutcome).toBeNull()
  })

  it('surfaces a thrown backend error as a localized preview error', async () => {
    const store = usePaymentStore()
    const error = publicAppErrorSchema.parse({
      category: 'rejected',
      message: 'Denied',
      backendCode: 'CHECKOUT_PERMISSION_DENIED',
      retryable: false
    })
    const service: Pick<CheckoutRendererService, 'validate'> = {
      validate: async () => {
        throw error
      }
    }

    await store.refreshPreview(() => 'cart-token', baseIntent(), service)

    expect(store.previewOutcome).toBeNull()
    expect(store.previewError).not.toBeNull()
  })
})
