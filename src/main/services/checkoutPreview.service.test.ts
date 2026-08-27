import { describe, expect, it, vi } from 'vitest'
import type { CatalogProduct, CheckoutResolution } from '@shared/contracts/catalog.contract'
import type { CheckoutIntent } from '@shared/contracts/checkout.contract'
import { CheckoutPreviewService, type CheckoutPreviewDependencies } from './checkoutPreview.service'
import type { ShiftAuthority } from './shiftAuthority.service'

const PRODUCT_UUID = '00000000-0000-4000-8000-000000000001'
const METHOD_UUID = '00000000-0000-4000-8000-000000000002'
const SHIFT_UUID = '00000000-0000-4000-8000-000000000003'
const CATALOG_REVISION = 'a'.repeat(64)

const product: CatalogProduct = {
  uuid: PRODUCT_UUID,
  categoryUuid: '00000000-0000-4000-8000-000000000009',
  name: 'Sparkling Water',
  sku: null,
  barcode: null,
  description: null,
  unit: null,
  trackStock: false,
  availableQuantity: null,
  price: {
    amount: 1000,
    currency: 'EGP',
    source: 'product_base',
    revision: 'b'.repeat(64),
    validFrom: '2026-01-01T00:00:00+00:00',
    validUntil: '2026-01-04T00:00:00+00:00'
  },
  tax: { id: null, mode: 'none', rateBasisPoints: 0, revision: 'c'.repeat(64) }
}

function resolution(overrides: Partial<CheckoutResolution> = {}): CheckoutResolution {
  return {
    contract: {
      revision: CATALOG_REVISION,
      generatedAt: '2026-01-01T00:00:00+00:00',
      validUntil: '2026-01-04T00:00:00+00:00',
      currency: 'EGP',
      currencyExponent: 2,
      quantityScale: 3,
      minimumQuantity: '0.001',
      maximumQuantity: '999999.999',
      maximumUnitPrice: 1_000_000_000,
      maximumLineTotal: 900_000_000_000_000,
      maximumInvoiceTotal: 900_000_000_000_000,
      mixedTaxModePolicy: 'single_invoice_mode'
    },
    products: [product],
    paymentMethods: [
      {
        uuid: METHOD_UUID,
        name: 'Cash',
        code: 'cash',
        type: 'cash',
        isActive: true,
        allowsChange: true,
        requiresReference: false,
        sortOrder: 1
      }
    ],
    customer: null,
    snapshotRevision: CATALOG_REVISION,
    ...overrides
  }
}

function baseIntent(overrides: Partial<CheckoutIntent> = {}): CheckoutIntent {
  return {
    draftRevision: 5,
    catalogRevision: CATALOG_REVISION,
    items: [
      {
        id: 'item-1',
        productUuid: PRODUCT_UUID,
        quantity: '1.000',
        discountType: null,
        discountValue: 0
      }
    ],
    invoiceDiscount: { discountType: null, discountValue: 0 },
    customerUuid: null,
    payments: [{ id: 'payment-1', paymentMethodUuid: METHOD_UUID, amount: 1000, reference: null }],
    ...overrides
  }
}

const openShift: Extract<ShiftAuthority, { kind: 'open' }> = {
  kind: 'open',
  shiftUuid: SHIFT_UUID,
  observedAt: '2026-01-01T00:30:00.000Z'
}

interface Harness {
  readonly service: CheckoutPreviewService
  readonly assertAllowed: ReturnType<typeof vi.fn>
  readonly evaluate: ReturnType<typeof vi.fn>
  readonly hasPermission: ReturnType<typeof vi.fn>
  readonly resolveForSell: ReturnType<typeof vi.fn>
  readonly resolveForCheckout: ReturnType<typeof vi.fn>
}

