import { lineRemoveAction, quickAction } from '../support/workspace.mjs'
import { t, virtualPrintDir } from '../support/app.mjs'
import {
  launchAgain,
  openSandboxAndApp,
  payExactCash,
  refreshWorkstation,
  scan,
  setupPhysicalPresenceTill,
  sizeWindow,
  waitForRoute
} from '../support/journey.mjs'
import { queryLocal } from '../support/localDb.mjs'
import { decodePdfQr, pdfFiles, pdfText } from './qc6receipts.mjs'

/**
 * Mixed-tax carts end to end — the regression journey for "Products with different tax modes cannot
 * share this cart" seen on a register whose backend could not issue a `per_line` catalog contract.
 * Physical presence (upload v5), ZATCA phase 1 receipts (the QR carries the grand and VAT totals).
 *
 * Products: WATER (no tax, tracked), COLA (exclusive 15%, tracked, legacy uncategorized tax),
 * INC (inclusive 15% standard), ZERO (exclusive 0% zero-rated), EXEMPT (inclusive 0% exempt).
 *
 *  L. A server whose issuance gate is OFF (`POS_MIXED_TAX_ISSUE_PER_LINE=false`) issues
 *     `single_invoice_mode`: the cart refuses the second mode with the compatibility explanation and
 *     nothing is sold. The gate is turned on (server restart) and a refresh installs `per_line`.
 *  A. Product-card clicks in one order build one mixed cart; +1 quantity, a removed line and a 10%
 *     invoice discount; the cart is HELD.
 *  B. Barcode entry in the REVERSE order, +1 quantity, a removed line; sold online (sale 1).
 *  C. The held cart is RECALLED unchanged (lines, discount, totals) and sold online (sale 2).
 *  D. OFFLINE (proxy refuses connections): a mixed sale (sale 3); the app restarts offline; the
 *     frozen payload survives byte for byte.
 *  E. Legacy parser: the server restarts with `POS_MIXED_TAX_PARSE_V4_V5=false`; the upload is refused
 *     with DESKTOP_CONTRACT_VERSION_UNSUPPORTED and stays queued, unchanged; nothing reaches the books.
 *  F. The parser is restored; the first upload's answer is LOST (held by the proxy, delivered to the
 *     server only after the register gave up), the register replays the same idempotency key: one
 *     invoice, one sync record, one set of stock movements and at most one journal.
 *  G. Every sale: server lines/totals equal the register's, the persisted totals equal the sum of
 *     the lines, and the printed receipt's QR carries exactly those grand/VAT totals and equals the
 *     stored snapshot on both sides; the printed VAT breakdown lists each category.
 */

const WATER = '6221000000028'
const COLA = '6221000000011'
const INC = '7780000000011'
const ZERO = '7780000000028'
const EXEMPT = '7780000000035'
const NAMES = {
  [WATER]: 'Water Bottle',
  [COLA]: 'Cola Can',
  [INC]: 'Qc4 Inclusive',
  [ZERO]: 'Qc4 Zero-rated',
  [EXEMPT]: 'Qc4 Exempt'
}
const UPLOAD = /^POST \/api\/v1\/desktop\/invoices\/upload/

async function cartState(page) {
  return await page.evaluate(() => {
    const cart = document
      .querySelector('#app')
      .__vue_app__.config.globalProperties.$pinia._s.get('cart')
    return {
      lines: cart.lines.map((line) => ({
        name: line.product.name,
        mode: line.product.tax.mode,
        rate: line.product.tax.rateBasisPoints,
        quantity: line.quantity
      })),
      discount: [cart.invoiceDiscountType, cart.invoiceDiscountValue],
      tax: cart.calculation?.taxTotalAmount ?? null,
      grand: cart.calculation?.grandTotalAmount ?? null,
      error: cart.error,
      held: cart.heldDrafts.length
    }
  })
}

/** The cart's own error (exact text); the scan feedback line keeps the last scan's result. */
async function refusalShown(page) {
  return (
    (await page
      .getByText(await t(page, 'pos.errors.CART_MIXED_TAX_MODE'), { exact: true })
      .count()) > 0
  )
}

async function clickProduct(ctx, page, code) {
  const name = (await t(page, 'pos.addToCart', { name: NAMES[code], price: '\u0000' })).split(
    '\u0000'
  )[0]
  await page
    .getByRole('button', { name: new RegExp(`^${escape(name)}`) })
    .first()
    .click()
  await page.waitForTimeout(300)
  ctx.step('clicked product card', { product: NAMES[code] })
}

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function lineButton(page, key, code) {
  // POS workspace: Remove lives in the line's menu (still named "Remove <name>").
  if (key === 'pos.cart.removeOf') return await lineRemoveAction(page, NAMES[code])
  return page.getByRole('button', { name: await t(page, key, { name: NAMES[code] }) })
}

