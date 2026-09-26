import type { ReceiptDocument } from '@shared/receipt/receiptDocument'
import { receiptStrings } from '@shared/receipt/receiptStrings'
import { RECEIPT_TEMPLATE_VERSION } from './receiptDocument.service'

/**
 * Receipt-printing plan §D-4/§D-8 — a pure, fully-escaped static HTML template. Every value comes
 * from the already-formatted `ReceiptDocument`; this function makes no business decision and
 * fetches nothing. The CSP on the render window additionally blocks scripts, so this escaping is
 * defense in depth, not the only protection.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Bidi-isolated: a mixed Arabic/English product name or a Latin-digit number never disturbs the
 *  paragraph's own direction. */
function bdi(value: string, dir: 'auto' | 'ltr' = 'auto'): string {
  return `<bdi dir="${dir}">${escapeHtml(value)}</bdi>`
}

function row(label: string, value: string, cssClass = ''): string {
  return `<div class="row ${cssClass}"><span class="label">${escapeHtml(label)}</span><span class="value">${bdi(value, 'ltr')}</span></div>`
}

/** Label above value, both start-aligned -- for fields whose value can be long enough that
 *  side-by-side placement would wrap mid-value (e.g. the local receipt number). */
function stacked(label: string, value: string, cssClass = ''): string {
  return `<div class="stacked ${cssClass}"><div class="label">${escapeHtml(label)}</div><div class="value">${bdi(value, 'ltr')}</div></div>`
}

