import { describe, expect, it, vi, type Mock } from 'vitest'
import type {
  BootstrapBranch,
  BootstrapCompany,
  BootstrapWarehouse
} from '../repositories/bootstrapSnapshot.repository'
import { ReceiptContextCaptureService } from './receiptContextCapture.service'
import type {
  NewInvoiceReceiptContext,
  NewRefundReceiptContext,
  NewRefundLineReceiptContext
} from '../repositories/receiptContext.repository'

interface FakeDependencies {
  receiptContext: {
    insertInvoiceContext: Mock
    insertRefundContext: Mock
    insertRefundLineContext: Mock
    getCurrentProfileVersionUuid: Mock
  }
  bootstrapSnapshot: {
    getCompany: Mock
    getBranch: Mock
    getWarehouse: Mock
  }
  sessionMetadata: { getSummary: Mock }
  customers: { findNameAndTaxNumber: Mock }
  now: () => Date
}

function buildDependencies(): {
  deps: FakeDependencies
  invoiceInserts: NewInvoiceReceiptContext[]
  refundInserts: NewRefundReceiptContext[]
  refundLineInserts: NewRefundLineReceiptContext[][]
} {
  const invoiceInserts: NewInvoiceReceiptContext[] = []
  const refundInserts: NewRefundReceiptContext[] = []
  const refundLineInserts: NewRefundLineReceiptContext[][] = []

  const deps: FakeDependencies = {
    receiptContext: {
      insertInvoiceContext: vi.fn((row: NewInvoiceReceiptContext) => invoiceInserts.push(row)),
      insertRefundContext: vi.fn((row: NewRefundReceiptContext) => refundInserts.push(row)),
      insertRefundLineContext: vi.fn((rows: readonly NewRefundLineReceiptContext[]) =>
        refundLineInserts.push([...rows])
      ),
      getCurrentProfileVersionUuid: vi.fn(() => 'version-1' as string | null)
    },
    bootstrapSnapshot: {
      getCompany: vi.fn((): BootstrapCompany | null => ({
        companyUuid: 'company-1',
        name: 'Acme Store',
        isActive: true,
        updatedAt: '2026-01-01'
      })),
      getBranch: vi.fn((): BootstrapBranch | null => ({
        branchUuid: 'branch-1',
        name: 'Main Branch',
        isActive: true,
        updatedAt: '2026-01-01'
      })),
      getWarehouse: vi.fn((): BootstrapWarehouse | null => ({
        warehouseUuid: 'wh-1',
        name: 'Main Warehouse',
        isActive: true,
        updatedAt: '2026-01-01'
      }))
    },
    sessionMetadata: { getSummary: vi.fn(() => ({ userName: 'Jane Cashier' as string | null })) },
    customers: {
      findNameAndTaxNumber: vi.fn((uuid: string) =>
        uuid === 'customer-1'
          ? { name: 'Acme Customer', taxNumber: 'TAX-1' as string | null }
          : null
      )
    },
    now: () => new Date('2026-01-01T10:00:00.000Z')
  }

  return { deps, invoiceInserts, refundInserts, refundLineInserts }
}

