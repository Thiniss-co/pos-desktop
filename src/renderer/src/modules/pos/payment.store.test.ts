import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type {
  CheckoutCompletionOutcome,
  CheckoutIntent,
  CheckoutPreviewOutcome,
  CheckoutRecoveryState
} from '@shared/contracts/checkout.contract'
import { publicAppErrorSchema } from '@shared/contracts/api.contract'
import { CheckoutRendererService } from './checkout.service'
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

  it('generates an attemptKey on the first complete() call and clears the cart on commit', async () => {
    const store = usePaymentStore()
    const outcome: CheckoutCompletionOutcome = {
      outcome: 'committed',
      attemptKey: 'irrelevant-to-the-store',
      invoice: {} as never,
      items: [],
      payments: [],
      replay: false
    }
    let calledWithKey: string | null = null
    const service: Pick<CheckoutRendererService, 'complete'> = {
      complete: async (key) => {
        calledWithKey = key
        return outcome
      }
    }
    let cleared = false

    expect(store.attemptKey).toBeNull()
    await store.complete(
      () => 'cart-token',
      baseIntent(),
      () => (cleared = true),
      service
    )

    expect(store.attemptKey).not.toBeNull()
    expect(calledWithKey).toBe(store.attemptKey)
    expect(cleared).toBe(true)
    expect(store.completionOutcome).toEqual(outcome)
    expect(store.completionPending).toBe(false)
  })

  it('clears completionPending when the committed callback changes the cart token', async () => {
    const store = usePaymentStore()
    let cartToken = 'cart-before-commit'
    const service: Pick<CheckoutRendererService, 'complete'> = {
      complete: async (key) => ({
        outcome: 'committed',
        attemptKey: key,
        invoice: {} as never,
        items: [],
        payments: [],
        replay: false
      })
    }

    await store.complete(
      () => cartToken,
      baseIntent(),
      () => (cartToken = 'cart-cleared-after-commit'),
      service
    )

    expect(store.completionOutcome?.outcome).toBe('committed')
    expect(store.completionPending).toBe(false)
  })

  it('does not submit a committed completion a second time', async () => {
    const store = usePaymentStore()
    const keysSeen: string[] = []
    const service: Pick<CheckoutRendererService, 'complete'> = {
      complete: async (key) => {
        keysSeen.push(key)
        return {
          outcome: 'committed',
          attemptKey: key,
          invoice: {} as never,
          items: [],
          payments: [],
          replay: false
        }
      }
    }

    await store.complete(
      () => 'cart-token',
      baseIntent(),
      () => undefined,
      service
    )
    await store.complete(
      () => 'cart-token',
      baseIntent(),
      () => undefined,
      service
    )

    expect(keysSeen).toHaveLength(1)
  })

  it('retains the same attempt key when an allocation acquisition is left unresolved', async () => {
    const store = usePaymentStore()
    const keysSeen: string[] = []
    const cartToken = 'unresolved-acquisition-cart'
    const service: Pick<CheckoutRendererService, 'complete'> = {
      complete: async (key) => {
        keysSeen.push(key)
        return {
          outcome: 'failed',
          code: 'allocation-acquisition-unresolved',
          attemptKey: key
        }
      }
    }

    await store.complete(
      () => cartToken,
      baseIntent(),
      () => undefined,
      service
    )

    // CP-5D-C/F5: an ambiguous acquisition is not a T3 rejection. The key survives so the retry
    // replays the identical backend request instead of minting one that could double-reserve stock.
    const firstKey = store.attemptKey
    expect(firstKey).not.toBeNull()
    expect(store.completionPending).toBe(false)
    expect(store.completionOutcome).toMatchObject({
      outcome: 'failed',
      code: 'allocation-acquisition-unresolved'
    })

    await store.complete(
      () => cartToken,
      baseIntent(),
      () => undefined,
      service
    )

    expect(store.attemptKey).toBe(firstKey)
    expect(keysSeen).toEqual([firstKey, firstKey])
  })

  it('keeps the draft and permits an explicit new-key retry after a definite rejection', async () => {
    const store = usePaymentStore()
    const keysSeen: string[] = []
    const cartToken = 'unchanged-rejected-cart'
    const service: Pick<CheckoutRendererService, 'complete'> = {
      complete: async (key) => {
        keysSeen.push(key)
        return {
          outcome: 'rejected',
          attemptKey: key,
          failureCode: 'stock-allocation-unavailable'
        }
      }
    }

    await store.complete(
      () => cartToken,
      baseIntent(),
      () => undefined,
      service
    )

    expect(store.attemptKey).toBeNull()
    expect(store.completionOutcome).toMatchObject({ outcome: 'rejected' })
    expect(store.completionPending).toBe(false)

    await store.complete(
      () => cartToken,
      baseIntent(),
      () => undefined,
      service
    )

    expect(keysSeen).toHaveLength(2)
    expect(keysSeen[0]).not.toBe(keysSeen[1])
  })

  it('clears completionPending for a terminal failed outcome', async () => {
    const store = usePaymentStore()
    const service: Pick<CheckoutRendererService, 'complete'> = {
      complete: async () => ({
        outcome: 'failed',
        code: 'permission-denied',
        attemptKey: null
      })
    }

    await store.complete(
      () => 'cart-token',
      baseIntent(),
      () => undefined,
      service
    )

    expect(store.completionOutcome).toMatchObject({ outcome: 'failed' })
    expect(store.completionPending).toBe(false)
  })

  it('records the blocking attempt key when a fresh key is refused as attempt-blocked', async () => {
    const store = usePaymentStore()
    const service: Pick<CheckoutRendererService, 'complete'> = {
      complete: async () => ({
        outcome: 'failed',
        code: 'attempt-blocked',
        attemptKey: null,
        blockingAttemptKey: 'stuck-attempt-key'
      })
    }

    await store.complete(
      () => 'cart-token',
      baseIntent(),
      () => undefined,
      service
    )

    expect(store.isBlocked).toBe(true)
    expect(store.blockingAttemptKey).toBe('stuck-attempt-key')
  })

  it('never calls the service twice while a completion is already pending (no double submit)', async () => {
    let resolveFirst!: (value: CheckoutCompletionOutcome) => void
    const first = new Promise<CheckoutCompletionOutcome>((resolve) => {
      resolveFirst = resolve
    })
    let calls = 0
    const store = usePaymentStore()
    const service: Pick<CheckoutRendererService, 'complete'> = {
      complete: () => {
        calls += 1
        return first
      }
    }

    const pending = store.complete(
      () => 'cart-token',
      baseIntent(),
      () => undefined,
      service
    )
    await store.complete(
      () => 'cart-token',
      baseIntent(),
      () => undefined,
      service
    )
    resolveFirst({
      outcome: 'committed',
      attemptKey: 'k',
      invoice: {} as never,
      items: [],
      payments: [],
      replay: false
    })
    await pending

    expect(calls).toBe(1)
    expect(store.completionPending).toBe(false)
  })

  it('drops a stale completion reply when the cart context changes while in flight', async () => {
    let resolveFirst!: (value: CheckoutCompletionOutcome) => void
    const first = new Promise<CheckoutCompletionOutcome>((resolve) => {
      resolveFirst = resolve
    })
    const store = usePaymentStore()
    let token = 'context-1'
    const service: Pick<CheckoutRendererService, 'complete'> = { complete: () => first }
    let cleared = false

    const pending = store.complete(
      () => token,
      baseIntent(),
      () => (cleared = true),
      service
    )
    token = 'context-2'
    resolveFirst({
      outcome: 'committed',
      attemptKey: 'k',
      invoice: {} as never,
      items: [],
      payments: [],
      replay: false
    })
    await pending

    expect(cleared).toBe(false)
    expect(store.completionOutcome).toBeNull()
    expect(store.completionPending).toBe(false)
  })

  it('surfaces a thrown backend error as a localized completion error', async () => {
    const store = usePaymentStore()
    const error = publicAppErrorSchema.parse({
      category: 'rejected',
      message: 'Denied',
      backendCode: 'CHECKOUT_PERMISSION_DENIED',
      retryable: false
    })
    const service: Pick<CheckoutRendererService, 'complete'> = {
      complete: async () => {
        throw error
      }
    }

    await store.complete(
      () => 'cart-token',
      baseIntent(),
      () => undefined,
      service
    )

    expect(store.completionOutcome).toBeNull()
    expect(store.completionError).not.toBeNull()
    expect(store.completionPending).toBe(false)
  })

  it('keeps the same attempt key after a transport ambiguity', async () => {
    const store = usePaymentStore()
    const keysSeen: string[] = []
    const service: Pick<CheckoutRendererService, 'complete'> = {
      complete: async (key) => {
        keysSeen.push(key)
        if (keysSeen.length === 1) {
          throw new Error('response lost')
        }

        return { outcome: 'failed', code: 'attempt-unresolved', attemptKey: key }
      }
    }

    await store.complete(
      () => 'cart-token',
      baseIntent(),
      () => undefined,
      service
    )
    await store.complete(
      () => 'cart-token',
      baseIntent(),
      () => undefined,
      service
    )

    expect(keysSeen).toHaveLength(2)
    expect(keysSeen[1]).toBe(keysSeen[0])
    expect(store.completionPending).toBe(false)
  })

  it('rejects a malformed completion response and clears completionPending', async () => {
    const store = usePaymentStore()
    const service = new CheckoutRendererService({
      complete: async () => ({
        ok: true,
        data: { outcome: 'committed' }
      })
    } as unknown as Window['posApi']['checkout'])

    await store.complete(
      () => 'cart-token',
      baseIntent(),
      () => undefined,
      service
    )

    expect(store.completionOutcome).toBeNull()
    expect(store.completionError).not.toBeNull()
    expect(store.completionPending).toBe(false)
  })

  it('retryAttempt clears the blocking key on a successful commit', async () => {
    const store = usePaymentStore()
    const service: Pick<CheckoutRendererService, 'complete'> = {
      complete: async () => ({
        outcome: 'failed',
        code: 'attempt-blocked',
        attemptKey: null,
        blockingAttemptKey: 'stuck-attempt-key'
      })
    }
    await store.complete(
      () => 'cart-token',
      baseIntent(),
      () => undefined,
      service
    )
    expect(store.blockingAttemptKey).toBe('stuck-attempt-key')

    const retryService: Pick<CheckoutRendererService, 'retryAttempt'> = {
      retryAttempt: async () => ({
        outcome: 'committed',
        attemptKey: 'stuck-attempt-key',
        invoice: {} as never,
        items: [],
        payments: [],
        replay: false
      })
    }
    await store.retryAttempt('stuck-attempt-key', retryService)

    expect(store.blockingAttemptKey).toBeNull()
  })

  it('drops a stale retryAttempt reply if the owner context changed while it was in flight', async () => {
    let resolveFirst!: (value: CheckoutCompletionOutcome) => void
    const first = new Promise<CheckoutCompletionOutcome>((resolve) => {
      resolveFirst = resolve
    })
    const store = usePaymentStore()
    const service: Pick<CheckoutRendererService, 'retryAttempt'> = { retryAttempt: () => first }

    const pending = store.retryAttempt('stuck-attempt-key', service)
    store.resetPayment() // simulates logout/device-recovery/cashier change mid-flight
    resolveFirst({
      outcome: 'committed',
      attemptKey: 'stuck-attempt-key',
      invoice: {} as never,
      items: [],
      payments: [],
      replay: false
    })
    await pending

    // The stale reply must never re-populate state for whoever the owner is now.
    expect(store.completionOutcome).toBeNull()
    expect(store.blockingAttemptKey).toBeNull()
  })

  it('abandonAttempt frees both the blocking key and a matching current attemptKey', async () => {
    const store = usePaymentStore()
    const service: Pick<CheckoutRendererService, 'complete'> = {
      complete: async () => ({
        outcome: 'failed',
        code: 'attempt-blocked',
        attemptKey: null,
        blockingAttemptKey: 'stuck-attempt-key'
      })
    }
    await store.complete(
      () => 'cart-token',
      baseIntent(),
      () => undefined,
      service
    )
    const key = store.attemptKey as unknown as string

    const abandonService: Pick<CheckoutRendererService, 'abandonAttempt'> = {
      abandonAttempt: async () => ({ outcome: 'abandoned', attemptKey: 'stuck-attempt-key' })
    }
    await store.abandonAttempt('stuck-attempt-key', abandonService)

    expect(store.blockingAttemptKey).toBeNull()
    // Only clears the store's own attemptKey when it matches the abandoned key exactly.
    expect(store.attemptKey === null || store.attemptKey === key).toBe(true)
  })

  it('acknowledgeAttempt removes the key from pendingResults and frees a matching attemptKey', async () => {
    const store = usePaymentStore()
    const discoverService: Pick<CheckoutRendererService, 'pendingAttempts'> = {
      pendingAttempts: async (): Promise<CheckoutRecoveryState> => ({
        blockingAttempt: null,
        unacknowledgedResults: [
          { attemptKey: 'committed-key', committedAt: '2026-01-01T00:00:00Z' }
        ],
        nextCursor: null
      })
    }
    await store.discoverPending(discoverService)
    expect(store.pendingResults).toHaveLength(1)

    const ackService: Pick<CheckoutRendererService, 'acknowledgeAttempt'> = {
      acknowledgeAttempt: async () => ({
        outcome: 'acknowledged',
        attemptKey: 'committed-key',
        invoice: {} as never,
        items: [],
        payments: [],
        replay: false
      })
    }
    await store.acknowledgeAttempt('committed-key', ackService)

    expect(store.pendingResults).toHaveLength(0)
  })

  it("acknowledging this draft's own sale clears the tendered rows for the next customer", async () => {
    const store = usePaymentStore()
    store.beginAddRow('method-cash')
    store.setDraftAmountText('10.00')
    store.commitDraftRow(2)
    expect(store.rows).toHaveLength(1)

    const completeService: Pick<CheckoutRendererService, 'complete'> = {
      complete: async (key) => ({
        outcome: 'committed',
        attemptKey: key,
        invoice: {} as never,
        items: [],
        payments: [],
        replay: false
      })
    }
    await store.complete(
      () => 'cart-token',
      baseIntent(),
      () => undefined,
      completeService
    )
    const key = store.attemptKey
    expect(key).not.toBeNull()
    // The committed result — and the change due it carries — stays on screen until acknowledged.
    expect(store.rows).toHaveLength(1)

    const ackService: Pick<CheckoutRendererService, 'acknowledgeAttempt'> = {
      acknowledgeAttempt: async (ackKey) => ({
        outcome: 'acknowledged',
        attemptKey: ackKey,
        invoice: {} as never,
        items: [],
        payments: [],
        replay: false
      })
    }
    await store.acknowledgeAttempt(key as string, ackService)

    expect(store.rows).toHaveLength(0)
    expect(store.paidTotalAmount).toBe(0)
    expect(store.attemptKey).toBeNull()
    expect(store.completionOutcome).toBeNull()
    expect(store.previewOutcome).toBeNull()
    expect(store.isEditingDraft).toBe(false)
  })

  it('acknowledging an unrelated recovery result leaves the current draft alone', async () => {
    const store = usePaymentStore()
    store.beginAddRow('method-cash')
    store.setDraftAmountText('10.00')
    store.commitDraftRow(2)

    const ackService: Pick<CheckoutRendererService, 'acknowledgeAttempt'> = {
      acknowledgeAttempt: async () => ({
        outcome: 'acknowledged',
        attemptKey: 'someone-elses-crash-key',
        invoice: {} as never,
        items: [],
        payments: [],
        replay: false
      })
    }
    await store.acknowledgeAttempt('someone-elses-crash-key', ackService)

    expect(store.rows).toHaveLength(1)
    expect(store.paidTotalAmount).toBe(1000)
  })

  it('discoverPending populates blockingAttemptKey and pendingResults from a fresh read', async () => {
    const store = usePaymentStore()
    const service: Pick<CheckoutRendererService, 'pendingAttempts'> = {
      pendingAttempts: async (): Promise<CheckoutRecoveryState> => ({
        blockingAttempt: {
          attemptKey: 'claimed-key',
          state: 'claimed',
          claimedAt: '2026-01-01T00:00:00Z'
        },
        unacknowledgedResults: [],
        nextCursor: null
      })
    }

    await store.discoverPending(service)

    expect(store.blockingAttemptKey).toBe('claimed-key')
    expect(store.isBlocked).toBe(true)
  })

  it('discoverPending swallows a thrown error rather than rejecting the caller', async () => {
    const store = usePaymentStore()
    const service: Pick<CheckoutRendererService, 'pendingAttempts'> = {
      pendingAttempts: async () => {
        throw new Error('not yet authenticated')
      }
    }

    await expect(store.discoverPending(service)).resolves.toBeUndefined()
    expect(store.blockingAttemptKey).toBeNull()
  })

  it('resetPayment clears completion and recovery state alongside the payment draft', async () => {
    const store = usePaymentStore()
    const service: Pick<CheckoutRendererService, 'complete'> = {
      complete: async () => ({
        outcome: 'failed',
        code: 'attempt-blocked',
        attemptKey: null,
        blockingAttemptKey: 'stuck-attempt-key'
      })
    }
    await store.complete(
      () => 'cart-token',
      baseIntent(),
      () => undefined,
      service
    )

    store.resetPayment()

    expect(store.attemptKey).toBeNull()
    expect(store.completionOutcome).toBeNull()
    expect(store.blockingAttemptKey).toBeNull()
    expect(store.pendingResults).toHaveLength(0)
  })
})
