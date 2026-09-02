import { describe, expect, it } from 'vitest'
import { buildUploadPayload } from './localSale.payload'
import type {
  LocalInvoiceItemRow,
  LocalInvoicePaymentRow,
  LocalInvoiceRow,
  LocalStockAllocationConsumptionRow,
  StockAllocationGrantRow
} from '@shared/contracts/sale.contract'

function invoice(overrides: Partial<LocalInvoiceRow> = {}): LocalInvoiceRow {
  return {
    localUuid: 'invoice-uuid',
    attemptKey: 'attempt-uuid',
    offlineNumber: 'POS-333333-20260101-000001',
    remoteUuid: null,
    serverNumber: null,
    syncStatus: 'pending',
    syncAttempts: 0,
    lastSyncError: null,
    syncedAt: null,
    companyUuid: 'company-uuid',
    branchUuid: 'branch-uuid',
    warehouseUuid: 'warehouse-uuid',
    deviceUuid: 'device-uuid',
    userUuid: 'user-uuid',
    shiftUuid: 'shift-uuid',
    commitSessionEpoch: 1,
    catalogRevision: 'a'.repeat(64),
    intentFingerprint: 'b'.repeat(64),
    customerUuid: null,
    currency: 'EGP',
    currencyExponent: 2,
    taxMode: 'none',
    invoiceDiscountType: null,
    invoiceDiscountValue: 0,
    subtotalAmount: 1500,
    discountTotalAmount: 0,
    taxTotalAmount: 0,
    grandTotalAmount: 1500,
    paidTotalAmount: 1500,
    changeDueAmount: 0,
    dueAmount: 0,
    soldAt: '2026-01-01T02:00:00.000Z',
    connectivityStateAtSale: 'online',
    soldWhileOffline: false,
    notes: null,
    commercialSnapshotJson: '{}',
    uploadPayloadVersion: 2,
    createdAt: '2026-01-01T02:00:00.000Z',
    updatedAt: '2026-01-01T02:00:00.000Z',
    ...overrides
  }
}

function item(overrides: Partial<LocalInvoiceItemRow> = {}): LocalInvoiceItemRow {
  return {
    localUuid: 'item-1-uuid',
    invoiceLocalUuid: 'invoice-uuid',
    lineIndex: 0,
    productUuid: 'product-uuid',
    productName: 'Sparkling Water',
    sku: 'WATER-001',
    barcode: '1234567890123',
    unit: 'each',
    trackStock: false,
    quantityMilli: 1000,
    unitPriceAmount: 1000,
    currency: 'EGP',
    priceRevision: 'c'.repeat(64),
    taxUuid: null,
    taxMode: 'none',
    taxRateBasisPoints: 0,
    taxRevision: 'd'.repeat(64),
    discountType: null,
    discountValue: 0,
    subtotalAmount: 1000,
    discountAmount: 0,
    taxAmount: 0,
    totalAmount: 1000,
    createdAt: '2026-01-01T02:00:00.000Z',
    ...overrides
  }
}

function payment(overrides: Partial<LocalInvoicePaymentRow> = {}): LocalInvoicePaymentRow {
  return {
    localUuid: 'payment-1-uuid',
    invoiceLocalUuid: 'invoice-uuid',
    paymentIndex: 0,
    paymentMethodUuid: 'method-uuid',
    type: 'cash',
    amount: 1500,
    reference: null,
    requiresReference: false,
    paidAt: '2026-01-01T02:00:00.000Z',
    methodSnapshotJson: '{}',
    createdAt: '2026-01-01T02:00:00.000Z',
    ...overrides
  }
}

