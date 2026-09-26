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
import { ReceiptDocumentService } from './receiptDocument.service'
import type {
  NewInvoiceReceiptContext,
  NewRefundLineReceiptContext,
  NewRefundReceiptContext
} from '../repositories/receiptContext.repository'

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
    currency: 'USD',
    currencyExponent: 2,
    taxMode: 'exclusive',
    invoiceDiscountType: null,
    invoiceDiscountValue: 0,
    subtotalAmount: 2000,
    discountTotalAmount: 100,
    taxTotalAmount: 285,
    grandTotalAmount: 2185,
    paidTotalAmount: 2200,
    changeDueAmount: 15,
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
    quantityMilli: 1500,
    unitPriceAmount: 1000,
    currency: 'USD',
    priceRevision: 'pr-1',
    taxUuid: 'tax-1',
    taxMode: 'exclusive',
    taxRateBasisPoints: 1500,
    taxRevision: 'tr-1',
    discountType: null,
    discountValue: 0,
    subtotalAmount: 1500,
    discountAmount: 50,
    taxAmount: 217,
    totalAmount: 1667,
    allocationCoveredMilli: 1500,
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
    amount: 2200,
    reference: null,
    requiresReference: false,
    paidAt: '2026-01-01T10:00:00.000Z',
    methodSnapshotJson: '{"name":"Cash"}',
    createdAt: '2026-01-01T10:00:00.000Z',
    ...overrides
  }
}

function buildService(overrides: {
  invoice?: LocalInvoiceRow | null
  items?: LocalInvoiceItemRow[]
  payments?: LocalInvoicePaymentRow[]
  context?: NewInvoiceReceiptContext | null
  refund?: LocalRefundRow | null
  refundItems?: LocalRefundItemRow[]
  refundPayments?: LocalRefundPaymentRow[]
  refundContext?: NewRefundReceiptContext | null
  refundLineContexts?: NewRefundLineReceiptContext[]
}): ReceiptDocumentService {
  return new ReceiptDocumentService({
    localSale: {
      findInvoiceByLocalUuid: () => overrides.invoice ?? null,
      itemsForInvoice: () => overrides.items ?? [],
      paymentsForInvoice: () => overrides.payments ?? []
    },
    localRefunds: {
      findByLocalUuid: () => overrides.refund ?? null,
      itemsForRefund: () => overrides.refundItems ?? [],
      paymentsForRefund: () => overrides.refundPayments ?? []
    },
    receiptContext: {
      findInvoiceContext: () => overrides.context ?? null,
      findRefundContext: () => overrides.refundContext ?? null,
      findRefundLineContexts: () => overrides.refundLineContexts ?? []
    },
    bootstrapSnapshot: {
      getCompany: () => ({
        companyUuid: 'company-1',
        name: 'Fallback Co',
        isActive: true,
        updatedAt: '2026-01-01'
      }),
      getBranch: () => ({
        branchUuid: 'branch-1',
        name: 'Fallback Branch',
        isActive: true,
        updatedAt: '2026-01-01'
      })
    }
  })
}

function context(overrides: Partial<NewInvoiceReceiptContext> = {}): NewInvoiceReceiptContext {
  return {
    invoiceLocalUuid: 'inv-1',
    companyUuid: 'company-1',
    issuerCompanyName: 'Frozen Co',
    issuerBranchName: 'Frozen Branch',
    issuerWarehouseName: 'Frozen WH',
    cashierDisplayName: 'Jane',
    customerName: null,
    customerTaxNumber: null,
    timeZone: 'UTC',
    receiptProfileVersionUuid: null,
    createdAt: '2026-01-01T10:00:00.000Z',
    ...overrides
  }
}