async function applyPercentDiscount(ctx, page, percent) {
  await (await quickAction(page, 'discount')).click()
  await page.getByRole('radio', { name: await t(page, 'pos.discountPercentage') }).click()
  await page.getByLabel(await t(page, 'pos.discountPercent')).fill(String(percent))
  await page.getByRole('button', { name: await t(page, 'pos.applyDiscount') }).click()
  await page.waitForTimeout(300)
  ctx.step('invoice discount applied', { percent })
}

async function newSale(page) {
  await page
    .getByRole('dialog')
    .getByRole('button', { name: new RegExp(await t(page, 'pos.tender.newSale')) })
    .click()
  await page.waitForTimeout(500)
}

async function online(session, on) {
  if (on) await session.proxy.online()
  else await session.proxy.offline()
  await session.page.evaluate(async () => await window.posApi.connectivity.checkNow())
}

async function restartServer(ctx, sandbox, flags) {
  Object.assign(sandbox.env, flags)
  await sandbox.stop()
  await sandbox.start()
  ctx.step('disposable backend restarted', flags)
}

function lastInvoice(profileDir) {
  const [invoice] = queryLocal(
    profileDir,
    `SELECT local_uuid, tax_mode, subtotal_amount, discount_total_amount, tax_total_amount,
            grand_total_amount, sold_while_offline, upload_payload_version
     FROM local_invoices ORDER BY created_at DESC LIMIT 1`
  )
  return invoice
}

function localSale(profileDir, uuid) {
  const [invoice] = queryLocal(
    profileDir,
    `SELECT local_uuid, tax_mode, subtotal_amount, discount_total_amount, tax_total_amount,
            grand_total_amount, sold_while_offline
     FROM local_invoices WHERE local_uuid = ?`,
    [uuid]
  )
  const items = queryLocal(
    profileDir,
    `SELECT product_uuid, product_name, tax_mode, tax_category, tax_rate_basis_points, quantity_milli,
            subtotal_amount, discount_amount, tax_amount, total_amount
     FROM local_invoice_items WHERE invoice_local_uuid = ? ORDER BY line_index`,
    [uuid]
  )
  const [queued] = queryLocal(
    profileDir,
    `SELECT payload_json, payload_hash, idempotency_key, state, attempt_count, last_error_code
     FROM sync_queue WHERE aggregate_type = 'invoice' AND local_aggregate_uuid = ?`,
    [uuid]
  )
  const [snapshot] = queryLocal(
    profileDir,
    'SELECT qr_type, qr_payload, content_sha256 FROM local_invoice_receipt_snapshot WHERE invoice_local_uuid = ?',
    [uuid]
  )
  return { invoice, items, queued, snapshot }
}

/** Persisted totals are the sum of the persisted lines (no second calculation anywhere). */
function assertPersistedTotals(label, local) {
  const sum = (key) => local.items.reduce((total, item) => total + item[key], 0)
  const { invoice } = local
  if (sum('tax_amount') !== invoice.tax_total_amount)
    throw new Error(
      `${label}: line tax ${sum('tax_amount')} ≠ invoice tax ${invoice.tax_total_amount}`
    )
  if (sum('total_amount') !== invoice.grand_total_amount)
    throw new Error(
      `${label}: line totals ${sum('total_amount')} ≠ grand ${invoice.grand_total_amount}`
    )
  if (sum('discount_amount') !== invoice.discount_total_amount)
    throw new Error(`${label}: line discounts ≠ invoice discount`)
  const payload = JSON.parse(local.queued.payload_json)
  if (payload.client_contract_version !== 5 || invoice.tax_mode !== 'mixed')
    throw new Error(`${label}: expected a mixed header uploaded as v5`)
}

async function waitFor(label, probe, timeout = 90_000, tick = null) {
  const deadline = Date.now() + timeout
  let last = null
  while (Date.now() < deadline) {
    last = await probe()
    if (last.ok) return last
    if (tick) await tick()
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`${label}: ${JSON.stringify(last)}`)
}

function serverInvoice(sandbox, uuid) {
  return sandbox
    .fixture('mixed-tax-report')
    .invoices.find((invoice) => invoice.idempotency_key === uuid)
}

