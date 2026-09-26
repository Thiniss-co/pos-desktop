import { describe, expect, it } from 'vitest'
import type {
  LocalInvoiceItemRow,
  LocalInvoicePaymentRow,
  LocalInvoiceRow
} from '@shared/contracts/sale.contract'
import type {
  LocalRefundItemRow,
  LocalRefundPaymentRow,
  LocalRefundRow
} from '@shared/contracts/refund.contract'
import { buildRefundFacts, buildSaleFacts } from './transactionFacts'

function invoice(overrides: Partial<LocalInvoiceRow> = {}): LocalInvoiceRow {
  return {
    localUuid: 'inv-1',
    attemptKey: 'attempt-1',
    offlineNumber: 'POS-abc123-20260101-000001',
    remoteUuid: null,
    serverNumber: null,
    syncStatus: 'pending',
    syncAttempts: 0,
    lastSyncError: null,
    syncedAt: null,
    companyUuid: 'company-1',
    branchUuid: 'branch-1',
    warehouseUuid: 'warehouse-1',
    deviceUuid: 'device-1',
    userUuid: 'user-1',
    shiftUuid: 'shift-1',
    commitSessionEpoch: 1,
    catalogRevision: 'rev-1',
    intentFingerprint: 'fp-1',
    customerUuid: null,
    currency: 'EGP',
    currencyExponent: 2,
    taxMode: 'exclusive',
    invoiceDiscountType: null,
    invoiceDiscountValue: 0,
    subtotalAmount: 1000,
    discountTotalAmount: 0,
    taxTotalAmount: 150,
    grandTotalAmount: 1150,
    paidTotalAmount: 1150,
    changeDueAmount: 0,
    dueAmount: 0,
    soldAt: '2026-01-01T10:00:00.000Z',
    connectivityStateAtSale: 'online',
    soldWhileOffline: false,
    notes: null,
    commercialSnapshotJson: '{}',
    uploadPayloadVersion: 3,
    offlineSaleAuthorityUuid: null,
    stockAuthorizationPolicy: null,
    createdAt: '2026-01-01T10:00:00.000Z',
    updatedAt: '2026-01-01T10:00:00.000Z',
    ...overrides
  }
}

function item(overrides: Partial<LocalInvoiceItemRow> = {}): LocalInvoiceItemRow {
  return {
    localUuid: 'item-1',
    invoiceLocalUuid: 'inv-1',
    lineIndex: 0,
    productUuid: 'product-1',
    productName: 'Widget',
    sku: 'SKU-1',
    barcode: '12345',
    unit: 'pc',
    trackStock: true,
    quantityMilli: 1000,
    unitPriceAmount: 1000,
    currency: 'EGP',
    priceRevision: 'pr-1',
    taxUuid: 'tax-1',
    taxMode: 'exclusive',
    taxRateBasisPoints: 1500,
    taxRevision: 'tr-1',
    discountType: null,
    discountValue: 0,
    subtotalAmount: 1000,
    discountAmount: 0,
    taxAmount: 150,
    totalAmount: 1150,
    allocationCoveredMilli: 1000,
    uncoveredMilli: 0,
    createdAt: '2026-01-01T10:00:00.000Z',
    ...overrides
  }
}

function payment(overrides: Partial<LocalInvoicePaymentRow> = {}): LocalInvoicePaymentRow {
  return {
    localUuid: 'pay-1',
    invoiceLocalUuid: 'inv-1',
    paymentIndex: 0,
    paymentMethodUuid: 'method-1',
    type: 'cash',
    amount: 1150,
    reference: null,
    requiresReference: false,
    paidAt: '2026-01-01T10:00:00.000Z',
    methodSnapshotJson: '{"name":"Cash"}',
    createdAt: '2026-01-01T10:00:00.000Z',
    ...overrides
  }
}

