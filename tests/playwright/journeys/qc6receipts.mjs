import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import jsQR from 'jsqr'
import { chromium } from 'playwright-core'
import { t, virtualPrintDir } from '../support/app.mjs'
import {
  launchAgain,
  openSandboxAndApp,
  payExactCash,
  refreshWorkstation,
  scan,
  setupPhysicalPresenceTill,
  sizeWindow,
  waitForRoute,
  waitForServerInvoices
} from '../support/journey.mjs'
import { localDatabasePath, queryLocal } from '../support/localDb.mjs'

/**
 * POS improvements, Stage 6 — fiscal identity, mandatory QR and branded receipts, end to end.
 * Every print goes to the VIRTUAL printer (no physical device); each printed PDF is rasterized with
 * `pdftoppm` and its QR decoded independently with jsQR, then compared with the frozen local facts.
 *
 *  1. A sale BEFORE the owner switches ZATCA on prints "Receipt" with a `txn-ref-v1` QR.
 *  2. Owner portal (Chrome): legal name + VAT, address + postal code, then the ZATCA switch; receipt
 *     branding hides the cashier and the profile address lines.
 *  3. Register refresh mirrors the identity. A ZATCA sale prints "Simplified Tax Invoice" with the
 *     seller name, VAT and seller address, the VAT breakdown and a ZATCA QR (TLV decoded field by
 *     field), on 80 mm and on 58 mm paper (printable ≤ 48 mm).
 *  4. An OFFLINE ZATCA sale freezes the mirrored identity and prints the same way.
 *  5. The owner moves the company: a reprint of sale 3 keeps the OLD frozen address; a new sale after
 *     refresh shows the new one.
 *  6. A partial refund of sale 3 prints a "Credit Note / إشعار دائن" with the server-frozen identity,
 *     the original-invoice reference and a ZATCA QR over the note's own time stamp and totals.
 *  7. FAULT INJECTION (labelled): with the app closed, a stored QR payload is corrupted on the
 *     disposable profile; the reprint is refused before dispatch (RECEIPT_QR_INVALID), nothing reaches
 *     the printer, and the sale itself is untouched.
 */

const ADMIN = { email: 'admin@desktop-mvp.test', password: 'Password123!' }
const COLA = '6221000000011'
const CHIPS = '6221000000035'
const IDENTITY = {
  legalName: 'Desktop MVP Trading LLC',
  vat: '310122393500003',
  street: '1 Corniche Road',
  newStreet: '77 Harbour Avenue',
  city: 'Jeddah',
  postal: '23511',
  country: 'Saudi Arabia'
}

/** Independent TLV decode (not the app's own decoder): tags 1–5, one-byte tag and UTF-8 byte length. */
function decodeZatcaPhase1Qr(payload) {
  const bytes = Buffer.from(payload, 'base64')
  if (bytes.length === 0 || bytes.toString('base64') !== payload) return null
  const values = []
  let offset = 0
  for (let tag = 1; tag <= 5; tag += 1) {
    if (bytes[offset] !== tag) return null
    const length = bytes[offset + 1]
    values.push(bytes.subarray(offset + 2, offset + 2 + length).toString('utf8'))
    offset += 2 + length
  }
  if (offset !== bytes.length) return null
  const [sellerName, vatNumber, timestamp, total, vatTotal] = values
  return { sellerName, vatNumber, timestamp, total, vatTotal }
}

export function decodeTransactionReferenceQr(text) {
  const match =
    /^THINIS-TXN\/1;co=([0-9a-f-]{36});doc=(sale|refund);id=([0-9a-f-]{36});ts=([0-9TZ:-]{20});amt=([\d.]+);cur=([A-Z]{3})$/.exec(
      text
    )
  return match
    ? { co: match[1], doc: match[2], id: match[3], ts: match[4], amt: match[5], cur: match[6] }
    : null
}