describe('ReceiptDocumentService.buildSaleDocument', () => {
  it('throws receipt_not_found for a missing invoice', () => {
    const service = buildService({ invoice: null })
    expect(() => service.buildSaleDocument('missing', 'en', false)).toThrow()
  })

  it('builds a document with frozen issuer names when context exists', () => {
    const service = buildService({
      invoice: invoice({ syncStatus: 'synced' }),
      items: [item()],
      payments: [payment()],
      context: context()
    })
    const doc = service.buildSaleDocument('inv-1', 'en', false)

    expect(doc.header.companyName).toBe('Frozen Co')
    expect(doc.header.branchName).toBe('Frozen Branch')
    expect(doc.meta.cashierName).toBe('Jane')
    expect(doc.notices).toEqual([])
  })

  it('falls back to current bootstrap names and adds the historical notice when there is no context row', () => {
    const service = buildService({
      invoice: invoice({ syncStatus: 'synced' }),
      items: [item()],
      payments: [payment()],
      context: null
    })
    const doc = service.buildSaleDocument('inv-1', 'en', false)

    expect(doc.header.companyName).toBe('Fallback Co')
    expect(doc.meta.cashierName).toBeNull()
    expect(doc.notices.length).toBeGreaterThan(0)
  })

  it('adds the unsynced notice when the sale has not synced yet', () => {
    const service = buildService({
      invoice: invoice({ syncStatus: 'pending' }),
      items: [item()],
      payments: [payment()],
      context: context()
    })
    const doc = service.buildSaleDocument('inv-1', 'en', false)

    expect(doc.notices.length).toBe(1)
    expect(doc.meta.serverNumber).toBeNull()
  })

  it('shows the server number once synced', () => {
    const service = buildService({
      invoice: invoice({ syncStatus: 'synced', serverNumber: 'INV-0001' }),
      items: [item()],
      payments: [payment()],
      context: context()
    })
    const doc = service.buildSaleDocument('inv-1', 'en', false)

    expect(doc.meta.serverNumber).toBe('INV-0001')
  })

  it('groups tax by rate and formats fractional quantities', () => {
    const service = buildService({
      invoice: invoice({ syncStatus: 'synced' }),
      items: [
        item({
          localUuid: 'a',
          lineIndex: 0,
          taxRateBasisPoints: 1500,
          taxAmount: 100,
          quantityMilli: 1500
        }),
        item({
          localUuid: 'b',
          lineIndex: 1,
          taxRateBasisPoints: 500,
          taxAmount: 20,
          quantityMilli: 2000
        })
      ],
      payments: [payment()],
      context: context()
    })
    const doc = service.buildSaleDocument('inv-1', 'en', false)

    expect(doc.totals.taxLines).toHaveLength(2)
    expect(doc.totals.taxLines[0]!.rateLabel).toBe('5%')
    expect(doc.totals.taxLines[1]!.rateLabel).toBe('15%')
    expect(doc.items[0]!.quantityText).toBe('1.500')
  })

  it('shows paid/change only when change is due or there are multiple payments', () => {
    const single = buildService({
      invoice: invoice({ syncStatus: 'synced', changeDueAmount: 0, paidTotalAmount: 2185 }),
      items: [item()],
      payments: [payment({ amount: 2185 })],
      context: context()
    })
    const singleDoc = single.buildSaleDocument('inv-1', 'en', false)
    expect(singleDoc.totals.paidText).toBeNull()
    expect(singleDoc.totals.changeText).toBeNull()

    const withChange = buildService({
      invoice: invoice({ syncStatus: 'synced' }),
      items: [item()],
      payments: [payment()],
      context: context()
    })
    const changeDoc = withChange.buildSaleDocument('inv-1', 'en', false)
    expect(changeDoc.totals.changeText).not.toBeNull()
    expect(changeDoc.totals.paidText).not.toBeNull()
  })

  it('marks the document as a reprint when asked', () => {
    const service = buildService({
      invoice: invoice({ syncStatus: 'synced' }),
      items: [item()],
      payments: [payment()],
      context: context()
    })
    const doc = service.buildSaleDocument('inv-1', 'en', true)
    expect(doc.isReprint).toBe(true)
  })

  it('reads Arabic-locale numbers using Latin digits', () => {
    const service = buildService({
      invoice: invoice({ syncStatus: 'synced' }),
      items: [item()],
      payments: [payment()],
      context: context()
    })
    const doc = service.buildSaleDocument('inv-1', 'ar', false)
    expect(doc.totals.grandTotalText).toMatch(/[0-9]/)
  })
})

describe('ReceiptDocumentService.buildRefundDocument', () => {
  function refund(overrides: Partial<LocalRefundRow> = {}): LocalRefundRow {
    return {
      localUuid: 'refund-1',
      invoiceLocalUuid: 'inv-1',
      invoiceRemoteUuid: 'remote-inv-1',
      companyUuid: 'company-1',
      deviceUuid: 'device-1',
      userUuid: 'user-1',
      shiftUuid: 'shift-1',
      currency: 'USD',
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
      remoteUuid: 'remote-refund-1',
      refundNumber: 'REF-0001',
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

  it('prints original unit price/sku when the line context exists', () => {
    const service = buildService({
      refund: refund(),
      refundItems: [refundItem()],
      refundPayments: [refundPayment()],
      refundContext: {
        refundLocalUuid: 'refund-1',
        companyUuid: 'company-1',
        issuerCompanyName: 'Frozen Co',
        issuerBranchName: 'Frozen Branch',
        cashierDisplayName: 'Jane',
        paymentMethodName: null,
        originalOfflineNumber: 'POS-1',
        originalServerNumber: 'INV-0001',
        timeZone: 'UTC',
        receiptProfileVersionUuid: null,
        createdAt: '2026-01-02T10:00:00.000Z'
      },
      refundLineContexts: [
        {
          refundItemLocalUuid: 'ritem-1',
          refundLocalUuid: 'refund-1',
          invoiceItemRemoteUuid: 'remote-item-1',
          originalUnitPriceAmount: 1000,
          originalQuantityMilli: 1000,
          unit: 'pc',
          sku: 'SKU-1',
          taxRateText: '15.0000',
          createdAt: '2026-01-02T10:00:00.000Z'
        }
      ]
    })

    const doc = service.buildRefundDocument('refund-1', 'en', false)

    expect(doc.items[0]!.sku).toBe('SKU-1')
    expect(doc.items[0]!.unitPriceText).not.toBe('')
    expect(doc.notices).not.toContain(expect.stringContaining('not recorded'))
    expect(doc.refund?.originalServerNumber).toBe('INV-0001')
    expect(doc.refund?.stockReturned).toBe(true)
  })

  it('omits descriptors and shows the notice for a historical refund without line context', () => {
    const service = buildService({
      refund: refund(),
      refundItems: [refundItem()],
      refundPayments: [refundPayment()],
      refundContext: null,
      refundLineContexts: []
    })

    const doc = service.buildRefundDocument('refund-1', 'en', false)

    expect(doc.items[0]!.sku).toBeNull()
    expect(doc.items[0]!.unitPriceText).toBe('')
    expect(doc.notices.some((n) => n.toLowerCase().includes('not recorded'))).toBe(true)
  })

  it('payment label falls back to the type when no name is recorded, never defaulting to Cash for a card refund', () => {
    const service = buildService({
      refund: refund(),
      refundItems: [refundItem()],
      refundPayments: [refundPayment({ type: 'card', paymentMethodUuid: null })],
      refundContext: null
    })

    const doc = service.buildRefundDocument('refund-1', 'en', false)
    expect(doc.totals.payments[0]!.label).toBe('Card')
  })
})
