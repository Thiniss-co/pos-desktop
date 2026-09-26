import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildReceiptHtml } from '../src/main/receipt/receiptHtml'
import {
  getSharedReceiptRenderWindow,
  destroySharedReceiptRenderWindow,
  type RenderParams
} from '../src/main/receipt/receiptRenderer'
import type { ReceiptDocument, ReceiptLocale } from '../src/shared/receipt/receiptDocument'

/**
 * Real-Electron receipt render check (receipt-printing plan §8 verification). Produces actual
 * PDFs and PNG previews from real hidden BrowserWindow renders -- NOT a DOM simulation. Run with
 * `env -u ELECTRON_RUN_AS_NODE node scripts/runReceiptRenderCheck.mjs` (a real display is
 * required; DISPLAY must be set). This is layout evidence only: it proves what Chromium rendered
 * and paginated, not that a physical printer would honor the same page size or cut correctly.
 */

const outDir = process.env.RECEIPT_RENDER_OUT ?? '/tmp/receipt-render-check'

function money(amount: number, currency = 'EGP'): string {
  const whole = Math.trunc(amount / 100)
  const frac = String(amount % 100).padStart(2, '0')
  return `${whole}.${frac} ${currency}`
}

const LOGO_SHA256 = 'b'.repeat(64)
// A minimal valid 1x1 PNG -- sufficient to exercise the real `<img>` render/pagination/PDF path;
// visual fidelity of the pixel content is irrelevant to this layout-evidence check.
const LOGO_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

function saleDoc(opts: {
  locale: ReceiptLocale
  items: number
  longName?: boolean
  branded?: boolean
}): ReceiptDocument {
  const strings = opts.locale === 'ar' ? { total: 'الإجمالي' } : { total: 'Total' }
  void strings
  const items = Array.from({ length: opts.items }, (_, i) => ({
    productName: opts.longName
      ? 'A very long mixed product name that should wrap across multiple lines على الإيصال الحراري ' +
        (i + 1)
      : opts.locale === 'ar'
        ? `منتج تجريبي رقم ${i + 1}`
        : `Sample Product ${i + 1}`,
    sku: `SKU-${1000 + i}`,
    quantityText: i % 3 === 0 ? '1.500' : '1',
    unit: 'pc',
    unitPriceText: money(1000 + i * 50),
    lineTotalText: money((1000 + i * 50) * (i % 3 === 0 ? 1.5 : 1)),
    ownDiscountText: i % 4 === 0 ? money(50) : null,
    invoiceDiscountShareText: i % 5 === 0 ? money(20) : null,
    taxRateLabel: '15%'
  }))

  return {
    kind: 'sale',
    templateVersion: 1,
    locale: opts.locale,
    isReprint: false,
    header: opts.branded
      ? {
          companyName: opts.locale === 'ar' ? 'متجر أكمي' : 'Acme Store',
          branchName: opts.locale === 'ar' ? 'الفرع الرئيسي' : 'Main Branch',
          addressLines:
            opts.locale === 'ar'
              ? ['12 شارع التحرير', 'القاهرة، مصر']
              : ['12 Tahrir Street', 'Cairo, Egypt'],
          phone: '+20 100 123 4567',
          taxIdentifierLabel: opts.locale === 'ar' ? 'الرقم الضريبي' : 'Tax ID',
          taxIdentifierValue: '123-456-789',
          logo: { sha256: LOGO_SHA256, included: true }
        }
      : {
          companyName: opts.locale === 'ar' ? 'متجر أكمي' : 'Acme Store',
          branchName: opts.locale === 'ar' ? 'الفرع الرئيسي' : 'Main Branch',
          addressLines: [],
          phone: null,
          taxIdentifierLabel: null,
          taxIdentifierValue: null,
          logo: null
        },
    meta: {
      receiptNumberLabel: opts.locale === 'ar' ? 'رقم الإيصال' : 'Receipt no.',
      receiptNumber: 'POS-abc123-20260923-000042',
      serverNumberLabel: opts.locale === 'ar' ? 'رقم الفاتورة' : 'Server invoice no.',
      serverNumber: 'INV-000042',
      dateTimeText: '2026-09-23 14:05 (UTC+02:00)',
      cashierLabel: opts.locale === 'ar' ? 'الكاشير' : 'Cashier',
      cashierName: opts.locale === 'ar' ? 'سارة أحمد' : 'Sarah Ahmed',
      customerName: opts.locale === 'ar' ? 'عميل تجريبي' : 'Walk-in Customer',
      customerTaxNumber: null,
      currency: 'EGP'
    },
    items,
    totals: {
      subtotalText: money(items.length * 1000),
      itemDiscountText: money(70),
      invoiceDiscountText: money(30),
      taxLines: [
        { rateLabel: '15%', amountText: money(150) },
        { rateLabel: '5%', amountText: money(20) }
      ],
      grandTotalText: money(items.length * 1150),
      payments: [
        {
          label: opts.locale === 'ar' ? 'نقدًا' : 'Cash',
          amountText: money(1000),
          maskedReference: null
        },
        {
          label: opts.locale === 'ar' ? 'بطاقة' : 'Card',
          amountText: money((items.length - 1) * 1150),
          maskedReference: '••••4242'
        }
      ],
      paidText: money(items.length * 1200),
      changeText: money(50)
    },
    refund: null,
    notices: [],
    footer: [opts.locale === 'ar' ? 'شكرًا لتعاملكم معنا' : 'Thank you for shopping with us']
  }
}