export function pdfFiles(profileDir) {
  const dir = virtualPrintDir(profileDir)
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((name) => name.endsWith('.pdf'))
    .sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]) || a.localeCompare(b))
    .map((name) => join(dir, name))
}

export function dispatchCount(profileDir) {
  try {
    return readFileSync(join(virtualPrintDir(profileDir), 'dispatches.log'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean).length
  } catch {
    return 0
  }
}

/** Independent QR decode from the printed PDF: pdftoppm (PPM, 400 dpi) → RGBA → jsQR. */
export function decodePdfQr(pdfPath) {
  const out = spawnSync('pdftoppm', ['-r', '400', '-singlefile', pdfPath], {
    maxBuffer: 256 * 1024 * 1024
  })
  if (out.status !== 0) throw new Error(`pdftoppm failed: ${out.stderr}`)
  const buffer = out.stdout
  // P6 header: "P6\n<width> <height>\n<max>\n"
  let offset = 0
  const tokens = []
  while (tokens.length < 4) {
    while (buffer[offset] === 0x0a || buffer[offset] === 0x20) offset += 1
    let token = ''
    while (buffer[offset] !== 0x0a && buffer[offset] !== 0x20)
      token += String.fromCharCode(buffer[offset++])
    tokens.push(token)
  }
  offset += 1
  const [, width, height] = tokens.map(Number)
  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let i = 0, j = offset; i < width * height; i += 1, j += 3) {
    rgba[i * 4] = buffer[j]
    rgba[i * 4 + 1] = buffer[j + 1]
    rgba[i * 4 + 2] = buffer[j + 2]
    rgba[i * 4 + 3] = 255
  }
  return jsQR(rgba, width, height)?.data ?? null
}

export function pdfText(pdfPath) {
  return spawnSync('pdftotext', ['-layout', pdfPath, '-'], { encoding: 'utf8' }).stdout
}

function pdfWidthMm(pdfPath) {
  const info = spawnSync('pdfinfo', [pdfPath], { encoding: 'utf8' }).stdout
  const match = /Page size:\s+([\d.]+) x ([\d.]+) pts/.exec(info)
  return match ? Math.round((Number(match[1]) * 25.4) / 72) : null
}

async function print(page, document, overrides = {}) {
  return await page.evaluate(
    async ([doc, opts]) => {
      const preview = await window.posApi.printing.preview({
        document: doc,
        locale: 'en',
        overrides: opts
      })
      if (!preview.ok) return { stage: 'preview', error: preview.error }
      const job = await window.posApi.printing.dispatch({
        requestId: crypto.randomUUID(),
        document: doc,
        locale: 'en',
        overrides: opts,
        preview: {
          previewDocumentSha256: preview.data.previewDocumentSha256,
          previewOptionsSha256: preview.data.previewOptionsSha256
        }
      })
      return job.ok ? job.data : { stage: 'dispatch', error: job.error }
    },
    [document, overrides]
  )
}

/** A refresh can leave a background catalog install running; sales are held until it finishes. */
export async function waitForCatalogIdle(page) {
  const updating = await t(page, 'shell.workstationRefresh.updating')
  await page.waitForFunction((text) => !document.body.innerText.includes(text), updating, {
    timeout: 60_000
  })
}

async function sellExactCash(ctx, page, codes) {
  await waitForCatalogIdle(page)
  for (const code of codes) await scan(ctx, page, code)
  await payExactCash(ctx, page)
  await page
    .getByRole('dialog')
    .getByRole('button', { name: new RegExp(await t(page, 'pos.tender.newSale')) })
    .click()
  await page.waitForTimeout(500)
}

function latestInvoice(profileDir) {
  const [invoice] = queryLocal(
    profileDir,
    'SELECT local_uuid, sold_at, grand_total_amount, tax_total_amount FROM local_invoices ORDER BY created_at DESC, rowid DESC LIMIT 1'
  )
  const [context] = queryLocal(
    profileDir,
    'SELECT regime, qr_type, qr_payload, seller_name, vat_number, seller_address_json FROM local_invoice_fiscal_context WHERE invoice_local_uuid = ?',
    [invoice.local_uuid]
  )
  return { invoice, context }
}