function grant(overrides: Partial<StockAllocationGrantRow> = {}): StockAllocationGrantRow {
  return {
    allocationUuid: 'allocation-uuid',
    contractVersion: 1,
    companyUuid: 'company-uuid',
    deviceUuid: 'device-uuid',
    warehouseUuid: 'warehouse-uuid',
    productUuid: 'tracked-product-uuid',
    serverSequence: 1,
    rightsGeneration: 4,
    lifecycleGeneration: 4,
    grantedQuantityMilli: 5000,
    serverConsumedQuantityMilli: 0,
    serverRemainingQuantityMilli: 5000,
    consumeUntil: '2027-01-01T00:00:00.000Z',
    status: 'active',
    envelopeHash: 'e'.repeat(64),
    sealNonce: null,
    finalConsumptionSequence: null,
    finalConsumptionHash: null,
    receivedAt: '2026-01-01T00:00:00.000Z',
    sealedAt: null,
    acknowledgedAt: null,
    releasedAt: null,
    lastObservedRevision: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

function consumption(
  overrides: Partial<LocalStockAllocationConsumptionRow> = {}
): LocalStockAllocationConsumptionRow {
  return {
    localUuid: 'consumption-uuid',
    allocationUuid: 'allocation-uuid',
    consumptionSequence: 1,
    invoiceLocalUuid: 'invoice-uuid',
    itemLocalUuid: 'item-2-uuid',
    quantityMilli: 2000,
    serverStatus: 'pending',
    serverConsumptionUuid: null,
    acknowledgedAt: null,
    createdAt: '2026-01-01T02:00:00.000Z',
    ...overrides
  }
}

describe('buildUploadPayload', () => {
  it('builds the exact v2 wire shape for an untracked-only sale', () => {
    const payload = buildUploadPayload(invoice(), [item()], [payment()], new Map(), new Map())

    expect(payload).toStrictEqual({
      idempotency_key: 'invoice-uuid',
      local_invoice_uuid: 'invoice-uuid',
      catalog_revision: 'a'.repeat(64),
      offline_number: 'POS-333333-20260101-000001',
      sold_at: '2026-01-01T02:00:00.000Z',
      sold_while_offline: false,
      customer_uuid: null,
      currency: 'EGP',
      tax_mode: 'none',
      client_contract_version: 2,
      shift_uuid: 'shift-uuid',
      items: [
        {
          product_uuid: 'product-uuid',
          barcode: '1234567890123',
          quantity: '1.000',
          unit_price_amount: 1000,
          currency: 'EGP',
          price_revision: 'c'.repeat(64),
          tax_id: null,
          tax_mode: 'none',
          tax_rate_basis_points: 0,
          tax_revision: 'd'.repeat(64),
          discount_type: null,
          discount_value: 0
        }
      ],
      invoice_discount: { type: null, value: 0 },
      payments: [
        {
          payment_method_uuid: 'method-uuid',
          type: 'cash',
          amount: 1500,
          reference: null,
          paid_at: '2026-01-01T02:00:00.000Z'
        }
      ],
      notes: null
    })
  })

  it('never includes an `allocations` key for an untracked line', () => {
    const payload = buildUploadPayload(invoice(), [item()], [payment()], new Map(), new Map())
    const [wireItem] = payload.items as Array<Record<string, unknown>>

    expect('allocations' in wireItem).toBe(false)
  })

  it('sorts items by lineIndex and payments by paymentIndex regardless of array order', () => {
    const first = item({ localUuid: 'item-a', lineIndex: 0, productUuid: 'product-a' })
    const second = item({ localUuid: 'item-b', lineIndex: 1, productUuid: 'product-b' })
    const firstPayment = payment({ localUuid: 'payment-a', paymentIndex: 0, amount: 500 })
    const secondPayment = payment({ localUuid: 'payment-b', paymentIndex: 1, amount: 1000 })

    const payload = buildUploadPayload(
      invoice(),
      [second, first],
      [secondPayment, firstPayment],
      new Map(),
      new Map()
    )

    const wireItems = payload.items as Array<{ product_uuid: string }>
    const wirePayments = payload.payments as Array<{ amount: number }>

    expect(wireItems.map((entry) => entry.product_uuid)).toStrictEqual(['product-a', 'product-b'])
    expect(wirePayments.map((entry) => entry.amount)).toStrictEqual([500, 1000])
  })

  it('includes exact allocation proofs for a tracked line, with rights_generation from the grant', () => {
    const trackedItem = item({
      localUuid: 'item-2-uuid',
      productUuid: 'tracked-product-uuid',
      trackStock: true,
      quantityMilli: 2000
    })
    const grantRow = grant()
    const consumptionRow = consumption()

    const payload = buildUploadPayload(
      invoice(),
      [trackedItem],
      [payment()],
      new Map([[trackedItem.localUuid, [consumptionRow]]]),
      new Map([[grantRow.allocationUuid, grantRow]])
    )

    const wireItems = payload.items as Array<Record<string, unknown>>

    expect(wireItems[0]).toMatchObject({
      product_uuid: 'tracked-product-uuid',
      allocations: [
        {
          allocation_uuid: 'allocation-uuid',
          rights_generation: 4,
          consumption_sequence: 1,
          local_consumption_uuid: 'consumption-uuid',
          quantity_milli: 2000
        }
      ]
    })
  })

  it('throws rather than silently omitting a consumption whose grant is unknown', () => {
    const trackedItem = item({ localUuid: 'item-2-uuid', trackStock: true })
    const consumptionRow = consumption({ allocationUuid: 'missing-allocation-uuid' })

    expect(() =>
      buildUploadPayload(
        invoice(),
        [trackedItem],
        [payment()],
        new Map([[trackedItem.localUuid, [consumptionRow]]]),
        new Map()
      )
    ).toThrow(/unknown grant/)
  })

  it('carries the invoice discount type and value through exactly', () => {
    const payload = buildUploadPayload(
      invoice({ invoiceDiscountType: 'percentage', invoiceDiscountValue: 500 }),
      [item()],
      [payment()],
      new Map(),
      new Map()
    )

    expect(payload.invoice_discount).toStrictEqual({ type: 'percentage', value: 500 })
  })
})