function refundDoc(locale: ReceiptLocale, branded = false): ReceiptDocument {
  return {
    kind: 'refund',
    templateVersion: 1,
    locale,
    isReprint: true,
    header: branded
      ? {
          companyName: locale === 'ar' ? 'متجر أكمي' : 'Acme Store',
          branchName: 'Main Branch',
          addressLines:
            locale === 'ar'
              ? ['12 شارع التحرير', 'القاهرة، مصر']
              : ['12 Tahrir Street', 'Cairo, Egypt'],
          phone: '+20 100 123 4567',
          taxIdentifierLabel: locale === 'ar' ? 'الرقم الضريبي' : 'Tax ID',
          taxIdentifierValue: '123-456-789',
          logo: { sha256: LOGO_SHA256, included: true }
        }
      : {
          companyName: locale === 'ar' ? 'متجر أكمي' : 'Acme Store',
          branchName: 'Main Branch',
          addressLines: [],
          phone: null,
          taxIdentifierLabel: null,
          taxIdentifierValue: null,
          logo: null
        },
    meta: {
      receiptNumberLabel: locale === 'ar' ? 'رقم الاسترداد' : 'Refund no.',
      receiptNumber: 'REF-000007',
      serverNumberLabel: null,
      serverNumber: null,
      dateTimeText: '2026-09-24 09:12 (UTC+02:00)',
      cashierLabel: 'Cashier',
      cashierName: 'Omar Khaled',
      customerName: null,
      customerTaxNumber: null,
      currency: 'EGP'
    },
    items: [
      {
        productName: 'Sample Product 3',
        sku: 'SKU-1002',
        quantityText: '1',
        unit: 'pc',
        unitPriceText: money(1100),
        lineTotalText: money(1100),
        ownDiscountText: null,
        invoiceDiscountShareText: null,
        taxRateLabel: '15%'
      }
    ],
    totals: {
      subtotalText: money(1100),
      itemDiscountText: null,
      invoiceDiscountText: null,
      taxLines: [{ rateLabel: 'Tax', amountText: money(165) }],
      grandTotalText: money(1265),
      payments: [{ label: 'Cash', amountText: money(1265), maskedReference: null }],
      paidText: null,
      changeText: null
    },
    refund: {
      refundNumber: 'REF-000007',
      refundDateText: '2026-09-24 09:12 (UTC+02:00)',
      originalOfflineNumber: 'POS-abc123-20260920-000012',
      originalServerNumber: 'INV-000012',
      stockReturned: true,
      reason: 'Customer changed their mind'
    },
    notices: [],
    footer: []
  }
}

