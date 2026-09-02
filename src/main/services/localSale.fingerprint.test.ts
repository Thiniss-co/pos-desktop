import { describe, expect, it } from 'vitest'
import {
  canonicalJson,
  milliToQuantity,
  normalizeReference,
  originContextFingerprint,
  quantityToMilli,
  semanticIntentFingerprint,
  type SemanticIntentInput
} from './localSale.fingerprint'

const baseInput: SemanticIntentInput = {
  companyUuid: '00000000-0000-4000-8000-000000000001',
  deviceUuid: '00000000-0000-4000-8000-000000000002',
  userUuid: '00000000-0000-4000-8000-000000000003',
  catalogRevision: 'a'.repeat(64),
  customerUuid: null,
  items: [
    {
      productUuid: '00000000-0000-4000-8000-000000000010',
      quantity: '1.500',
      discountType: null,
      discountValue: 0
    },
    {
      productUuid: '00000000-0000-4000-8000-000000000011',
      quantity: '2.000',
      discountType: 'fixed',
      discountValue: 100
    }
  ],
  invoiceDiscountType: null,
  invoiceDiscountValue: 0,
  payments: [
    { paymentMethodUuid: '00000000-0000-4000-8000-000000000020', amount: 1000, reference: null }
  ],
  notes: null
}

describe('quantityToMilli', () => {
  it('normalizes "1.5", "1.50", and "1.500" to one canonical value', () => {
    expect(quantityToMilli('1.5')).toBe(1500)
    expect(quantityToMilli('1.50')).toBe(1500)
    expect(quantityToMilli('1.500')).toBe(1500)
  })

  it('handles whole quantities with no fractional part', () => {
    expect(quantityToMilli('3')).toBe(3000)
  })
})

describe('milliToQuantity', () => {
  it('round-trips through quantityToMilli with exactly 3 fraction digits', () => {
    expect(milliToQuantity(1500)).toBe('1.500')
    expect(milliToQuantity(3000)).toBe('3.000')
    expect(milliToQuantity(1)).toBe('0.001')
    expect(quantityToMilli(milliToQuantity(2750))).toBe(2750)
  })
})

describe('normalizeReference', () => {
  it('trims like TrimStrings and turns an empty result into null', () => {
    expect(normalizeReference(' auth-123 ')).toBe('auth-123')
    expect(normalizeReference('   ')).toBeNull()
    expect(normalizeReference('')).toBeNull()
    expect(normalizeReference(null)).toBeNull()
  })
})

describe('semanticIntentFingerprint', () => {
  it('is stable for quantity strings that normalize to the same milli value', () => {
    const a = semanticIntentFingerprint(baseInput)
    const b = semanticIntentFingerprint({
      ...baseInput,
      items: [{ ...baseInput.items[0], quantity: '1.5' }, baseInput.items[1]]
    })

    expect(a).toBe(b)
  })

  it('changes when item order changes — order is semantic, never sorted', () => {
    const a = semanticIntentFingerprint(baseInput)
    const reordered = semanticIntentFingerprint({
      ...baseInput,
      items: [baseInput.items[1], baseInput.items[0]]
    })

    expect(a).not.toBe(reordered)
  })

  it('changes when payment order changes', () => {
    const secondPayment = {
      paymentMethodUuid: '00000000-0000-4000-8000-000000000021',
      amount: 500,
      reference: null
    }
    const a = semanticIntentFingerprint({
      ...baseInput,
      payments: [baseInput.payments[0], secondPayment]
    })
    const reordered = semanticIntentFingerprint({
      ...baseInput,
      payments: [secondPayment, baseInput.payments[0]]
    })

    expect(a).not.toBe(reordered)
  })

  it('treats a trimmed and untrimmed-but-equal reference identically', () => {
    const a = semanticIntentFingerprint({
      ...baseInput,
      payments: [{ ...baseInput.payments[0], reference: 'auth-1' }]
    })
    const b = semanticIntentFingerprint({
      ...baseInput,
      payments: [{ ...baseInput.payments[0], reference: ' auth-1 ' }]
    })

    expect(a).toBe(b)
  })

  it('zeroes discountValue whenever discountType is null, regardless of the raw input value', () => {
    const a = semanticIntentFingerprint({
      ...baseInput,
      invoiceDiscountType: null,
      invoiceDiscountValue: 0
    })
    const b = semanticIntentFingerprint({
      ...baseInput,
      invoiceDiscountType: null,
      invoiceDiscountValue: 999
    })

    expect(a).toBe(b)
  })

  it('changes when any owner identity field changes', () => {
    const a = semanticIntentFingerprint(baseInput)
    const differentUser = semanticIntentFingerprint({
      ...baseInput,
      userUuid: '00000000-0000-4000-8000-000000000099'
    })

    expect(a).not.toBe(differentUser)
  })

  it('excludes nothing but the named fields — notes participates', () => {
    const a = semanticIntentFingerprint({ ...baseInput, notes: null })
    const b = semanticIntentFingerprint({ ...baseInput, notes: 'gift wrap' })

    expect(a).not.toBe(b)
  })
})

describe('originContextFingerprint', () => {
  it('changes when the origin shift/branch/warehouse changes', () => {
    const input = {
      companyUuid: baseInput.companyUuid,
      deviceUuid: baseInput.deviceUuid,
      userUuid: baseInput.userUuid,
      originShiftUuid: '00000000-0000-4000-8000-000000000030',
      originShiftObservedAt: '2026-08-29T12:00:00.000Z',
      originBranchUuid: '00000000-0000-4000-8000-000000000031',
      originWarehouseUuid: '00000000-0000-4000-8000-000000000032'
    }
    const a = originContextFingerprint(input)
    const differentShift = originContextFingerprint({
      ...input,
      originShiftUuid: '00000000-0000-4000-8000-000000000099'
    })

    expect(a).not.toBe(differentShift)
  })
})

describe('canonicalJson', () => {
  it('sorts object keys but preserves array order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(
      canonicalJson([
        { b: 1, a: 2 },
        { d: 3, c: 4 }
      ])
    ).toBe('[{"a":2,"b":1},{"c":4,"d":3}]')
  })
})
