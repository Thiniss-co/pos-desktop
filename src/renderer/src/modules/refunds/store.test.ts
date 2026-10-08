import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { publicAppErrorSchema } from '@shared/contracts/api.contract'
import { useRefundsStore } from './store'
import type { RefundsService } from './service'

const UUID_A = '00000000-0000-4000-8000-000000000001'
const UUID_B = '00000000-0000-4000-8000-000000000002'

function fakeService(overrides: Partial<RefundsService> = {}): RefundsService {
  return {
    getRefundable: vi.fn(),
    preview: vi.fn(),
    submit: vi.fn(),
    resume: vi.fn(),
    cancelPrepared: vi.fn(),
    ...overrides
  } as unknown as RefundsService
}

describe('refunds store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('opening the flow loads the refundable invoice', async () => {
    const service = fakeService({
      getRefundable: vi.fn().mockResolvedValue({
        invoiceLocalUuid: UUID_A,
        invoiceRemoteUuid: UUID_B,
        offlineNumber: 'POS-1',
        serverNumber: null,
        displayNumber: 'POS-1',
        soldAt: '2026-01-01T00:00:00Z',
        currency: 'USD',
        currencyExponent: 2,
        grandTotalAmount: 1000,
        refundCapable: true,
        lines: [
          {
            invoiceItemRemoteUuid: UUID_B,
            productName: 'Widget',
            quantitySold: '3.000',
            quantityRefunded: '0.000',
            quantityRefundable: '3.000',
            feasibility: { tier: 'ok', reasons: [] },
            taxMode: 'exclusive'
          }
        ]
      })
    })

    const store = useRefundsStore()
    await store.openForInvoice(UUID_A, service)

    expect(store.refundable?.lines.length).toBe(1)
    expect(store.isLoadingRefundable).toBe(false)
  })

  it('full selection: quantity equals the entire refundable amount', () => {
    const store = useRefundsStore()
    store.setLineQuantity(UUID_B, 3000)
    expect(store.selectedLines).toEqual([{ invoiceItemRemoteUuid: UUID_B, quantityMilli: 3000 }])
    expect(store.hasSelection).toBe(true)
  })

  it('partial selection: a lower quantity is preserved as-is', () => {
    const store = useRefundsStore()
    store.setLineQuantity(UUID_B, 1000)
    expect(store.selectedLines).toEqual([{ invoiceItemRemoteUuid: UUID_B, quantityMilli: 1000 }])
  })

  it('setting quantity to zero clears the selection', () => {
    const store = useRefundsStore()
    store.setLineQuantity(UUID_B, 1000)
    store.setLineQuantity(UUID_B, 0)
    expect(store.hasSelection).toBe(false)
  })

  it('changing a selection invalidates any existing preview (stale-preview rule)', async () => {
    const service = fakeService({
      preview: vi.fn().mockResolvedValue({
        previewId: 'preview-1',
        invoiceLocalUuid: UUID_A,
        stockReturned: true,
        lines: [],
        subtotalAmount: 1000,
        discountTotalAmount: 0,
        taxTotalAmount: 0,
        grandTotalAmount: 1000,
        currency: 'USD',
        currencyExponent: 2
      })
    })

    const store = useRefundsStore()
    store.invoiceLocalUuid = UUID_A
    store.setLineQuantity(UUID_B, 1000)
    await store.requestPreview(service)
    expect(store.preview).not.toBeNull()

    store.setLineQuantity(UUID_B, 2000)
    expect(store.preview).toBeNull()
  })

  it('double-click / rapid repeat: submit is a no-op while a submission is already in flight', async () => {
    let resolveSubmit: (value: unknown) => void = () => {}
    const submit = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveSubmit = resolve
        })
    ) as unknown as RefundsService['submit']
    const service = fakeService({ submit })

    const store = useRefundsStore()
    store.invoiceLocalUuid = UUID_A
    // @ts-expect-error -- test only sets the minimal preview shape this path reads
    store.preview = { previewId: 'p1', grandTotalAmount: 1000 }

    const firstCall = store.submit(service)
    const secondCall = store.submit(service) // fired while the first is still in flight

    resolveSubmit({
      localRefundUuid: UUID_A,
      state: 'accepted',
      remoteUuid: UUID_B,
      refundNumber: 'REF-1',
      errorCode: null
    })
    await firstCall
    await secondCall

    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('lost response / unresolved outcome can be resumed', async () => {
    const service = fakeService({
      resume: vi.fn().mockResolvedValue({
        localRefundUuid: UUID_A,
        state: 'accepted',
        remoteUuid: UUID_B,
        refundNumber: 'REF-1',
        errorCode: null
      })
    })

    const store = useRefundsStore()
    await store.resume(UUID_A, service)

    expect(store.outcome?.state).toBe('accepted')
    expect(service.resume).toHaveBeenCalledWith(UUID_A)
  })

  it('a permission-denied failure surfaces as an error without a stored outcome', async () => {
    const service = fakeService({
      getRefundable: vi.fn().mockRejectedValue(
        publicAppErrorSchema.parse({
          category: 'authorization',
          message: 'Refunds are not available for this workstation session.',
          backendCode: 'PERMISSION_DENIED',
          retryable: false
        })
      )
    })

    const store = useRefundsStore()
    await store.openForInvoice(UUID_A, service)

    expect(store.error).not.toBeNull()
    expect(store.outcome).toBeNull()
  })

  it('an offline/transport failure surfaces as an error', async () => {
    const service = fakeService({
      preview: vi.fn().mockRejectedValue(
        publicAppErrorSchema.parse({
          category: 'transport',
          message: 'network unreachable',
          retryable: true
        })
      )
    })

    const store = useRefundsStore()
    store.invoiceLocalUuid = UUID_A
    store.setLineQuantity(UUID_B, 1000)
    await store.requestPreview(service)

    expect(store.preview).toBeNull()
    expect(store.error).not.toBeNull()
  })

  it('never shows a preview, outcome or error that arrives after the session ended', async () => {
    let answerPreview!: (value: unknown) => void
    let failSubmit!: (error: unknown) => void
    let answerSubmit!: (value: unknown) => void
    const service = fakeService({
      preview: vi.fn(() => new Promise((resolve) => (answerPreview = resolve))),
      submit: vi
        .fn()
        .mockImplementationOnce(() => new Promise((_resolve, reject) => (failSubmit = reject)))
        .mockImplementationOnce(() => new Promise((resolve) => (answerSubmit = resolve)))
    } as unknown as Partial<RefundsService>)
    const store = useRefundsStore()

    // Cashier A's preview is in flight when A signs out.
    store.invoiceLocalUuid = UUID_A
    store.setLineQuantity(UUID_B, 1000)
    const previewing = store.requestPreview(service)
    store.reset()
    answerPreview({ previewId: 'preview-of-a', lines: [] })
    await previewing
    expect(store.preview).toBeNull()
    expect(store.isPreviewing).toBe(false)

    // A's submission is in flight when the session ends: its failure is not shown to the next one.
    store.invoiceLocalUuid = UUID_A
    store.setLineQuantity(UUID_B, 1000)
    store.preview = { previewId: 'preview-of-a' } as never
    const failing = store.submit(service)
    store.reset()
    failSubmit({ category: 'transport', message: 'late', retryable: true })
    await failing
    expect(store.error).toBeNull()

    // ...nor its outcome.
    store.invoiceLocalUuid = UUID_A
    store.setLineQuantity(UUID_B, 1000)
    store.preview = { previewId: 'preview-of-a' } as never
    const submitting = store.submit(service)
    store.reset()
    answerSubmit({ localRefundUuid: UUID_A, state: 'accepted' })
    await submitting
    expect(store.outcome).toBeNull()
    expect(store.isSubmitting).toBe(false)
  })

  it('reset clears selection, preview, and outcome', () => {
    const store = useRefundsStore()
    store.setLineQuantity(UUID_B, 1000)
    store.reset()

    expect(store.hasSelection).toBe(false)
    expect(store.preview).toBeNull()
    expect(store.outcome).toBeNull()
  })
})