/** Server invoice equals the register's: header, version, every line, totals; side effects once. */
function compareServer(label, local, server) {
  if (!server)
    throw new Error(`${label}: the server has no invoice for ${local.invoice.local_uuid}`)
  if (server.tax_mode !== 'mixed' || server.contract_version !== 5)
    throw new Error(`${label}: server header ${server.tax_mode} v${server.contract_version}`)
  const pick = (line) => ({
    product_uuid: line.product_uuid,
    tax_mode: line.tax_mode,
    tax_category: line.tax_category ?? null,
    discount_amount: Number(line.discount_amount),
    tax_amount: Number(line.tax_amount),
    total_amount: Number(line.total_amount)
  })
  const a = JSON.stringify(local.items.map(pick))
  const b = JSON.stringify(server.items.map(pick))
  if (a !== b) throw new Error(`${label}: lines differ\nlocal  ${a}\nserver ${b}`)
  for (const [key, column] of [
    ['subtotal', 'subtotal_amount'],
    ['discount', 'discount_total_amount'],
    ['tax', 'tax_total_amount'],
    ['grand', 'grand_total_amount']
  ]) {
    if (server[key] !== local.invoice[column])
      throw new Error(`${label}: ${key} ${server[key]} ≠ local ${local.invoice[column]}`)
  }
  const tracked = local.items.filter((item) =>
    ['Water Bottle', 'Cola Can'].includes(item.product_name)
  )
  if (server.sync_records !== 1) throw new Error(`${label}: ${server.sync_records} sync records`)
  if (server.stock_movements !== tracked.length)
    throw new Error(
      `${label}: ${server.stock_movements} stock movements for ${tracked.length} tracked lines`
    )
  if (server.accounting_journals > 1)
    throw new Error(`${label}: ${server.accounting_journals} accounting journals`)
}

/** ZATCA phase 1 TLV (tags 1–5), decoded independently of the app. */
function decodeZatca(payload) {
  const bytes = Buffer.from(payload, 'base64')
  const values = []
  let offset = 0
  for (let tag = 1; tag <= 5; tag += 1) {
    if (bytes[offset] !== tag) return null
    const length = bytes[offset + 1]
    values.push(bytes.subarray(offset + 2, offset + 2 + length).toString('utf8'))
    offset += 2 + length
  }
  const [sellerName, vatNumber, timestamp, total, vatTotal] = values
  return { sellerName, vatNumber, timestamp, total, vatTotal }
}

async function printSale(ctx, session, uuid, label) {
  const before = pdfFiles(session.profileDir).length
  const job = await session.page.evaluate(async (invoiceLocalUuid) => {
    const document = { kind: 'sale', invoiceLocalUuid }
    const preview = await window.posApi.printing.preview({ document, locale: 'en', overrides: {} })
    if (!preview.ok) return { stage: 'preview', error: preview.error }
    const dispatched = await window.posApi.printing.dispatch({
      requestId: crypto.randomUUID(),
      document,
      locale: 'en',
      overrides: {},
      preview: {
        previewDocumentSha256: preview.data.previewDocumentSha256,
        previewOptionsSha256: preview.data.previewOptionsSha256
      }
    })
    return dispatched.ok ? dispatched.data : { stage: 'dispatch', error: dispatched.error }
  }, uuid)
  if (job?.status !== 'submitted') throw new Error(`${label}: print ${JSON.stringify(job)}`)
  let files = pdfFiles(session.profileDir)
  for (let i = 0; i < 50 && files.length === before; i += 1) {
    await session.page.waitForTimeout(200)
    files = pdfFiles(session.profileDir)
  }
  const pdf = files.at(-1)
  return { pdf, qr: decodePdfQr(pdf), text: pdfText(pdf) }
}