interface Scenario {
  readonly name: string
  readonly doc: ReceiptDocument
  readonly paperWidthMm: 58 | 80
}

const scenarios: Scenario[] = [
  { name: 'sale-short-58mm-en', doc: saleDoc({ locale: 'en', items: 1 }), paperWidthMm: 58 },
  { name: 'sale-short-80mm-en', doc: saleDoc({ locale: 'en', items: 1 }), paperWidthMm: 80 },
  { name: 'sale-medium-80mm-en', doc: saleDoc({ locale: 'en', items: 8 }), paperWidthMm: 80 },
  { name: 'sale-medium-58mm-ar', doc: saleDoc({ locale: 'ar', items: 8 }), paperWidthMm: 58 },
  {
    name: 'sale-long-80mm-en',
    doc: saleDoc({ locale: 'en', items: 60, longName: true }),
    paperWidthMm: 80
  },
  {
    name: 'sale-long-58mm-ar',
    doc: saleDoc({ locale: 'ar', items: 60, longName: true }),
    paperWidthMm: 58
  },
  { name: 'refund-80mm-en', doc: refundDoc('en'), paperWidthMm: 80 },
  { name: 'refund-58mm-ar', doc: refundDoc('ar'), paperWidthMm: 58 },
  // Receipt-printing plan §D-11 -- company branding (logo, address, phone, tax id) rendered from
  // the CAPTURED profile version, exactly as `receiptDocument.service.ts` assembles it.
  {
    name: 'sale-branded-80mm-en',
    doc: saleDoc({ locale: 'en', items: 3, branded: true }),
    paperWidthMm: 80
  },
  {
    name: 'sale-branded-58mm-ar',
    doc: saleDoc({ locale: 'ar', items: 3, branded: true }),
    paperWidthMm: 58
  },
  { name: 'refund-branded-80mm-en', doc: refundDoc('en', true), paperWidthMm: 80 }
]

