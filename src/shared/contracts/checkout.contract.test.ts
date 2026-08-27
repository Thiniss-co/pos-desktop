import { describe, expect, it } from 'vitest'
import { checkoutIntentSchema } from './checkout.contract'

const PRODUCT_UUID = '00000000-0000-4000-8000-000000000001'
const METHOD_UUID = '00000000-0000-4000-8000-000000000002'
const CATALOG_REVISION = 'a'.repeat(64)

interface DiscountOverride {
  readonly discountType: 'fixed' | 'percentage' | null
  readonly discountValue: number
}

interface CheckoutIntentDraft {
  readonly draftRevision: number
  readonly catalogRevision: string
  readonly items: ReadonlyArray<{
    readonly id: string
    readonly productUuid: string
    readonly quantity: string
    readonly discountType: 'fixed' | 'percentage' | null
    readonly discountValue: number
  }>
  readonly invoiceDiscount: DiscountOverride
  readonly customerUuid: string | null
  readonly payments: ReadonlyArray<{
    readonly id: string
    readonly paymentMethodUuid: string
    readonly amount: number
    readonly reference: string | null
  }>
}

function baseIntent(): CheckoutIntentDraft {
  return buildIntent({})
}

function buildIntent(overrides: {
  readonly itemDiscount?: DiscountOverride
  readonly invoiceDiscount?: DiscountOverride
}): CheckoutIntentDraft {
  return {
    draftRevision: 1,
    catalogRevision: CATALOG_REVISION,
    items: [
      {
        id: 'item-1',
        productUuid: PRODUCT_UUID,
        quantity: '1.000',
        discountType: overrides.itemDiscount?.discountType ?? null,
        discountValue: overrides.itemDiscount?.discountValue ?? 0
      }
    ],
    invoiceDiscount: overrides.invoiceDiscount ?? { discountType: null, discountValue: 0 },
    customerUuid: null,
    payments: [{ id: 'payment-1', paymentMethodUuid: METHOD_UUID, amount: 1000, reference: null }]
  }
}