/** The printed QR = the frozen local snapshot = the server's stored and recomputed QR, over these totals. */
async function assertReceipt(ctx, session, device, label, local, server) {
  const printed = await printSale(ctx, session, local.invoice.local_uuid, label)
  const decoded = printed.qr ? decodeZatca(printed.qr) : null
  const money = (minor) => (minor / 100).toFixed(2)
  const stored = session.sandbox
    .fixture('receipt-snapshots', device)
    .snapshots.find((row) => row.local_invoice_uuid === local.invoice.local_uuid)
  const breakdown = ['Standard', 'Zero-rated', 'Exempt'].filter((word) =>
    printed.text.toLowerCase().includes(word.toLowerCase())
  )
  ctx.step(`${label}: receipt`, {
    pdf: printed.pdf.split('/').at(-1),
    qrTotals: decoded && { total: decoded.total, vat: decoded.vatTotal },
    invoiceTotals: { grand: money(server.grand), tax: money(server.tax) },
    breakdownCategories: breakdown,
    serverSnapshotMatches: stored?.qr_payload === local.snapshot?.qr_payload,
    serverRecomputedMatches: stored?.qr_payload === stored?.expected_qr
  })
  if (!decoded || local.snapshot?.qr_type !== 'zatca-p1')
    throw new Error(`${label}: no ZATCA QR on the printed receipt`)
  if (printed.qr !== local.snapshot.qr_payload)
    throw new Error(`${label}: printed QR differs from the frozen snapshot`)
  if (decoded.total !== money(server.grand) || decoded.vatTotal !== money(server.tax))
    throw new Error(`${label}: QR totals ${decoded.total}/${decoded.vatTotal} ≠ invoice`)
  if (!stored || stored.qr_payload !== printed.qr || stored.expected_qr !== printed.qr)
    throw new Error(`${label}: server receipt snapshot QR differs`)
  if (!printed.text.includes(money(server.tax)))
    throw new Error(`${label}: printed receipt does not show the VAT total ${money(server.tax)}`)
  return breakdown
}