function harness(
  options: {
    readonly hasPermission?: (permission: string) => boolean
    readonly shiftSequence?: readonly ShiftAuthority[]
    readonly resolutionSequence?: ReadonlyArray<CheckoutResolution | null>
    readonly evaluateAllowed?: boolean
  } = {}
): Harness {
  const shiftSequence = [...(options.shiftSequence ?? [openShift])]
  const resolutionSequence = [...(options.resolutionSequence ?? [resolution()])]

  const assertAllowed = vi.fn()
  const evaluate = vi.fn(() => ({ allowed: options.evaluateAllowed ?? true }))
  const hasPermission = vi.fn(options.hasPermission ?? (() => true))
  const resolveForSell = vi.fn(() =>
    shiftSequence.length > 1 ? shiftSequence.shift()! : shiftSequence[0]
  )
  const resolveForCheckout = vi.fn(() =>
    resolutionSequence.length > 1 ? resolutionSequence.shift()! : resolutionSequence[0]
  )

  const dependencies: CheckoutPreviewDependencies = {
    commercialAccess: { assertAllowed, evaluate: evaluate as never },
    permissions: { hasPermission },
    shiftAuthority: { resolveForSell: resolveForSell as never },
    catalog: { resolveForCheckout: resolveForCheckout as never },
    now: () => new Date('2026-01-01T01:00:00.000Z')
  }

  return {
    service: new CheckoutPreviewService(dependencies),
    assertAllowed,
    evaluate,
    hasPermission,
    resolveForSell,
    resolveForCheckout
  }
}

