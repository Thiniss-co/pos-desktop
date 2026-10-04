import { describe, expect, it } from 'vitest'
import { decodeZatcaPhase1Qr } from '@shared/receipt/fiscalQr'
import { FiscalContextService, missingZatcaFields } from './fiscalContext.service'
import type {
  FiscalContextRepository,
  FiscalIdentityBlock,
  InvoiceFiscalContextRow,
  RefundFiscalContextRow
} from '../repositories/fiscalContext.repository'

const COMPANY = '11111111-1111-4111-8111-111111111111'
const INVOICE = '22222222-2222-4222-8222-222222222222'
const REFUND = '33333333-3333-4333-8333-333333333333'

const IDENTITY: FiscalIdentityBlock = {
  regime: 'sa_zatca_phase1',
  seller_name: 'Harbour Coffee Trading LLC',
  vat_number: '310122393500003',
  seller_address: {
    street: '1 Corniche Road',
    city: 'Jeddah',
    postal_code: null,
    country: 'Saudi Arabia'
  },
  revision: 2
}

function memoryRepository(identity: FiscalIdentityBlock | null): {
  repository: FiscalContextRepository
  invoices: Map<string, InvoiceFiscalContextRow>
  refunds: Map<string, RefundFiscalContextRow>
} {
  const invoices = new Map<string, InvoiceFiscalContextRow>()
  const refunds = new Map<string, RefundFiscalContextRow>()
  const repository = {
    available: () => true,
    identity: () => identity,
    insertInvoiceContext: (row: InvoiceFiscalContextRow) =>
      void invoices.set(row.invoiceLocalUuid, row),
    invoiceContext: (uuid: string) => invoices.get(uuid) ?? null,
    insertRefundContext: (row: RefundFiscalContextRow) =>
      void refunds.set(row.refundLocalUuid, row),
    refundContext: (uuid: string) => refunds.get(uuid) ?? null
  }
  return { repository: repository as unknown as FiscalContextRepository, invoices, refunds }
}

const SALE = {
  invoiceLocalUuid: INVOICE,
  companyUuid: COMPANY,
  soldAt: '2026-10-04T17:05:09.512Z',
  grandTotalAmount: 4075,
  taxTotalAmount: 375,
  currency: 'SAR',
  currencyExponent: 2
}

describe('POS improvements Stage 6: FiscalContextService', () => {
  it('names every missing ZATCA field', () => {
    expect(missingZatcaFields(IDENTITY)).toEqual([])
    expect(
      missingZatcaFields({
        seller_name: ' ',
        vat_number: '31012239350000',
        seller_address: { street: null, city: 'Jeddah', postal_code: null, country: '' }
      })
    ).toEqual(['seller_name', 'vat_number', 'street', 'country'])
  })

  it('is ready without a mirror (non-fiscal) and refuses an incomplete ZATCA identity', () => {
    expect(new FiscalContextService(memoryRepository(null).repository).readiness(COMPANY).ok).toBe(
      true
    )
    const incomplete = new FiscalContextService(
      memoryRepository({ ...IDENTITY, vat_number: null }).repository
    )
    expect(incomplete.readiness(COMPANY)).toEqual({ ok: false, missing: ['vat_number'] })
    expect(() => incomplete.captureForSale(SALE)).toThrow(/fiscal-setup-incomplete/)
  })

  it('freezes a ZATCA sale QR over the UTC second and the totals, and recomputes it from frozen facts', () => {
    const memory = memoryRepository(IDENTITY)
    const service = new FiscalContextService(memory.repository)

    const qr = service.captureForSale(SALE)

    expect(qr?.type).toBe('zatca-p1')
    expect(decodeZatcaPhase1Qr(qr?.payload ?? '')).toEqual({
      sellerName: 'Harbour Coffee Trading LLC',
      vatNumber: '310122393500003',
      timestamp: '2026-10-04T17:05:09Z',
      total: '40.75',
      vatTotal: '3.75'
    })
    expect(service.expectedSaleQr(SALE)).toEqual(qr)
  })

  it('detects a frozen payload that no longer matches its own facts (tampering or corruption)', () => {
    const memory = memoryRepository(IDENTITY)
    const service = new FiscalContextService(memory.repository)
    service.captureForSale(SALE)
    const row = memory.invoices.get(INVOICE)!
    memory.invoices.set(INVOICE, { ...row, qrPayload: row.qrPayload.replace('A', 'B') })

    expect(service.expectedSaleQr(SALE)).toBeNull()
    expect(service.expectedSaleQr({ ...SALE, grandTotalAmount: 9999 })).toBeNull()
  })

  it('builds a credit note QR from the server-frozen block (its acceptance time, positive totals)', () => {
    const memory = memoryRepository(null)
    const service = new FiscalContextService(memory.repository)
    const facts = {
      refundLocalUuid: REFUND,
      companyUuid: COMPANY,
      refundedAt: '2026-10-04T18:00:00Z',
      grandTotalAmount: 1400,
      taxTotalAmount: 150,
      currency: 'SAR',
      currencyExponent: 2
    }
    const fiscal = {
      ...IDENTITY,
      issued_at: '2026-10-04T18:00:03Z',
      refund_number: 'REF-0001',
      original_invoice: { number: 'POS-0001', issued_at: '2026-10-04T17:05:09Z' }
    }

    const qr = service.captureForRefund(facts, fiscal)

    expect(decodeZatcaPhase1Qr(qr?.payload ?? '')).toMatchObject({
      timestamp: '2026-10-04T18:00:03Z',
      total: '14.00',
      vatTotal: '1.50'
    })
    expect(service.captureForRefund(facts, fiscal)).toBeNull()
    expect(service.expectedRefundQr(facts)).toEqual(qr)
  })

  it('gives a historical sale (no context) a transaction reference, never a VAT identity', () => {
    const service = new FiscalContextService(memoryRepository(IDENTITY).repository)
    expect(service.expectedSaleQr(SALE)?.type).toBe('txn-ref-v1')
  })
})