const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: #ffffff; color: #000000; overflow-x: hidden; }
  body {
    font-family: "Segoe UI", Tahoma, "Noto Sans Arabic", "Noto Sans", "DejaVu Sans", Arial, sans-serif;
    font-variant-numeric: tabular-nums;
    -webkit-font-smoothing: antialiased;
  }
  .page { width: var(--printable-width-mm, 72mm); margin: 0 auto; padding: 0; }
  .center { text-align: center; }
  .bold { font-weight: 700; }
  .small { font-size: 0.82em; }
  .hr { border: none; border-top: 1px dashed #000; margin: 3mm 0; }
  .hr-double { border: none; border-top: 2px solid #000; border-bottom: 1px solid #000; height: 3px; margin: 2mm 0; }
  .row { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.5mm 2mm; }
  .row .label { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
  .row .value { flex: 0 1 auto; text-align: end; white-space: nowrap; margin-inline-start: auto; }
  .stacked { margin: 0.5mm 0; }
  .stacked .label { font-size: 0.85em; color: #333; }
  .stacked .value { text-align: start; overflow-wrap: anywhere; }
  .logo { margin-bottom: 1.5mm; }
  .logo img { max-height: 24mm; max-width: 100%; }
  .header-title { font-size: 1.45em; font-weight: 700; }
  .letterhead-line { font-size: 0.9em; }
  .item { margin: 2mm 0; break-inside: avoid; }
  .item-name { overflow-wrap: anywhere; }
  .item-detail { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.5mm 2mm; font-size: 0.95em; }
  .item-detail span:first-child { overflow-wrap: anywhere; min-width: 0; }
  .item-detail span:last-child { white-space: nowrap; margin-inline-start: auto; }
  .item-sub { font-size: 0.82em; color: #333; display: flex; flex-wrap: wrap; gap: 0.5mm 3mm; }
  .item-sub span { white-space: nowrap; }
  .settlement { margin-top: 3mm; break-inside: avoid; }
  .grand-total { font-size: 2em; font-weight: 800; display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0 2mm; margin: 2mm 0; overflow-wrap: anywhere; }
  .badge { display: inline-block; border: 1.5px solid #000; padding: 0.5mm 2mm; font-size: 0.85em; margin-bottom: 2mm; }
  .refund-band { border: 2px solid #000; text-align: center; padding: 1.5mm; font-weight: 700; margin-bottom: 2mm; }
  .notice { font-size: 0.78em; color: #333; margin-top: 1.5mm; }
  .footer { text-align: center; margin-top: 3mm; font-size: 0.85em; }
  .continuation { text-align: center; font-size: 0.8em; border-bottom: 1px dashed #000; padding-bottom: 1mm; margin-bottom: 2mm; }
`

export interface ReceiptHtmlLayout {
  /** The printable width (plan §D-4: distinct from the nominal paper width). Drives the `.page`
   *  element's actual rendered width; every other measurement (margins, page height) is computed
   *  from this same layout in `receiptRenderer.ts`. */
  readonly printableWidthMm: number
}

export interface ReceiptHtmlAssets {
  /** A `data:` URL for `doc.header.logo`, resolved by main from the company-scoped asset store
   *  (plan §D-11) — never a bare path or remote URL. Null when there is no logo, or the frozen
   *  `included` flag was false (not yet downloaded at claim time). */
  readonly logoDataUrl: string | null
}

export function buildReceiptHtml(
  doc: ReceiptDocument,
  layout: ReceiptHtmlLayout,
  assets: ReceiptHtmlAssets = { logoDataUrl: null }
): string {
  const strings = receiptStrings(doc.locale)
  const dir = doc.locale === 'ar' ? 'rtl' : 'ltr'
  const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:;"

  const title =
    doc.kind === 'test'
      ? strings.testTitle
      : doc.kind === 'refund'
        ? strings.refundTitle
        : strings.saleTitle

  const reprintBadge = doc.isReprint
    ? `<div class="badge center">${escapeHtml(strings.reprintBadge)}</div>`
    : ''
  const testBadge =
    doc.kind === 'test' ? `<div class="badge center">${escapeHtml(strings.testTitle)}</div>` : ''
  const refundBand =
    doc.kind === 'refund' ? `<div class="refund-band">${escapeHtml(strings.refundTitle)}</div>` : ''

  const logoImg =
    doc.header.logo?.included && assets.logoDataUrl
      ? `<div class="center logo"><img src="${escapeHtml(assets.logoDataUrl)}" alt="" /></div>`
      : ''
  const taxIdentifierLine =
    doc.header.taxIdentifierLabel && doc.header.taxIdentifierValue
      ? `<div class="center letterhead-line">${escapeHtml(doc.header.taxIdentifierLabel)}: ${bdi(doc.header.taxIdentifierValue, 'ltr')}</div>`
      : ''

  const header = `
    ${logoImg}
    <div class="center header-title">${bdi(doc.header.companyName)}</div>
    ${doc.header.branchName ? `<div class="center letterhead-line">${bdi(doc.header.branchName)}</div>` : ''}
    ${doc.header.addressLines.map((line) => `<div class="center letterhead-line">${bdi(line)}</div>`).join('')}
    ${doc.header.phone ? `<div class="center letterhead-line">${bdi(doc.header.phone, 'ltr')}</div>` : ''}
    ${taxIdentifierLine}
  `

  const meta = `
    <div class="hr"></div>
    ${stacked(doc.meta.receiptNumberLabel, doc.meta.receiptNumber, 'bold')}
    ${doc.meta.serverNumber ? stacked(doc.meta.serverNumberLabel ?? '', doc.meta.serverNumber) : ''}
    <div class="stacked small"><div class="value">${bdi(doc.meta.dateTimeText, 'ltr')}</div></div>
    ${doc.meta.cashierName ? row(doc.meta.cashierLabel, doc.meta.cashierName) : ''}
    ${doc.meta.customerName ? row(strings.customerLabel, doc.meta.customerName) : ''}
  `

  const items = doc.items
    .map((item) => {
      const subParts: string[] = []
      if (item.ownDiscountText) {
        subParts.push(
          `<span>${escapeHtml(strings.discountLabel)}: ${bdi(item.ownDiscountText, 'ltr')}</span>`
        )
      }
      if (item.invoiceDiscountShareText) {
        subParts.push(
          `<span>${escapeHtml(strings.invoiceDiscountLabel)}: ${bdi(item.invoiceDiscountShareText, 'ltr')}</span>`
        )
      }
      if (item.taxRateLabel) {
        subParts.push(
          `<span>${escapeHtml(strings.taxLabel)}: ${bdi(item.taxRateLabel, 'ltr')}</span>`
        )
      }
      const detailLeft = [item.quantityText, item.unit].filter(Boolean).join(' ')
      const detailWithPrice = item.unitPriceText
        ? `${detailLeft} × ${item.unitPriceText}`
        : detailLeft
      return `
        <div class="item">
          <div class="item-name">${bdi(item.productName)}</div>
          <div class="item-detail"><span>${bdi(detailWithPrice, 'ltr')}</span><span>${bdi(item.lineTotalText, 'ltr')}</span></div>
          ${subParts.length > 0 ? `<div class="item-sub">${subParts.join('')}</div>` : ''}
        </div>
      `
    })
    .join('')

  const taxLines = doc.totals.taxLines
    .map((line) => row(`${strings.taxLabel} ${line.rateLabel}`, line.amountText))
    .join('')

  const payments = doc.totals.payments
    .map((payment) => {
      const label = payment.maskedReference
        ? `${payment.label} (${payment.maskedReference})`
        : payment.label
      return row(label, payment.amountText)
    })
    .join('')

  const settlement = `
    <div class="settlement">
      <div class="hr"></div>
      ${row(strings.subtotalLabel, doc.totals.subtotalText)}
      ${doc.totals.itemDiscountText ? row(strings.discountLabel, `−${doc.totals.itemDiscountText}`) : ''}
      ${doc.totals.invoiceDiscountText ? row(strings.invoiceDiscountLabel, `−${doc.totals.invoiceDiscountText}`) : ''}
      ${taxLines}
      <div class="hr-double"></div>
      <div class="grand-total"><span>${escapeHtml(strings.grandTotalLabel)}</span><span>${bdi(doc.totals.grandTotalText, 'ltr')}</span></div>
      ${payments}
      ${doc.totals.paidText ? row(strings.paidLabel, doc.totals.paidText) : ''}
      ${doc.totals.changeText ? row(strings.changeLabel, doc.totals.changeText) : ''}
    </div>
  `

  const refundBlock = doc.refund
    ? `
      <div class="hr"></div>
      ${row(strings.refundNumberLabel, doc.refund.refundNumber ?? '—')}
      ${row(strings.refundDateLabel, doc.refund.refundDateText)}
      ${row(strings.originalSaleLabel, doc.refund.originalOfflineNumber)}
      ${doc.refund.originalServerNumber ? row(strings.serverNumberLabel, doc.refund.originalServerNumber) : ''}
      ${doc.refund.stockReturned !== null ? row('', doc.refund.stockReturned ? strings.stockReturnedYes : strings.stockReturnedNo) : ''}
      ${doc.refund.reason ? row(strings.reasonLabel, doc.refund.reason) : ''}
    `
    : ''

  const notices = doc.notices.map((notice) => `<div class="notice">${bdi(notice)}</div>`).join('')
  const footer =
    doc.footer.length > 0
      ? `<div class="footer">${doc.footer.map((line) => `<div>${bdi(line)}</div>`).join('')}</div>`
      : `<div class="footer">${bdi(strings.footerThankYou)}</div>`

  return `<!doctype html>
<html dir="${dir}" lang="${escapeHtml(doc.locale)}">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="receipt-template-version" content="${RECEIPT_TEMPLATE_VERSION}" />
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="page" id="receipt-root" style="width:${layout.printableWidthMm}mm">
  ${reprintBadge}${testBadge}${refundBand}
  ${header}
  ${meta}
  <div class="hr"></div>
  ${items}
  ${settlement}
  ${refundBlock}
  ${notices}
  ${footer}
</div>
</body>
</html>`
}