describe('ReceiptContextCaptureService.captureForSale', () => {
  it('writes the issuer names, cashier, customer and current profile version', () => {
    const { deps, invoiceInserts } = buildDependencies()
    const service = new ReceiptContextCaptureService(deps)

    service.captureForSale({
      invoiceLocalUuid: 'inv-1',
      companyUuid: 'company-1',
      customerUuid: 'customer-1'
    })

    expect(invoiceInserts).toHaveLength(1)
    expect(invoiceInserts[0]).toMatchObject({
      invoiceLocalUuid: 'inv-1',
      companyUuid: 'company-1',
      issuerCompanyName: 'Acme Store',
      issuerBranchName: 'Main Branch',
      issuerWarehouseName: 'Main Warehouse',
      cashierDisplayName: 'Jane Cashier',
      customerName: 'Acme Customer',
      customerTaxNumber: 'TAX-1',
      receiptProfileVersionUuid: 'version-1'
    })
    expect(invoiceInserts[0]!.timeZone.length).toBeGreaterThan(0)
  })

  it('omits customer name/tax number when no customer is recorded', () => {
    const { deps, invoiceInserts } = buildDependencies()
    const service = new ReceiptContextCaptureService(deps)

    service.captureForSale({
      invoiceLocalUuid: 'inv-1',
      companyUuid: 'company-1',
      customerUuid: null
    })

    expect(invoiceInserts[0]!.customerName).toBeNull()
    expect(invoiceInserts[0]!.customerTaxNumber).toBeNull()
    expect(deps.customers.findNameAndTaxNumber).not.toHaveBeenCalled()
  })

  it('writes no context row at all when bootstrap has no company (nothing honest to snapshot)', () => {
    const { deps, invoiceInserts } = buildDependencies()
    deps.bootstrapSnapshot.getCompany = vi.fn(() => null)
    const service = new ReceiptContextCaptureService(deps)

    service.captureForSale({
      invoiceLocalUuid: 'inv-1',
      companyUuid: 'company-1',
      customerUuid: null
    })

    expect(invoiceInserts).toHaveLength(0)
    expect(deps.receiptContext.insertInvoiceContext).not.toHaveBeenCalled()
  })

  it('tolerates a missing branch/warehouse (null, not a fabricated name)', () => {
    const { deps, invoiceInserts } = buildDependencies()
    deps.bootstrapSnapshot.getBranch = vi.fn(() => null)
    deps.bootstrapSnapshot.getWarehouse = vi.fn(() => null)
    const service = new ReceiptContextCaptureService(deps)

    service.captureForSale({
      invoiceLocalUuid: 'inv-1',
      companyUuid: 'company-1',
      customerUuid: null
    })

    expect(invoiceInserts[0]!.issuerBranchName).toBeNull()
    expect(invoiceInserts[0]!.issuerWarehouseName).toBeNull()
  })
})

describe('ReceiptContextCaptureService.captureForRefund', () => {
  it('writes the refund header context and one line-context row per line', () => {
    const { deps, refundInserts, refundLineInserts } = buildDependencies()
    const service = new ReceiptContextCaptureService(deps)

    service.captureForRefund({
      refundLocalUuid: 'refund-1',
      companyUuid: 'company-1',
      paymentMethodName: 'Cash',
      originalOfflineNumber: 'POS-000001-20260101-000001',
      originalServerNumber: 'INV-0001',
      lines: [
        {
          refundItemLocalUuid: 'ritem-1',
          invoiceItemRemoteUuid: 'remote-item-1',
          unitPriceAmount: 1000,
          quantityMilli: 2000,
          unit: 'pc',
          sku: 'SKU-1',
          taxRateText: '15.0000'
        }
      ]
    })

    expect(refundInserts).toHaveLength(1)
    expect(refundInserts[0]).toMatchObject({
      refundLocalUuid: 'refund-1',
      issuerCompanyName: 'Acme Store',
      issuerBranchName: 'Main Branch',
      cashierDisplayName: 'Jane Cashier',
      paymentMethodName: 'Cash',
      originalOfflineNumber: 'POS-000001-20260101-000001',
      originalServerNumber: 'INV-0001',
      receiptProfileVersionUuid: 'version-1'
    })
    expect(refundLineInserts).toHaveLength(1)
    expect(refundLineInserts[0]).toEqual([
      expect.objectContaining({
        refundItemLocalUuid: 'ritem-1',
        refundLocalUuid: 'refund-1',
        invoiceItemRemoteUuid: 'remote-item-1',
        originalUnitPriceAmount: 1000,
        originalQuantityMilli: 2000,
        unit: 'pc',
        sku: 'SKU-1',
        taxRateText: '15.0000'
      })
    ])
  })

  it('writes no context at all when bootstrap has no company', () => {
    const { deps, refundInserts, refundLineInserts } = buildDependencies()
    deps.bootstrapSnapshot.getCompany = vi.fn(() => null)
    const service = new ReceiptContextCaptureService(deps)

    service.captureForRefund({
      refundLocalUuid: 'refund-1',
      companyUuid: 'company-1',
      paymentMethodName: null,
      originalOfflineNumber: 'POS-1',
      originalServerNumber: null,
      lines: []
    })

    expect(refundInserts).toHaveLength(0)
    expect(refundLineInserts).toHaveLength(0)
  })
})
