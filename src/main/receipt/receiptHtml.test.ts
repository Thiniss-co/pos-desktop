import { describe, expect, it } from 'vitest'
import type { ReceiptDocument } from '@shared/receipt/receiptDocument'
import { buildReceiptHtml } from './receiptHtml'

const LAYOUT = { printableWidthMm: 72 }

function baseDoc(overrides: Partial<ReceiptDocument> = {}): ReceiptDocument {
  return {
    kind: 'sale',
    templateVersion: 1,
    locale: 'en',
    isReprint: false,
    header: {
      companyName: 'Acme Co',
      branchName: 'Main',
      addressLines: [],
      phone: null,
      taxIdentifierLabel: null,
      taxIdentifierValue: null,
      logo: null
    },
    meta: {
      receiptNumberLabel: 'Receipt no.',
      receiptNumber: 'POS-1',
      serverNumberLabel: null,
      serverNumber: null,
      dateTimeText: '2026-01-01 10:00 (UTC+00:00)',
      cashierLabel: 'Cashier',
      cashierName: 'Jane',
      customerName: null,
      customerTaxNumber: null,
      currency: 'USD'
    },
    items: [
      {
        productName: 'Widget',
        sku: 'SKU-1',
        quantityText: '1',
        unit: 'pc',
        unitPriceText: '$10.00',
        lineTotalText: '$10.00',
        ownDiscountText: null,
        invoiceDiscountShareText: null,
        taxRateLabel: null
      }
    ],
    totals: {
      subtotalText: '$10.00',
      itemDiscountText: null,
      invoiceDiscountText: null,
      taxLines: [],
      grandTotalText: '$10.00',
      payments: [{ label: 'Cash', amountText: '$10.00', maskedReference: null }],
      paidText: null,
      changeText: null
    },
    refund: null,
    notices: [],
    footer: [],
    ...overrides
  }
}

describe('buildReceiptHtml', () => {
  it('escapes a script-injection attempt in a product name', () => {
    const doc = baseDoc({
      items: [
        {
          productName: '<script>alert(1)</script>',
          sku: null,
          quantityText: '1',
          unit: null,
          unitPriceText: '$1.00',
          lineTotalText: '$1.00',
          ownDiscountText: null,
          invoiceDiscountShareText: null,
          taxRateLabel: null
        }
      ]
    })
    const html = buildReceiptHtml(doc, LAYOUT)
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('&lt;script&gt;')
  })

  it('escapes a quote-breakout attempt in the company name', () => {
    const doc = baseDoc({
      header: {
        companyName: '"><img src=x onerror=alert(1)>',
        branchName: null,
        addressLines: [],
        phone: null,
        taxIdentifierLabel: null,
        taxIdentifierValue: null,
        logo: null
      }
    })
    const html = buildReceiptHtml(doc, LAYOUT)
    expect(html).not.toContain('<img src=x onerror')
  })

  it('sets RTL direction for Arabic and LTR for English', () => {
    expect(buildReceiptHtml(baseDoc({ locale: 'ar' }), LAYOUT)).toContain('dir="rtl"')
    expect(buildReceiptHtml(baseDoc({ locale: 'en' }), LAYOUT)).toContain('dir="ltr"')
  })

  it('renders a mixed Arabic/English product name isolated in a bdi element', () => {
    const doc = baseDoc({
      locale: 'ar',
      items: [
        {
          productName: 'منتج Mixed 123',
          sku: null,
          quantityText: '1',
          unit: null,
          unitPriceText: '$1.00',
          lineTotalText: '$1.00',
          ownDiscountText: null,
          invoiceDiscountShareText: null,
          taxRateLabel: null
        }
      ]
    })
    const html = buildReceiptHtml(doc, LAYOUT)
    expect(html).toContain('<bdi dir="auto">منتج Mixed 123</bdi>')
  })

  it('shows the reprint badge only when isReprint is true', () => {
    expect(buildReceiptHtml(baseDoc({ isReprint: true }), LAYOUT)).toContain('Reprint')
    expect(buildReceiptHtml(baseDoc({ isReprint: false }), LAYOUT)).not.toContain('>Reprint<')
  })

  it('never includes a script tag anywhere, and blocks scripts via its own CSP meta tag', () => {
    const html = buildReceiptHtml(baseDoc(), LAYOUT)
    expect(html).not.toMatch(/<script/i)
    expect(html).toContain("default-src 'none'")
  })

  it('does not clip a long product name -- it is present in full, not truncated', () => {
    const longName = 'A'.repeat(200)
    const doc = baseDoc({
      items: [
        {
          productName: longName,
          sku: null,
          quantityText: '1',
          unit: null,
          unitPriceText: '$1.00',
          lineTotalText: '$1.00',
          ownDiscountText: null,
          invoiceDiscountShareText: null,
          taxRateLabel: null
        }
      ]
    })
    expect(buildReceiptHtml(doc, LAYOUT)).toContain(longName)
  })

  it('renders the refund band only for refund documents', () => {
    // Note: the stylesheet always defines .refund-band (it is shared, static CSS); the actual
    // element markup is what's conditional, so we assert on the element, not the class name alone.
    expect(buildReceiptHtml(baseDoc({ kind: 'sale' }), LAYOUT)).not.toContain('class="refund-band"')
    expect(
      buildReceiptHtml(
        baseDoc({
          kind: 'refund',
          refund: {
            refundNumber: 'REF-1',
            refundDateText: '2026-01-02',
            originalOfflineNumber: 'POS-1',
            originalServerNumber: null,
            stockReturned: true,
            reason: null
          }
        }),
        LAYOUT
      )
    ).toContain('class="refund-band"')
  })

  it('renders the page at the given printable width, not a hard-coded default', () => {
    const html58 = buildReceiptHtml(baseDoc(), { printableWidthMm: 48 })
    const html80 = buildReceiptHtml(baseDoc(), { printableWidthMm: 72 })
    expect(html58).toContain('style="width:48mm"')
    expect(html80).toContain('style="width:72mm"')
    expect(html58).not.toContain('style="width:72mm"')
  })
})