async function main(): Promise<void> {
  await app.whenReady()
  mkdirSync(outDir, { recursive: true })

  const summary: Record<string, unknown>[] = []
  // One shared, reused render window for the whole run -- see receiptRenderer.ts's module-level
  // comment for why this is both the plan's own design and an environment necessity here.
  const renderWindow = getSharedReceiptRenderWindow()

  try {
    for (const scenario of scenarios) {
      const html = buildReceiptHtml(
        scenario.doc,
        { printableWidthMm: scenario.paperWidthMm === 58 ? 48 : 72 },
        {
          logoDataUrl: scenario.doc.header.logo ? `data:image/png;base64,${LOGO_PNG_BASE64}` : null
        }
      )
      writeFileSync(join(outDir, `${scenario.name}.html`), html)
      console.log(`[${scenario.name}] html length=${html.length}`)
      const params: RenderParams = {
        html,
        paperWidthMm: scenario.paperWidthMm,
        printableWidthMm: scenario.paperWidthMm === 58 ? 48 : 72,
        marginTopMm: 2,
        marginBottomMm: 6,
        pageLengthProfile: 'content_sized',
        maxContinuousLengthMm: 1000,
        fixedPageHeightMm: 297
      }

      const plan = await renderWindow.render(params)
      const pngDataUrl = await renderWindow.capturePreviewPage()
      const verify = await renderWindow.verifyWithPdf()

      const pngBase64 = pngDataUrl.split(',')[1]!
      writeFileSync(join(outDir, `${scenario.name}.png`), Buffer.from(pngBase64, 'base64'))
      writeFileSync(join(outDir, `${scenario.name}.pdf`), verify.pdf)

      summary.push({
        name: scenario.name,
        pageWidthMm: scenario.paperWidthMm,
        planPageHeightMm: plan.pageHeightUm / 1000,
        planPageCount: plan.pageCount,
        pdfPageCount: verify.pageCount,
        matches: verify.matches,
        pdfBytes: verify.pdf.length
      })
    }

    // A dedicated one-item-receipt check for the "second blank page" regression the plan calls
    // out by name.
    const oneItem = saleDoc({ locale: 'en', items: 1 })
    const onePlan = await renderWindow.render({
      html: buildReceiptHtml(oneItem, { printableWidthMm: 72 }),
      paperWidthMm: 80,
      printableWidthMm: 72,
      marginTopMm: 2,
      marginBottomMm: 6,
      pageLengthProfile: 'content_sized',
      maxContinuousLengthMm: 1000,
      fixedPageHeightMm: 297
    })
    const oneVerify = await renderWindow.verifyWithPdf()
    summary.push({
      name: 'ONE-ITEM-REGRESSION-CHECK',
      planPageCount: onePlan.pageCount,
      pdfPageCount: oneVerify.pageCount,
      noSecondBlankPage: oneVerify.pageCount === 1
    })

    // Confirm dispatchPrint's synchronous-throw path (T8) is truly synchronous-catchable, and its
    // callback path resolves cleanly when no printer is installed.
    const testDoc = saleDoc({ locale: 'en', items: 1 })
    await renderWindow.render({
      html: buildReceiptHtml(testDoc, { printableWidthMm: 72 }),
      paperWidthMm: 80,
      printableWidthMm: 72,
      marginTopMm: 2,
      marginBottomMm: 6,
      pageLengthProfile: 'content_sized',
      maxContinuousLengthMm: 1000,
      fixedPageHeightMm: 297
    })
    try {
      const dispatchResult = await renderWindow.dispatchPrint({
        deviceName: 'a-device-name-that-does-not-exist',
        silent: true,
        copies: 1
      })
      summary.push({ name: 'DISPATCH-NO-SUCH-PRINTER', ...dispatchResult })
    } catch (error) {
      summary.push({
        name: 'DISPATCH-NO-SUCH-PRINTER',
        threwSynchronously: true,
        message: (error as Error).message
      })
    }

    // Receipt-printing plan §D-11 -- rasterizes the ACTUAL HTML this session's real Electron <->
    // real Laravel receipt-profile integration gate produced from its own real transactions
    // (`tests/electron/suites/receiptProfileLiveUpload.suite.ts`), rather than a synthetic fixture.
    // Each `*.html` file there is already-built output (real captured branding); this step only
    // proves it paginates and rasterizes correctly under real Chromium.
    const gateArtifactsDir = join(process.cwd(), 'docs', 'audits', 'artifacts', 'receipt-profile')
    if (existsSync(gateArtifactsDir)) {
      for (const entry of readdirSync(gateArtifactsDir)) {
        if (!entry.endsWith('.html')) {
          continue
        }
        const name = entry.replace(/\.html$/, '')
        const html = readFileSync(join(gateArtifactsDir, entry), 'utf8')
        const paperWidthMm = name.includes('58') ? 58 : 80
        const printableWidthMm = paperWidthMm === 58 ? 48 : 72
        const plan = await renderWindow.render({
          html,
          paperWidthMm,
          printableWidthMm,
          marginTopMm: 2,
          marginBottomMm: 6,
          pageLengthProfile: 'content_sized',
          maxContinuousLengthMm: 1000,
          fixedPageHeightMm: 297
        })
        const pngDataUrl = await renderWindow.capturePreviewPage()
        const verify = await renderWindow.verifyWithPdf()
        const pngBase64 = pngDataUrl.split(',')[1]!
        writeFileSync(join(gateArtifactsDir, `${name}.png`), Buffer.from(pngBase64, 'base64'))
        writeFileSync(join(gateArtifactsDir, `${name}.pdf`), verify.pdf)
        summary.push({
          name: `GATE-ARTIFACT-${name}`,
          planPageCount: plan.pageCount,
          pdfPageCount: verify.pageCount,
          matches: verify.matches
        })
      }
    }
  } finally {
    destroySharedReceiptRenderWindow()
  }

  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
  console.log(`\nOutputs written to ${outDir}`)

  app.exit(0)
}

main().catch((error) => {
  console.error(error)
  app.exit(1)
})