/** Prints a sale and returns the evidence of the printed PDF. */
async function printSale(ctx, session, invoiceUuid, label, overrides = {}) {
  const before = pdfFiles(session.profileDir).length
  const job = await print(session.page, { kind: 'sale', invoiceLocalUuid: invoiceUuid }, overrides)
  if (job?.status !== 'submitted')
    throw new Error(`${label}: print not submitted ${JSON.stringify(job)}`)
  let files = pdfFiles(session.profileDir)
  for (let i = 0; i < 30 && files.length === before; i += 1) {
    await session.page.waitForTimeout(200)
    files = pdfFiles(session.profileDir)
  }
  const pdf = files.at(-1)
  const evidence = { pdf, qr: decodePdfQr(pdf), text: pdfText(pdf), widthMm: pdfWidthMm(pdf) }
  ctx.step(`${label}: printed`, {
    job: job.status,
    pdf: pdf.split('/').at(-1),
    widthMm: evidence.widthMm,
    qrDecoded: evidence.qr !== null
  })
  return evidence
}

async function ownerSave(owner, section, fill) {
  await owner.goto(new URL(`/owner/settings?section=${section}`, owner.url()).toString())
  await owner.getByTestId(`settings-save-${section}`).waitFor()
  await fill()
  const saved = owner.waitForResponse(
    (r) => r.request().method() === 'PATCH' && /company-settings$/.test(r.url())
  )
  await owner.getByTestId(`settings-save-${section}`).click()
  const response = await saved
  if (response.status() !== 200)
    throw new Error(`owner ${section} save answered ${response.status()}: ${await response.text()}`)
  await owner.waitForTimeout(300)
}