export async function run(ctx) {
  const session = await openSandboxAndApp(ctx, {
    flags: { POS_OFFLINE_PHYSICAL_PRESENCE_ENABLED: 'true', POS_MIXED_TAX_ISSUE_PER_LINE: 'false' },
    proxy: true
  })
  const { sandbox, proxy } = session
  let page = session.page
  try {
    const device = await setupPhysicalPresenceTill(ctx, session)
    await sizeWindow(session, 1600, 900)
    ctx.step('precondition: mixed-tax products (fixture)', sandbox.fixture('mixed-tax-catalog'))
    ctx.step('precondition: ZATCA phase 1 identity (fixture)', sandbox.fixture('fiscal-zatca'))
    await refreshWorkstation(ctx, page)

    // --- L. legacy issuance: single_invoice_mode ------------------------------------------------
    const [legacy] = queryLocal(
      session.profileDir,
      'SELECT mixed_tax_mode_policy FROM catalog_metadata'
    )
    ctx.step('L: installed contract with the issuance gate off', legacy)
    if (legacy.mixed_tax_mode_policy !== 'single_invoice_mode')
      throw new Error('L: expected a single_invoice_mode contract')
    await scan(ctx, page, INC)
    const input = page.getByLabel(await t(page, 'pos.quickSale.scanLabel'))
    await input.click()
    await page.keyboard.type(COLA, { delay: 5 })
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1200)
    const refused = await cartState(page)
    const shown = await refusalShown(page)
    await ctx.shot(page, 'L-legacy-refusal')
    ctx.step('L: second tax mode refused', { shown, cart: refused })
    if (!shown || refused.lines.length !== 1)
      throw new Error('L: the legacy catalog did not refuse the second mode with the explanation')
    await (await lineButton(page, 'pos.cart.removeOf', INC)).click()

    await restartServer(ctx, sandbox, { POS_MIXED_TAX_ISSUE_PER_LINE: 'true' })
    // The first request after a sandbox restart can meet a socket of the stopped server (harness
    // artifact, answered as a transient failure); the cashier's next refresh is what counts.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if ((await refreshWorkstation(ctx, page)) === 'installed') break
      await page.waitForTimeout(3000)
    }
    const [metadata] = queryLocal(
      session.profileDir,
      'SELECT mixed_tax_mode_policy FROM catalog_metadata'
    )
    const categories = queryLocal(
      session.profileDir,
      "SELECT sku, tax_mode, tax_rate_basis_points AS rate, tax_category FROM catalog_products WHERE sku IN ('WATER-500','COLA-CAN','MIX-INC','MIX-ZERO','MIX-EXEMPT') ORDER BY sku"
    )
    ctx.step('L: contract after the gate is on', {
      policy: metadata.mixed_tax_mode_policy,
      categories
    })
    if (metadata.mixed_tax_mode_policy !== 'per_line') throw new Error('L: not per_line')

    // --- A. product cards, forward order; quantity, removal, discount; hold -------------------------
    for (const code of [WATER, COLA, INC, ZERO, EXEMPT]) await clickProduct(ctx, page, code)
    const forward = await cartState(page)
    ctx.step('A: card order cart', forward)
    if (forward.lines.length !== 5 || forward.error || (await refusalShown(page)))
      throw new Error('A: the mixed cart was refused')
    await (await lineButton(page, 'pos.cart.increaseOf', COLA)).click()
    await (await lineButton(page, 'pos.cart.removeOf', EXEMPT)).click()
    await applyPercentDiscount(ctx, page, 10)
    const beforeHold = await cartState(page)
    await ctx.shot(page, 'A-mixed-cart-before-hold')
    ctx.step('A: after +1 Cola, removed Exempt, 10% discount', beforeHold)
    if (
      beforeHold.lines.length !== 4 ||
      beforeHold.error ||
      beforeHold.discount[0] !== 'percentage'
    )
      throw new Error('A: cart edits failed')
    await (await quickAction(page, 'hold')).click()
    await page.waitForTimeout(400)
    const afterHold = await cartState(page)
    if (afterHold.lines.length !== 0 || afterHold.held !== 1) throw new Error('A: hold failed')

    // --- B. barcode, reverse order; quantity, removal; sale 1 online ------------------------------
    for (const code of [EXEMPT, ZERO, INC, COLA, WATER]) await scan(ctx, page, code)
    const reverse = await cartState(page)
    ctx.step('B: reverse barcode cart', reverse)
    if (reverse.lines.length !== 5 || reverse.error) throw new Error('B: reverse cart refused')
    await (await lineButton(page, 'pos.cart.increaseOf', ZERO)).click()
    await (await lineButton(page, 'pos.cart.removeOf', WATER)).click()
    const sale1Cart = await cartState(page)
    await ctx.shot(page, 'B-reverse-cart')
    ctx.step('B: after +1 Zero, removed Water', sale1Cart)
    await payExactCash(ctx, page)
    await newSale(page)
    const sale1 = localSale(session.profileDir, lastInvoice(session.profileDir).local_uuid)
    assertPersistedTotals('B', sale1)
    if (
      sale1.invoice.grand_total_amount !== sale1Cart.grand ||
      sale1.invoice.tax_total_amount !== sale1Cart.tax
    )
      throw new Error('B: persisted totals differ from the cart the cashier saw')
    const server1 = (
      await waitFor('B: server invoice', async () => {
        const row = serverInvoice(sandbox, sale1.invoice.local_uuid)
        return { ok: Boolean(row), row }
      })
    ).row
    compareServer('B', sale1, server1)
    ctx.step('B: sale 1 accepted', { local: sale1.invoice, items: sale1.items, server: server1 })

    // --- C. recall the held cart; sale 2 online ---------------------------------------------------
    await (await quickAction(page, 'recall')).click()
    await page
      .getByRole('dialog')
      .getByRole('button', { name: await t(page, 'pos.quickSale.recall') })
      .first()
      .click()
    await page.waitForTimeout(400)
    const recalled = await cartState(page)
    await ctx.shot(page, 'C-recalled-cart')
    ctx.step('C: recalled cart', recalled)
    if (
      JSON.stringify(recalled.lines) !== JSON.stringify(beforeHold.lines) ||
      JSON.stringify(recalled.discount) !== JSON.stringify(beforeHold.discount) ||
      recalled.grand !== beforeHold.grand ||
      recalled.tax !== beforeHold.tax ||
      recalled.error
    )
      throw new Error('C: the recalled cart differs from the held one')
    await payExactCash(ctx, page)
    await newSale(page)
    const sale2 = localSale(session.profileDir, lastInvoice(session.profileDir).local_uuid)
    assertPersistedTotals('C', sale2)
    if (sale2.invoice.discount_total_amount === 0) throw new Error('C: the discount was lost')
    const server2 = (
      await waitFor('C: server invoice', async () => {
        const row = serverInvoice(sandbox, sale2.invoice.local_uuid)
        return { ok: Boolean(row), row }
      })
    ).row
    compareServer('C', sale2, server2)
    ctx.step('C: sale 2 accepted', { local: sale2.invoice, items: sale2.items, server: server2 })

    // --- D. offline mixed sale, restart offline ---------------------------------------------------
    await online(session, false)
    for (const code of [INC, WATER, ZERO, COLA]) await scan(ctx, page, code)
    await ctx.shot(page, 'D-offline-cart')
    await payExactCash(ctx, page)
    await newSale(page)
    const sale3 = localSale(session.profileDir, lastInvoice(session.profileDir).local_uuid)
    assertPersistedTotals('D', sale3)
    if (sale3.invoice.sold_while_offline !== 1)
      throw new Error('D: not recorded as an offline sale')
    ctx.step('D: offline sale 3', {
      invoice: sale3.invoice,
      queue: { ...sale3.queued, payload_json: undefined }
    })

    await session.app.close()
    await launchAgain(ctx, session)
    page = session.page
    await sizeWindow(session, 1600, 900)
    await waitForRoute(page, 'pos')
    const restarted = localSale(session.profileDir, sale3.invoice.local_uuid)
    ctx.step('D: after an offline restart', {
      queue: { ...restarted.queued, payload_json: undefined }
    })
    if (
      restarted.queued.payload_hash !== sale3.queued.payload_hash ||
      restarted.queued.state === 'synced'
    )
      throw new Error('D: the queued payload changed across the restart')

    // --- E. legacy parser: refused, retryable, unchanged ------------------------------------------
    await restartServer(ctx, sandbox, { POS_MIXED_TAX_PARSE_V4_V5: 'false' })
    await online(session, true)
    const refusedUpload = await waitFor(
      'E: upload refused by a server without v4/v5',
      async () => {
        const row = localSale(session.profileDir, sale3.invoice.local_uuid).queued
        return {
          ok: row.last_error_code === 'DESKTOP_CONTRACT_VERSION_UNSUPPORTED',
          row: { ...row, payload_json: undefined }
        }
      },
      90_000,
      () => page.evaluate(() => window.posApi.sync.uploadNow())
    )
    ctx.step('E: legacy server refused the v5 upload', refusedUpload.row)
    if (
      refusedUpload.row.state === 'rejected' ||
      refusedUpload.row.payload_hash !== sale3.queued.payload_hash
    )
      throw new Error('E: the sale was terminally rejected or its payload changed')
    if (serverInvoice(sandbox, sale3.invoice.local_uuid))
      throw new Error('E: the legacy server stored it')

    // --- F. restored parser; the first answer is lost; the replay does not duplicate ---------------
    await restartServer(ctx, sandbox, { POS_MIXED_TAX_PARSE_V4_V5: 'true' })
    const lost = proxy.hold('lost-upload', UPLOAD)
    const uploadsBefore = proxy.requests(UPLOAD).length
    let captured = false
    void lost.captured.then(() => (captured = true))
    await waitFor(
      'F: upload attempted',
      async () => ({ ok: captured }),
      120_000,
      () => page.evaluate(() => window.posApi.sync.uploadNow())
    )
    const committed = await lost.release()
    ctx.step('F: held upload delivered after the register saw a dropped connection', {
      status: committed?.status ?? null
    })
    await waitFor(
      'F: replay synced',
      async () => {
        const row = localSale(session.profileDir, sale3.invoice.local_uuid).queued
        return { ok: row.state === 'synced', row: { ...row, payload_json: undefined } }
      },
      120_000,
      () => page.evaluate(() => window.posApi.sync.uploadNow())
    )
    const synced = localSale(session.profileDir, sale3.invoice.local_uuid)
    const server3 = serverInvoice(sandbox, sale3.invoice.local_uuid)
    compareServer('F', synced, server3)
    const report = sandbox.fixture('mixed-tax-report')
    ctx.step('F: sale 3 after the replay', {
      uploadRequestsSinceRestore: proxy.requests(UPLOAD).length - uploadsBefore,
      queue: { ...synced.queued, payload_json: undefined },
      server: server3,
      serverInvoiceCount: report.invoices.length,
      contracts: report.contracts
    })
    if (report.invoices.length !== 3)
      throw new Error(`F: ${report.invoices.length} server invoices`)
    if (synced.queued.payload_hash !== sale3.queued.payload_hash)
      throw new Error('F: the uploaded payload is not the one frozen at sale time')

    // --- G. receipts: QR and VAT breakdown over the same totals ------------------------------------
    for (const [label, local, server] of [
      ['G sale 1', sale1, server1],
      ['G sale 2', sale2, server2],
      ['G sale 3', synced, server3]
    ]) {
      const fresh = localSale(session.profileDir, local.invoice.local_uuid)
      await assertReceipt(ctx, session, device, label, fresh, server)
    }
    ctx.step('G: virtual printer output', { dir: virtualPrintDir(session.profileDir) })
    await ctx.shot(page, 'G-final')
  } finally {
    await session.app.close().catch(() => undefined)
    await proxy?.stop().catch(() => undefined)
    await sandbox.stop()
  }
}