describe('POS improvements Stage 6: fiscal receipt (template v2)', () => {
  const zatca = {
    kind: 'zatca-sale' as const,
    title: 'Simplified Tax Invoice / فاتورة ضريبية مبسطة',
    seller: {
      name: 'Harbour Coffee Trading LLC',
      vatLabel: 'VAT No.',
      vatNumber: '310122393500003',
      addressLines: ['1 Corniche Road', 'Jeddah 23511', 'Saudi Arabia']
    },
    reference: null,
    historicalNote: null,
    qr: {
      type: 'zatca-p1' as const,
      payload:
        'AQxCb2JzIFJlY29yZHMCDzMxMDEyMjM5MzUwMDAwMwMUMjAyMi0wNC0yNVQxNTozMDowMFoEBzEwMDAuMDAFBjE1MC4wMA=='
    },
    breakdown: [{ label: 'Standard 15% · excl.', netText: '$10.00', taxText: '$1.50' }],
    netTotalLabel: 'Total excl. VAT',
    netTotalText: '$10.00',
    vatTotalLabel: 'Total VAT',
    vatTotalText: '$1.50'
  }

  it('prints the official title, the required seller fields, the breakdown and the QR', () => {
    const html = buildReceiptHtml(baseDoc({ fiscal: zatca }), LAYOUT)

    expect(html).toContain('data-receipt-title')
    expect(html).toContain('Simplified Tax Invoice / فاتورة ضريبية مبسطة')
    expect(html).toContain('Harbour Coffee Trading LLC')
    expect(html).toContain('310122393500003')
    expect(html).toContain('Jeddah 23511')
    expect(html).toContain('data-receipt-breakdown')
    expect(html).toContain('Total excl. VAT')
    expect(html).toMatch(
      /<div class="qr-block" id="receipt-qr" data-qr-type="zatca-p1"><svg [^>]*width="[\d.]+mm"/
    )
  })

  it('prints the seller block even when branding shows no address (required fields have no toggle)', () => {
    const html = buildReceiptHtml(
      baseDoc({ fiscal: zatca, header: { ...baseDoc().header, addressLines: [], phone: null } }),
      LAYOUT
    )
    expect(html).toContain('data-receipt-seller')
    expect(html).toContain('1 Corniche Road')
  })

  it('a historical copy carries its note and a reference QR, never a seller VAT block', () => {
    const html = buildReceiptHtml(
      baseDoc({
        fiscal: {
          ...zatca,
          kind: 'historical',
          title: 'Receipt – historical copy',
          seller: null,
          historicalNote: 'Issued before fiscal data was recorded; this is not a tax invoice.',
          qr: {
            type: 'txn-ref-v1',
            payload:
              'THINIS-TXN/1;co=11111111-1111-4111-8111-111111111111;doc=sale;id=22222222-2222-4222-8222-222222222222;ts=2026-01-01T10:00:00Z;amt=10.00;cur=USD'
          }
        }
      }),
      LAYOUT
    )
    expect(html).toContain('data-receipt-historical')
    expect(html).not.toContain('data-receipt-seller')
    expect(html).toContain('data-qr-type="txn-ref-v1"')
  })

  it('a receipt without a fiscal block (test print) has no QR', () => {
    expect(buildReceiptHtml(baseDoc(), LAYOUT)).not.toContain('receipt-qr')
  })
})