export async function run(ctx) {
  const session = await openSandboxAndApp(ctx, {
    proxy: true,
    flags: { POS_OFFLINE_PHYSICAL_PRESENCE_ENABLED: 'true' }
  })
  const { sandbox } = session
  const chrome = await chromium.launchPersistentContext(join(ctx.runDir, 'chrome'), {
    ...(process.env.PW_CHROME_PATH
      ? { executablePath: process.env.PW_CHROME_PATH }
      : { channel: 'chrome' }),
    headless: true,
    viewport: { width: 1280, height: 900 }
  })
  const owner = chrome.pages()[0] ?? (await chrome.newPage())
  try {
    const device = await setupPhysicalPresenceTill(ctx, session)
    const page = session.page
    await sizeWindow(session, 1600, 900)
    const settings = await page.evaluate(
      async () => (await window.posApi.printing.getWorkstationSettings()).data
    )
    await page.evaluate(
      async (next) => await window.posApi.printing.saveWorkstationSettings(next),
      {
        ...settings,
        printerName: 'PW-Virtual-80',
        paperWidthMm: 80,
        printableWidthMm: 72,
        dispatchMode: 'direct'
      }
    )
    ctx.step('workstation printer: PW-Virtual-80 (virtual adapter)')

    // 1. Non-fiscal sale.
    await sellExactCash(ctx, page, [COLA])
    const plain = latestInvoice(session.profileDir)
    ctx.step('1: non-fiscal sale context', {
      regime: plain.context.regime,
      qrType: plain.context.qr_type
    })
    if (plain.context.regime !== 'none' || plain.context.qr_type !== 'txn-ref-v1')
      throw new Error('1: expected a non-fiscal context')
    const plainPrint = await printSale(ctx, session, plain.invoice.local_uuid, '1')
    const plainRef = decodeTransactionReferenceQr(plainPrint.qr ?? '')
    if (plainPrint.qr !== plain.context.qr_payload || plainRef?.id !== plain.invoice.local_uuid)
      throw new Error('1: the printed reference QR does not match')
    if (/Simplified Tax Invoice/.test(plainPrint.text))
      throw new Error('1: a non-fiscal receipt must not carry the ZATCA title')

    // 2. Owner portal.
    await owner.goto(new URL('/owner/login', sandbox.origin).toString())
    await owner.locator('#email').fill(ADMIN.email)
    await owner.locator('#password').fill(ADMIN.password)
    await owner.locator('button[type=submit]').click()
    await owner.waitForURL((u) => !u.pathname.endsWith('/login'))
    await ownerSave(owner, 'legal', async () => {
      await owner.locator('#settings-legal-name').fill(IDENTITY.legalName)
      await owner.locator('#settings-tax-number').fill(IDENTITY.vat)
    })
    await ownerSave(owner, 'contact', async () => {
      await owner.locator('#settings-street').fill(IDENTITY.street)
      await owner.locator('#settings-city').fill(IDENTITY.city)
      await owner.locator('#settings-postal-code').fill(IDENTITY.postal)
      await owner.locator('#settings-country').fill(IDENTITY.country)
    })
    await ownerSave(owner, 'fiscal', async () => {
      await owner.locator('#settings-fiscal-regime').selectOption('sa_zatca_phase1')
    })
    await ctx.shot(owner, '02a-owner-fiscal-zatca')
    await owner.goto(new URL('/owner/settings?section=receipt', owner.url()).toString())
    await owner.getByTestId('receipt-display').waitFor()
    await owner
      .locator('#receipt-address-0')
      .fill('Profile line (optional)')
      .catch(() => undefined)
    await owner.locator('#receipt-display-show_cashier').uncheck()
    await owner.locator('#receipt-display-show_address').uncheck()
    await ctx.shot(owner, '02b-owner-receipt-display')
    const published = owner.waitForResponse(
      (r) => r.request().method() === 'PUT' && /receipt-profile$/.test(r.url())
    )
    await owner.getByTestId('receipt-publish').click()
    const publishedResponse = await published
    ctx.step(
      '2: owner saved the fiscal identity, switched ZATCA on and published receipt display choices',
      {
        publish: publishedResponse.status()
      }
    )
    if (publishedResponse.status() >= 300)
      throw new Error(`2: publish answered ${publishedResponse.status()}`)

    // 3. ZATCA sale, 80 mm and 58 mm.
    await refreshWorkstation(ctx, page)
    const [mirror] = queryLocal(
      session.profileDir,
      'SELECT regime, seller_name, vat_number, street, postal_code, revision FROM fiscal_identity'
    )
    ctx.step('3: mirrored identity', mirror)
    if (mirror?.regime !== 'sa_zatca_phase1') throw new Error('3: the identity was not mirrored')
    await sellExactCash(ctx, page, [COLA, CHIPS])
    const zatca = latestInvoice(session.profileDir)
    const zatcaPrint = await printSale(ctx, session, zatca.invoice.local_uuid, '3 (80 mm)')
    const fields = decodeZatcaPhase1Qr(zatcaPrint.qr ?? '')
    ctx.step('3: decoded ZATCA QR', fields)
    const expectedTotal = (Number(zatca.invoice.grand_total_amount) / 100).toFixed(2)
    const expectedVat = (Number(zatca.invoice.tax_total_amount) / 100).toFixed(2)
    if (
      zatcaPrint.qr !== zatca.context.qr_payload ||
      fields?.sellerName !== IDENTITY.legalName ||
      fields?.vatNumber !== IDENTITY.vat ||
      fields?.timestamp !== `${String(zatca.invoice.sold_at).slice(0, 19)}Z` ||
      fields?.total !== expectedTotal ||
      fields?.vatTotal !== expectedVat
    ) {
      throw new Error('3: the printed ZATCA QR does not carry the frozen facts')
    }
    for (const needle of [
      'Simplified Tax Invoice',
      IDENTITY.legalName,
      IDENTITY.vat,
      IDENTITY.street,
      'Total excl. VAT'
    ]) {
      if (!zatcaPrint.text.includes(needle))
        throw new Error(`3: the receipt is missing "${needle}"`)
    }
    if (zatcaPrint.text.includes('Profile line (optional)'))
      throw new Error('3: hidden profile address lines were printed')
    if (zatcaPrint.text.includes('Desktop MVP Cashier'))
      throw new Error('3: the owner hid the cashier, but it was printed')
    const narrow = await printSale(ctx, session, zatca.invoice.local_uuid, '3 (58 mm)', {
      paperWidthMm: 58
    })
    if (narrow.widthMm !== 58 || narrow.qr !== zatca.context.qr_payload)
      throw new Error(`3: the 58 mm print failed (${narrow.widthMm} mm)`)

    // 4. Offline ZATCA sale.
    await session.proxy.offline()
    await page.evaluate(async () => await window.posApi.connectivity.checkNow())
    await sellExactCash(ctx, page, [COLA])
    const offline = latestInvoice(session.profileDir)
    const offlinePrint = await printSale(ctx, session, offline.invoice.local_uuid, '4 (offline)')
    if (
      offline.context.regime !== 'sa_zatca_phase1' ||
      offlinePrint.qr !== offline.context.qr_payload
    )
      throw new Error('4: the offline ZATCA sale did not freeze or print its identity')
    await session.proxy.online()
    await page.evaluate(async () => await window.posApi.connectivity.checkNow())
    await waitForServerInvoices(sandbox, device, 3, 120_000)

    // 5. Address change: old receipts keep the frozen address.
    await ownerSave(owner, 'contact', async () => {
      await owner.locator('#settings-street').fill(IDENTITY.newStreet)
    })
    await refreshWorkstation(ctx, page)
    const reprint = await printSale(ctx, session, zatca.invoice.local_uuid, '5 (reprint of sale 3)')
    if (!reprint.text.includes(IDENTITY.street) || reprint.text.includes(IDENTITY.newStreet))
      throw new Error('5: the reprint did not keep the frozen address')
    await sellExactCash(ctx, page, [CHIPS])
    const moved = latestInvoice(session.profileDir)
    const movedPrint = await printSale(ctx, session, moved.invoice.local_uuid, '5 (new sale)')
    if (!movedPrint.text.includes(IDENTITY.newStreet))
      throw new Error('5: the new sale does not show the new address')
    ctx.step('5: frozen versus current address', { reprintKeepsOld: true, newSaleShowsNew: true })

    // 6. Credit note.
    await page.locator('.quick-actions [data-action="refund"]').click()
    await page.getByTestId('refund-entry-dialog').waitFor()
    await page.getByTestId(`refund-entry-${zatca.invoice.local_uuid}`).click()
    const refundDialog = page.getByRole('dialog')
    await refundDialog
      .getByRole('button', { name: await t(page, 'refunds.increaseQuantity') })
      .first()
      .click()
    await refundDialog.getByRole('button', { name: await t(page, 'refunds.previewAction') }).click()
    const confirmPrefix = (
      await t(page, 'refunds.confirmActionAmount', { amount: '\u0000' })
    ).split('\u0000')[0]
    await refundDialog.getByRole('button', { name: new RegExp(`^${confirmPrefix}`) }).click()
    await refundDialog.getByText(await t(page, 'refunds.success')).waitFor({ timeout: 30_000 })
    await refundDialog.getByRole('button', { name: await t(page, 'refunds.close') }).click()
    const [refund] = queryLocal(
      session.profileDir,
      'SELECT r.local_uuid, r.grand_total_amount, r.tax_total_amount, c.regime, c.qr_payload, c.fiscal_json FROM local_refunds r JOIN local_refund_fiscal_context c ON c.refund_local_uuid = r.local_uuid ORDER BY r.created_at DESC LIMIT 1'
    )
    const refundFiscal = JSON.parse(refund?.fiscal_json ?? 'null')
    const beforeRefundPdf = pdfFiles(session.profileDir).length
    const refundJob = await print(page, { kind: 'refund', refundLocalUuid: refund.local_uuid })
    if (refundJob?.status !== 'submitted')
      throw new Error(`6: credit note print ${JSON.stringify(refundJob)}`)
    let refundPdfs = pdfFiles(session.profileDir)
    for (let i = 0; i < 30 && refundPdfs.length === beforeRefundPdf; i += 1) {
      await page.waitForTimeout(200)
      refundPdfs = pdfFiles(session.profileDir)
    }
    const notePdf = refundPdfs.at(-1)
    const noteQr = decodePdfQr(notePdf)
    const noteText = pdfText(notePdf)
    const noteFlat = noteText.replace(/\s+/g, ' ')
    const noteFields = decodeZatcaPhase1Qr(noteQr ?? '')
    ctx.step('6: credit note', {
      regime: refund?.regime,
      serverIssuedAt: refundFiscal?.issued_at,
      originalInvoice: refundFiscal?.original_invoice,
      qr: noteFields,
      titled: noteText.includes('Credit Note'),
      referenced: noteFlat.includes('This credit note relates to invoice number')
    })
    if (
      refund?.regime !== 'sa_zatca_phase1' ||
      noteQr !== refund.qr_payload ||
      noteFields?.timestamp !== refundFiscal?.issued_at ||
      noteFields?.total !== (Number(refund.grand_total_amount) / 100).toFixed(2) ||
      !noteText.includes('Credit Note') ||
      !noteFlat.includes(
        `This credit note relates to invoice number ${refundFiscal?.original_invoice?.number}`
      ) ||
      // The note carries the identity the SERVER froze when it accepted the refund (after step 5).
      !noteFlat.includes(refundFiscal?.seller_address?.street ?? '\u0000')
    ) {
      throw new Error('6: the credit note is not the server-frozen ZATCA note')
    }

    // 7. Fault injection: a corrupted stored payload is never printed.
    await session.app.close()
    const corrupt = spawnSync(
      'python3',
      [
        '-c',
        [
          'import sqlite3, sys',
          'c = sqlite3.connect(sys.argv[1])',
          'c.execute("DROP TRIGGER local_invoice_fiscal_context_immutable_update")',
          "c.execute(\"UPDATE local_invoice_fiscal_context SET qr_payload = replace(qr_payload, 'A', 'B') WHERE invoice_local_uuid = ?\", (sys.argv[2],))",
          'c.commit()',
          'print(c.total_changes)'
        ].join('\n'),
        localDatabasePath(session.profileDir),
        moved.invoice.local_uuid
      ],
      { encoding: 'utf8' }
    )
    ctx.step(
      '7: FAULT INJECTION — corrupted the stored QR payload of one sale (app closed, disposable profile)',
      {
        changes: corrupt.stdout.trim(),
        error: corrupt.stderr.trim() || null
      }
    )
    await launchAgain(ctx, session)
    await waitForRoute(session.page, 'pos')
    const dispatchesBefore = dispatchCount(session.profileDir)
    const refused = await print(session.page, {
      kind: 'sale',
      invoiceLocalUuid: moved.invoice.local_uuid
    })
    const dispatchesAfter = dispatchCount(session.profileDir)
    const [stillThere] = queryLocal(
      session.profileDir,
      'SELECT sync_status FROM local_invoices WHERE local_uuid = ?',
      [moved.invoice.local_uuid]
    )
    ctx.step('7: corrupted payload refused before dispatch', {
      status: refused?.status,
      failureCode: refused?.failureCode,
      dispatchesBefore,
      dispatchesAfter,
      saleSyncStatus: stillThere?.sync_status
    })
    if (
      refused?.status !== 'failed_before_dispatch' ||
      refused?.failureCode !== 'RECEIPT_QR_INVALID' ||
      dispatchesAfter !== dispatchesBefore
    ) {
      throw new Error('7: a corrupted QR must never reach the printer')
    }
  } finally {
    await chrome.close().catch(() => undefined)
    await session.app.close().catch(() => undefined)
    await sandbox.stop()
  }
}