describe('CheckoutPreviewService.validate', () => {
  it('returns valid for an exact cash tender against a resolved product', () => {
    const { service } = harness()
    const outcome = service.validate(baseIntent())

    expect(outcome).toEqual({
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
          { id: 'payment-1', methodUuid: METHOD_UUID, type: 'cash', amount: 1000, reference: null }
        ],
        paidTotalAmount: 1000,
        changeDueAmount: 0,
        dueAmount: 0
      },
      changeDueAmount: 0,
      dueAmount: 0,
      warnings: [],
      catalogRevision: CATALOG_REVISION,
      draftRevision: 5,
      shiftObservedAt: openShift.observedAt,
      evaluatedAt: '2026-01-01T01:00:00.000Z'
    })
  })

  it('throws authorization and reads nothing further when commercialAccess denies sell', () => {
    const denied = { category: 'authorization', message: 'no', retryable: false }
    const { service, assertAllowed, hasPermission, resolveForSell, resolveForCheckout } = harness()
    assertAllowed.mockImplementation(() => {
      throw denied
    })

    expect(() => service.validate(baseIntent())).toThrow()
    expect(hasPermission).not.toHaveBeenCalled()
    expect(resolveForSell).not.toHaveBeenCalled()
    expect(resolveForCheckout).not.toHaveBeenCalled()
  })

  it('denies when pos.sell is independently missing, even though commercialAccess allows', () => {
    const { service, hasPermission, resolveForSell, resolveForCheckout } = harness({
      hasPermission: () => false
    })

    expect(() => service.validate(baseIntent())).toThrow(
      expect.objectContaining({ backendCode: 'CHECKOUT_PERMISSION_DENIED' })
    )
    expect(hasPermission).toHaveBeenCalledWith('pos.sell')
    expect(resolveForSell).not.toHaveBeenCalled()
    expect(resolveForCheckout).not.toHaveBeenCalled()
  })

  it('never consults shifts.view — only pos.sell is ever checked', () => {
    const { service, hasPermission } = harness()
    service.validate(baseIntent())

    for (const call of hasPermission.mock.calls) {
      expect(call[0]).toBe('pos.sell')
    }
  })

  const NON_OPEN_CASES: ReadonlyArray<{
    readonly label: string
    readonly authority: ShiftAuthority
    readonly state: string
  }> = [
    { label: 'paused', authority: { kind: 'not-open', status: 'paused' }, state: 'paused' },
    { label: 'closed', authority: { kind: 'not-open', status: 'closed' }, state: 'closed' },
    {
      label: 'cancelled',
      authority: { kind: 'not-open', status: 'cancelled' },
      state: 'cancelled'
    },
    {
      label: 'none',
      authority: { kind: 'none', observedAt: '2026-01-01T00:00:00.000Z' },
      state: 'none'
    },
    {
      label: 'reconciliation-required',
      authority: { kind: 'reconciliation-required', since: '2026-01-01T00:00:00.000Z' },
      state: 'reconciliation-required'
    },
    { label: 'unknown', authority: { kind: 'unknown' }, state: 'unknown' },
    { label: 'foreign', authority: { kind: 'foreign' }, state: 'foreign' }
  ]

  it.each(NON_OPEN_CASES)(
    'reports shift-unavailable ($state) for a $label shift and never returns valid',
    ({ authority, state }) => {
      const { service, resolveForCheckout } = harness({ shiftSequence: [authority] })
      const outcome = service.validate(baseIntent())

      expect(outcome).toEqual({ outcome: 'shift-unavailable', state })
      expect(resolveForCheckout).not.toHaveBeenCalled()
    }
  )

  it('returns refresh-required when the catalog revision has moved', () => {
    const { service } = harness({
      resolutionSequence: [
        resolution({ contract: { ...resolution().contract, revision: 'f'.repeat(64) } })
      ]
    })
    const outcome = service.validate(baseIntent())
    expect(outcome).toEqual({ outcome: 'refresh-required', draftRevision: 5 })
  })

  it('returns refresh-required when resolveForCheckout fails closed (missing product/customer)', () => {
    const { service } = harness({ resolutionSequence: [null] })
    const outcome = service.validate(baseIntent())
    expect(outcome).toEqual({ outcome: 'refresh-required', draftRevision: 5 })
  })

  it('returns invalid with the cart code and a null field when calculateCart rejects', () => {
    const { service } = harness()
    const outcome = service.validate(
      baseIntent({
        items: [
          {
            id: 'item-1',
            productUuid: PRODUCT_UUID,
            quantity: '1.000',
            discountType: 'fixed',
            discountValue: 5000
          }
        ]
      })
    )
    expect(outcome).toEqual({
      outcome: 'invalid',
      code: 'CART_DISCOUNT_EXCEEDS_AMOUNT',
      field: null,
      draftRevision: 5
    })
  })

  it('returns invalid with the payment code and field "payments" when calculatePayments rejects', () => {
    const { service } = harness()
    const outcome = service.validate(
      baseIntent({
        payments: [
          { id: 'payment-1', paymentMethodUuid: METHOD_UUID, amount: 600, reference: null }
        ]
      })
    )
    expect(outcome).toEqual({
      outcome: 'invalid',
      code: 'PAYMENT_INSUFFICIENT_TENDER',
      field: 'payments',
      draftRevision: 5
    })
  })

  it('returns context-changed when commercial access is revoked by the time of the late re-check', () => {
    const { service } = harness({ evaluateAllowed: false })
    const outcome = service.validate(baseIntent())
    expect(outcome).toEqual({ outcome: 'context-changed', draftRevision: 5 })
  })

  it('returns context-changed when the shift closes between the early and late check', () => {
    const { service } = harness({
      shiftSequence: [openShift, { kind: 'not-open', status: 'closed' }]
    })
    const outcome = service.validate(baseIntent())
    expect(outcome).toEqual({ outcome: 'context-changed', draftRevision: 5 })
  })

  it('returns context-changed when the shift uuid moved between the early and late check', () => {
    const reopened: Extract<ShiftAuthority, { kind: 'open' }> = {
      kind: 'open',
      shiftUuid: '00000000-0000-4000-8000-000000000099',
      observedAt: '2026-01-01T02:00:00.000Z'
    }
    const { service } = harness({ shiftSequence: [openShift, reopened] })
    const outcome = service.validate(baseIntent())
    expect(outcome).toEqual({ outcome: 'context-changed', draftRevision: 5 })
  })

  it('returns context-changed when the catalog is republished between the early and late check', () => {
    const first = resolution()
    const second = resolution({ contract: { ...first.contract, revision: 'f'.repeat(64) } })
    const { service } = harness({ resolutionSequence: [first, second] })
    const outcome = service.validate(baseIntent())
    expect(outcome).toEqual({ outcome: 'context-changed', draftRevision: 5 })
  })

  it('touches only read-only dependencies: no mutation method exists to call', () => {
    const { service, resolveForCheckout } = harness()
    service.validate(baseIntent())

    for (const call of resolveForCheckout.mock.calls) {
      expect(call[0]).toEqual({
        productUuids: [PRODUCT_UUID],
        paymentMethodUuids: [METHOD_UUID],
        customerUuid: null
      })
    }
  })
})