describe('buildSaleFacts', () => {
  it('is deterministic for the same rows', () => {
    const a = buildSaleFacts({ invoice: invoice(), items: [item()], payments: [payment()] })
    const b = buildSaleFacts({ invoice: invoice(), items: [item()], payments: [payment()] })
    expect(a.sha256).toBe(b.sha256)
  })

  it('is unaffected by adding server_number, remote_uuid or synced_at (post-ack metadata excluded)', () => {
    const before = buildSaleFacts({ invoice: invoice(), items: [item()], payments: [payment()] })
    const after = buildSaleFacts({
      invoice: invoice({
        serverNumber: 'SRV-1',
        remoteUuid: 'remote-1',
        syncStatus: 'synced',
        syncedAt: '2026-01-02T00:00:00.000Z'
      }),
      items: [item()],
      payments: [payment()]
    })
    expect(after.sha256).toBe(before.sha256)
  })

  it('is unaffected by notes, commercial_snapshot_json, catalog_revision or timestamps', () => {
    const before = buildSaleFacts({ invoice: invoice(), items: [item()], payments: [payment()] })
    const after = buildSaleFacts({
      invoice: invoice({
        notes: 'something',
        commercialSnapshotJson: '{"evaluatedAt":"later"}',
        catalogRevision: 'rev-999',
        updatedAt: '2030-01-01T00:00:00.000Z'
      }),
      items: [item()],
      payments: [payment()]
    })
    expect(after.sha256).toBe(before.sha256)
  })

  it('changes when a protected amount changes', () => {
    const before = buildSaleFacts({ invoice: invoice(), items: [item()], payments: [payment()] })
    const after = buildSaleFacts({
      invoice: invoice({ grandTotalAmount: 9999 }),
      items: [item()],
      payments: [payment()]
    })
    expect(after.sha256).not.toBe(before.sha256)
  })

  it('changes when a line quantity or price changes', () => {
    const before = buildSaleFacts({ invoice: invoice(), items: [item()], payments: [payment()] })
    const after = buildSaleFacts({
      invoice: invoice(),
      items: [item({ quantityMilli: 2000 })],
      payments: [payment()]
    })
    expect(after.sha256).not.toBe(before.sha256)
  })

  it('changes when line identity/order changes', () => {
    const itemA = item({ localUuid: 'item-a', lineIndex: 0, productName: 'A' })
    const itemB = item({ localUuid: 'item-b', lineIndex: 1, productName: 'B' })
    const forward = buildSaleFacts({
      invoice: invoice(),
      items: [itemA, itemB],
      payments: [payment()]
    })
    const swapped = buildSaleFacts({
      invoice: invoice(),
      items: [
        { ...itemB, lineIndex: 0 },
        { ...itemA, lineIndex: 1 }
      ],
      payments: [payment()]
    })
    expect(swapped.sha256).not.toBe(forward.sha256)
  })

  it('sorts items/payments by index regardless of input array order', () => {
    const itemA = item({ localUuid: 'item-a', lineIndex: 0 })
    const itemB = item({ localUuid: 'item-b', lineIndex: 1 })
    const inOrder = buildSaleFacts({
      invoice: invoice(),
      items: [itemA, itemB],
      payments: [payment()]
    })
    const outOfOrder = buildSaleFacts({
      invoice: invoice(),
      items: [itemB, itemA],
      payments: [payment()]
    })
    expect(outOfOrder.sha256).toBe(inOrder.sha256)
  })

  it('changes when a payment fact changes', () => {
    const before = buildSaleFacts({ invoice: invoice(), items: [item()], payments: [payment()] })
    const after = buildSaleFacts({
      invoice: invoice(),
      items: [item()],
      payments: [payment({ amount: 1 })]
    })
    expect(after.sha256).not.toBe(before.sha256)
  })

  it('changes when the owner (company/device) changes', () => {
    const before = buildSaleFacts({ invoice: invoice(), items: [item()], payments: [payment()] })
    const after = buildSaleFacts({
      invoice: invoice({ companyUuid: 'company-2' }),
      items: [item()],
      payments: [payment()]
    })
    expect(after.sha256).not.toBe(before.sha256)
  })

  it('distinguishes null from an absent/empty value', () => {
    const withNullCustomer = buildSaleFacts({
      invoice: invoice({ customerUuid: null }),
      items: [item()],
      payments: [payment()]
    })
    const withCustomer = buildSaleFacts({
      invoice: invoice({ customerUuid: 'customer-1' }),
      items: [item()],
      payments: [payment()]
    })
    expect(withNullCustomer.sha256).not.toBe(withCustomer.sha256)
  })

  it('throws for an unsafe integer amount, rather than silently truncating', () => {
    expect(() =>
      buildSaleFacts({
        invoice: invoice({ grandTotalAmount: Number.MAX_SAFE_INTEGER + 10 }),
        items: [item()],
        payments: [payment()]
      })
    ).toThrow()
  })
})

function refund(overrides: Partial<LocalRefundRow> = {}): LocalRefundRow {
  return {
    localUuid: 'refund-1',
    invoiceLocalUuid: 'inv-1',
    invoiceRemoteUuid: 'remote-inv-1',
    companyUuid: 'company-1',
    deviceUuid: 'device-1',
    userUuid: 'user-1',
    shiftUuid: 'shift-1',
    currency: 'EGP',
    currencyExponent: 2,
    subtotalAmount: 1000,
    discountTotalAmount: 0,
    taxTotalAmount: 150,
    grandTotalAmount: 1150,
    refundedAt: '2026-01-02T10:00:00.000Z',
    stockReturned: true,
    reason: 'Damaged',
    notes: null,
    requestJson: '{}',
    requestSha256: 'x'.repeat(64),
    previewId: 'preview-1',
    dispatchCount: 1,
    submissionState: 'accepted',
    remoteUuid: null,
    refundNumber: null,
    cancelledAt: null,
    cancelledReason: null,
    lastErrorCode: null,
    lastErrorDetails: null,
    createdAt: '2026-01-02T10:00:00.000Z',
    updatedAt: '2026-01-02T10:00:00.000Z',
    ...overrides
  }
}

