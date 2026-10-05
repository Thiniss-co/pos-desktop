import { t } from '../support/app.mjs'
import {
  openSandboxAndApp,
  payExactCash,
  refreshWorkstation,
  scan,
  setupPhysicalPresenceTill,
  sizeWindow
} from '../support/journey.mjs'
import { queryLocal } from '../support/localDb.mjs'

/**
 * Owner expansion Phase E, acceptance E-2 — register offers and the offline revocation journey, on a real
 * Electron app (isolated profile and keyring) against a disposable backend. Physical presence (uploads v7).
 *
 *  A. The owner has a live 10% offer on Water (labelled precondition: business time zone Asia/Riyadh, offer
 *     started an hour ago). A workstation refresh installs it with the catalog contract.
 *  B. Water is scanned: the cart line shows the offer and its total is 90% of the price. Sold online; the
 *     register keeps the offer on the line, uploads v7 with `offer_revision_uuid`, and the server invoice
 *     keeps the same offer and the same totals.
 *  C. OFFLINE: Water again — still offered (the installed contract decides). Sold offline.
 *  D. While the register is offline the owner ENDS the offer on the server.
 *  E. Back online: the offline sale uploads and is ACCEPTED with its offer (sold while the offer was issued
 *     to this register); one sync record; nothing is rejected.
 *  F. A refresh installs a contract without the offer: Water is full price again and shows no offer.
 */

const WATER = '6221000000028'

async function cartState(page) {
  return await page.evaluate(() => {
    const cart = document
      .querySelector('#app')
      .__vue_app__.config.globalProperties.$pinia._s.get('cart')
    return {
      lines: cart.lines.map((line) => ({
        name: line.product.name,
        price: line.product.price.amount,
        quantity: line.quantity,
        offer: cart.offerFor(line.id)?.revisionUuid ?? null
      })),
      grand: cart.calculation?.grandTotalAmount ?? null,
      discount: cart.calculation?.discountTotalAmount ?? null,
      error: cart.error
    }
  })
}