describe('checkoutIntentSchema', () => {
  it('accepts a well-formed intent', () => {
    expect(checkoutIntentSchema.safeParse(baseIntent()).success).toBe(true)
  })

  it('rejects an unknown top-level key', () => {
    const result = checkoutIntentSchema.safeParse({ ...baseIntent(), extra: true })
    expect(result.success).toBe(false)
  })

  it('rejects an unknown item key', () => {
    const intent = baseIntent()
    const result = checkoutIntentSchema.safeParse({
      ...intent,
      items: [{ ...intent.items[0], unitPriceAmount: 1000 }]
    })
    expect(result.success).toBe(false)
  })

  it('rejects an unknown payment key', () => {
    const intent = baseIntent()
    const result = checkoutIntentSchema.safeParse({
      ...intent,
      payments: [{ ...intent.payments[0], type: 'cash' }]
    })
    expect(result.success).toBe(false)
  })

  it('rejects duplicate item ids', () => {
    const intent = baseIntent()
    const result = checkoutIntentSchema.safeParse({
      ...intent,
      items: [intent.items[0], { ...intent.items[0], productUuid: METHOD_UUID }]
    })
    expect(result.success).toBe(false)
  })

  it('rejects duplicate payment ids', () => {
    const intent = baseIntent()
    const result = checkoutIntentSchema.safeParse({
      ...intent,
      payments: [intent.payments[0], intent.payments[0]]
    })
    expect(result.success).toBe(false)
  })

  it('allows duplicate payment method uuids across rows (split tender is not deduplicated)', () => {
    const intent = baseIntent()
    const result = checkoutIntentSchema.safeParse({
      ...intent,
      payments: [
        intent.payments[0],
        { id: 'payment-2', paymentMethodUuid: METHOD_UUID, amount: 500, reference: null }
      ]
    })
    expect(result.success).toBe(true)
  })

  it('rejects more than 100 items', () => {
    const intent = baseIntent()
    const items = Array.from({ length: 101 }, (_, index) => ({
      ...intent.items[0],
      id: `item-${index}`
    }))
    expect(checkoutIntentSchema.safeParse({ ...intent, items }).success).toBe(false)
  })

  it('rejects more than 20 payments', () => {
    const intent = baseIntent()
    const payments = Array.from({ length: 21 }, (_, index) => ({
      ...intent.payments[0],
      id: `payment-${index}`
    }))
    expect(checkoutIntentSchema.safeParse({ ...intent, payments }).success).toBe(false)
  })

  describe('type-dependent discount bounds (finding 4)', () => {
    const cases: ReadonlyArray<{
      readonly label: string
      readonly discountType: 'fixed' | 'percentage' | null
      readonly discountValue: number
      readonly accepted: boolean
    }> = [
      {
        label: 'percentage at the 10 000 bp ceiling',
        discountType: 'percentage',
        discountValue: 10_000,
        accepted: true
      },
      {
        label: 'percentage one over the ceiling',
        discountType: 'percentage',
        discountValue: 10_001,
        accepted: false
      },
      {
        label: 'percentage at the fixed ceiling (the r1 hole)',
        discountType: 'percentage',
        discountValue: 900_000_000_000_000,
        accepted: false
      },
      {
        label: 'fixed at the invoice-total ceiling',
        discountType: 'fixed',
        discountValue: 900_000_000_000_000,
        accepted: true
      },
      {
        label: 'fixed one over the ceiling',
        discountType: 'fixed',
        discountValue: 900_000_000_000_001,
        accepted: false
      },
      {
        label: 'null type with a zero value',
        discountType: null,
        discountValue: 0,
        accepted: true
      },
      {
        label: 'null type with a non-zero value',
        discountType: null,
        discountValue: 1,
        accepted: false
      }
    ]

    it.each(cases)('item discount: $label', ({ discountType, discountValue, accepted }) => {
      const result = checkoutIntentSchema.safeParse(
        buildIntent({ itemDiscount: { discountType, discountValue } })
      )
      expect(result.success).toBe(accepted)
    })

    it.each(cases)('invoice discount: $label', ({ discountType, discountValue, accepted }) => {
      const result = checkoutIntentSchema.safeParse(
        buildIntent({ invoiceDiscount: { discountType, discountValue } })
      )
      expect(result.success).toBe(accepted)
    })

    it('rejects a negative discount value for either type', () => {
      expect(
        checkoutIntentSchema.safeParse(
          buildIntent({ itemDiscount: { discountType: 'fixed', discountValue: -1 } })
        ).success
      ).toBe(false)
      expect(
        checkoutIntentSchema.safeParse(
          buildIntent({ itemDiscount: { discountType: 'percentage', discountValue: -1 } })
        ).success
      ).toBe(false)
    })
  })

  describe('fields the renderer may never set', () => {
    it('never accepts a unit price, currency, or tax field on an item', () => {
      const intent = baseIntent()
      for (const key of [
        'unitPriceAmount',
        'currency',
        'taxMode',
        'taxRateBasisPoints',
        'priceRevision'
      ]) {
        const result = checkoutIntentSchema.safeParse({
          ...intent,
          items: [{ ...intent.items[0], [key]: 1 }]
        })
        expect(result.success, `accepted forbidden item key "${key}"`).toBe(false)
      }
    })

    it('never accepts a resolved method type or activity flag on a payment', () => {
      const intent = baseIntent()
      for (const key of ['type', 'isActive', 'allowsChange', 'requiresReference']) {
        const result = checkoutIntentSchema.safeParse({
          ...intent,
          payments: [{ ...intent.payments[0], [key]: true }]
        })
        expect(result.success, `accepted forbidden payment key "${key}"`).toBe(false)
      }
    })

    it('never accepts a total, identity, or permission field at the top level', () => {
      const intent = baseIntent()
      for (const key of [
        'grandTotalAmount',
        'companyUuid',
        'deviceUuid',
        'userUuid',
        'shiftUuid',
        'permissions'
      ]) {
        const result = checkoutIntentSchema.safeParse({ ...intent, [key]: 'x' })
        expect(result.success, `accepted forbidden top-level key "${key}"`).toBe(false)
      }
    })
  })
})