function refundItem(overrides: Partial<LocalRefundItemRow> = {}): LocalRefundItemRow {
  return {
    localUuid: 'ritem-1',
    refundLocalUuid: 'refund-1',
    lineIndex: 0,
    invoiceItemRemoteUuid: 'remote-item-1',
    productUuid: 'product-1',
    productName: 'Widget',
    quantityMilli: 1000,
    priorRefundedQuantityMilli: 0,
    subtotalAmount: 1000,
    discountAmount: 0,
    taxAmount: 150,
    totalAmount: 1150,
    taxMode: 'exclusive',
    createdAt: '2026-01-02T10:00:00.000Z',
    ...overrides
  }
}

function refundPayment(overrides: Partial<LocalRefundPaymentRow> = {}): LocalRefundPaymentRow {
  return {
    localUuid: 'rpay-1',
    refundLocalUuid: 'refund-1',
    paymentIndex: 0,
    paymentMethodUuid: null,
    type: 'cash',
    amount: 1150,
    reference: null,
    createdAt: '2026-01-02T10:00:00.000Z',
    ...overrides
  }
}

describe('buildRefundFacts', () => {
  it('is unaffected by submission_state, remote_uuid or refund_number (post-ack metadata excluded)', () => {
    const before = buildRefundFacts({
      refund: refund(),
      items: [refundItem()],
      payments: [refundPayment()]
    })
    const after = buildRefundFacts({
      refund: refund({ submissionState: 'dispatched', remoteUuid: null, refundNumber: null }),
      items: [refundItem()],
      payments: [refundPayment()]
    })
    expect(after.sha256).toBe(before.sha256)
  })

  it('is unaffected by dispatch_count, request_json/request_sha256, or notes', () => {
    const before = buildRefundFacts({
      refund: refund(),
      items: [refundItem()],
      payments: [refundPayment()]
    })
    const after = buildRefundFacts({
      refund: refund({ dispatchCount: 5, requestJson: '{"different":true}', notes: 'x' }),
      items: [refundItem()],
      payments: [refundPayment()]
    })
    expect(after.sha256).toBe(before.sha256)
  })

  it('changes when a protected refund amount or line identity changes', () => {
    const before = buildRefundFacts({
      refund: refund(),
      items: [refundItem()],
      payments: [refundPayment()]
    })
    const afterAmount = buildRefundFacts({
      refund: refund({ grandTotalAmount: 1 }),
      items: [refundItem()],
      payments: [refundPayment()]
    })
    const afterIdentity = buildRefundFacts({
      refund: refund(),
      items: [refundItem({ invoiceItemRemoteUuid: 'different-remote-item' })],
      payments: [refundPayment()]
    })
    expect(afterAmount.sha256).not.toBe(before.sha256)
    expect(afterIdentity.sha256).not.toBe(before.sha256)
  })

  it('changes when stock_returned changes', () => {
    const before = buildRefundFacts({
      refund: refund({ stockReturned: true }),
      items: [refundItem()],
      payments: [refundPayment()]
    })
    const after = buildRefundFacts({
      refund: refund({ stockReturned: false }),
      items: [refundItem()],
      payments: [refundPayment()]
    })
    expect(after.sha256).not.toBe(before.sha256)
  })

  it('changes when the owner changes', () => {
    const before = buildRefundFacts({
      refund: refund(),
      items: [refundItem()],
      payments: [refundPayment()]
    })
    const after = buildRefundFacts({
      refund: refund({ companyUuid: 'company-2' }),
      items: [refundItem()],
      payments: [refundPayment()]
    })
    expect(after.sha256).not.toBe(before.sha256)
  })

  it('two refunds against the same product at two different original invoice items produce distinct facts', () => {
    const first = buildRefundFacts({
      refund: refund(),
      items: [refundItem({ invoiceItemRemoteUuid: 'server-item-A' })],
      payments: [refundPayment()]
    })
    const second = buildRefundFacts({
      refund: refund({ localUuid: 'refund-2' }),
      items: [refundItem({ localUuid: 'ritem-2', invoiceItemRemoteUuid: 'server-item-B' })],
      payments: [refundPayment({ localUuid: 'rpay-2', refundLocalUuid: 'refund-2' })]
    })
    expect(first.sha256).not.toBe(second.sha256)
  })
})