async function offerLabels(page) {
  return await page.locator('[data-testid="cart-line-offer"]').allInnerTexts()
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

function lastSale(profileDir) {
  const [invoice] = queryLocal(
    profileDir,
    `SELECT local_uuid, grand_total_amount, discount_total_amount, sold_while_offline
     FROM local_invoices ORDER BY created_at DESC LIMIT 1`
  )
  const items = queryLocal(
    profileDir,
    `SELECT product_name, discount_type, discount_value, discount_amount, total_amount, offer_revision_uuid, offer_name
     FROM local_invoice_items WHERE invoice_local_uuid = ? ORDER BY line_index`,
    [invoice.local_uuid]
  )
  const [queued] = queryLocal(
    profileDir,
    `SELECT payload_json, payload_hash, state, last_error_code
     FROM sync_queue WHERE aggregate_type = 'invoice' AND local_aggregate_uuid = ?`,
    [invoice.local_uuid]
  )
  return { invoice, items, queued, payload: JSON.parse(queued.payload_json) }
}

function queueRow(profileDir, uuid) {
  const [row] = queryLocal(
    profileDir,
    `SELECT payload_hash, state, last_error_code, attempt_count
     FROM sync_queue WHERE aggregate_type = 'invoice' AND local_aggregate_uuid = ?`,
    [uuid]
  )
  return row
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
  return sandbox.fixture('offer-report').invoices.find((row) => row.idempotency_key === uuid)
}

/** The register's offered sale equals the server's: v7, the same offer on the line, the same totals. */
function compareServer(label, local, server, offerUuid) {
  if (!server) throw new Error(`${label}: the server has no invoice ${local.invoice.local_uuid}`)
  const [line] = server.items
  if (server.contract_version !== 7) throw new Error(`${label}: server v${server.contract_version}`)
  if (server.sync_records !== 1) throw new Error(`${label}: ${server.sync_records} sync records`)
  if (line?.offer_snapshot?.id !== offerUuid)
    throw new Error(`${label}: server line offer ${JSON.stringify(line?.offer_snapshot)}`)
  if (
    server.grand !== local.invoice.grand_total_amount ||
    server.discount !== local.invoice.discount_total_amount ||
    Number(line.discount_amount) !== local.items[0].discount_amount
  )
    throw new Error(`${label}: totals differ ${JSON.stringify({ server, local: local.invoice })}`)
}

export async function run(ctx) {
  const session = await openSandboxAndApp(ctx, {
    flags: { POS_OFFLINE_PHYSICAL_PRESENCE_ENABLED: 'true', OFFERS_DESKTOP_ENABLED: 'true' },
    proxy: true
  })
  const { sandbox, proxy } = session
  const page = session.page
  try {
    await setupPhysicalPresenceTill(ctx, session)
    await sizeWindow(session, 1600, 900)

    // --- A. a live offer reaches the register with its catalog ----------------------------------
    const started = sandbox.fixture('offer-start', 'WATER-500')
    ctx.step('A: precondition — live 10% offer on Water (fixture)', started)
    await refreshWorkstation(ctx, page)
    const installed = queryLocal(
      session.profileDir,
      'SELECT revision_uuid, name, type, value FROM catalog_offers'
    )
    ctx.step('A: offers installed with the contract', { installed })
    if (installed.length !== 1 || installed[0].revision_uuid !== started.revision)
      throw new Error('A: the offer was not installed with the catalog')

    // --- B. offered sale online ---------------------------------------------------------------------
    await scan(ctx, page, WATER)
    const offered = await cartState(page)
    const labels = await offerLabels(page)
    await ctx.shot(page, 'B-offered-cart')
    ctx.step('B: cart with the offer', { offered, labels })
    if (
      offered.lines[0]?.offer !== started.revision ||
      offered.grand !== Math.round(offered.lines[0].price * 0.9) ||
      !labels[0]?.includes('Journey 10% off')
    )
      throw new Error('B: the cart does not show the offer')
    await payExactCash(ctx, page)
    await newSale(page)
    const sale1 = lastSale(session.profileDir)
    ctx.step('B: committed', {
      invoice: sale1.invoice,
      items: sale1.items,
      version: sale1.payload.client_contract_version
    })
    if (
      sale1.items[0].offer_revision_uuid !== started.revision ||
      sale1.payload.client_contract_version !== 7 ||
      sale1.payload.items[0].offer_revision_uuid !== started.revision ||
      sale1.invoice.grand_total_amount !== offered.grand
    )
      throw new Error('B: the committed sale does not carry the offer it was rung with')
    const server1 = (
      await waitFor('B: server invoice', async () => {
        const row = serverInvoice(sandbox, sale1.invoice.local_uuid)
        return { ok: Boolean(row), row }
      })
    ).row
    compareServer('B', sale1, server1, started.revision)
    ctx.step('B: server invoice', server1)

    // --- C. offline offered sale --------------------------------------------------------------------
    await online(session, false)
    await scan(ctx, page, WATER)
    const offline = await cartState(page)
    await ctx.shot(page, 'C-offline-offered-cart')
    if (offline.lines[0]?.offer !== started.revision)
      throw new Error('C: offline cart lost the offer')
    await payExactCash(ctx, page)
    await newSale(page)
    const sale2 = lastSale(session.profileDir)
    ctx.step('C: offline sale', { invoice: sale2.invoice, items: sale2.items })
    if (
      sale2.invoice.sold_while_offline !== 1 ||
      sale2.items[0].offer_revision_uuid !== started.revision
    )
      throw new Error('C: not an offline offered sale')

    // --- D. the owner ends the offer while the register is offline ----------------------------------
    const ended = sandbox.fixture('offer-end')
    ctx.step('D: owner ended the offer on the server', ended)
    if (ended.status !== 'ended' || !ended.revoked_at) throw new Error('D: the offer did not end')

    // --- E. back online: the offline sale is accepted with its offer -----------------------------
    await online(session, true)
    const synced = await waitFor(
      'E: offline sale synced',
      async () => {
        const row = queueRow(session.profileDir, sale2.invoice.local_uuid)
        return { ok: row.state === 'synced', row }
      },
      120_000,
      () => page.evaluate(() => window.posApi.sync.uploadNow())
    )
    ctx.step('E: upload after revocation', synced.row)
    if (synced.row.payload_hash !== sale2.queued.payload_hash)
      throw new Error('E: the uploaded payload is not the one frozen at sale time')
    const server2 = serverInvoice(sandbox, sale2.invoice.local_uuid)
    compareServer('E', sale2, server2, started.revision)
    ctx.step('E: server invoice for the offline sale', server2)

    // --- F. the next contract no longer carries the offer -------------------------------------------
    await refreshWorkstation(ctx, page)
    const after = queryLocal(session.profileDir, 'SELECT revision_uuid FROM catalog_offers')
    await scan(ctx, page, WATER)
    const plain = await cartState(page)
    await ctx.shot(page, 'F-after-revocation-cart')
    const report = sandbox.fixture('offer-report')
    ctx.step('F: after a refresh', {
      installed: after,
      cart: plain,
      labels: await offerLabels(page),
      contracts: report.contracts,
      revisions: report.revisions
    })
    if (
      after.length !== 0 ||
      plain.lines[0]?.offer !== null ||
      plain.grand !== plain.lines[0].price
    )
      throw new Error('F: the ended offer still applies')
    if (report.invoices.length !== 2)
      throw new Error(`F: ${report.invoices.length} server invoices`)
  } finally {
    await session.app.close().catch(() => undefined)
    await proxy?.stop().catch(() => undefined)
    await sandbox.stop()
  }
}
