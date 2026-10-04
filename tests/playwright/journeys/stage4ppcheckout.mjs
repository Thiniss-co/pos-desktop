import {
  cardState,
  openSandboxAndApp,
  payExactCash,
  readiness,
  refreshWorkstation,
  relaunch,
  scan,
  setupPhysicalPresenceTill,
  waitForRoute,
  waitForServerInvoices
} from '../support/journey.mjs'
import { queryLocal } from '../support/localDb.mjs'

const TOPUP = /stock-allocations\/top-up/

async function sell(ctx, page, code, label) {
  await scan(ctx, page, code)
  try {
    await payExactCash(ctx, page)
  } catch (error) {
    await ctx.shot(page, `${label}-FAILURE`)
    ctx.step('cart at failure', {
      cart: await page.evaluate(() => {
        const s = document
          .querySelector('#app')
          .__vue_app__.config.globalProperties.$pinia._s.get('cart')
        return { lines: s?.lines?.length ?? null, result: document.body.innerText.slice(0, 600) }
      })
    })
    throw error
  }
  await ctx.shot(page, label)
  await page.keyboard.press('F9') // New sale
  await page.waitForTimeout(400)
}

function stockOf(sandbox, sku) {
  const items = sandbox.fixture('stock', sku).stock_items
  return items.length ? Number(items[0].quantity) : null
}

/**
 * Stage 4 (Rev 4 §5): with a valid physical-presence authority, scanner → exact-cash sales commit
 * regardless of recorded stock (positive, zero, negative, missing, insufficient), online and offline
 * (including a restart while offline), with no foreground top-up; the backend records every stock
 * effect exactly once. Also: a trackedness change after catalog issue (the G0 D1 symptom) no longer
 * blocks the sale.
 */
export async function run(ctx) {
  const session = await openSandboxAndApp(ctx, {
    flags: { POS_OFFLINE_PHYSICAL_PRESENCE_ENABLED: 'true' },
    proxy: true
  })
  const { sandbox, proxy } = session
  let page = session.page
  try {
    // Preconditions produced through the backend's own supported actions.
    ctx.step('WATER-500 recorded stock to 0', sandbox.fixture('adjust-stock', 'WATER-500:200'))
    ctx.step('owner product with no StockItem', sandbox.fixture('create-owner-product', 'PPNEW1'))
    const deviceUuid = await setupPhysicalPresenceTill(ctx, session)
    ctx.step('readiness', await readiness(page))

    // Online sales.
    await sell(ctx, page, '6221000000011', '01-positive-stock-online') // COLA 100
    await sell(ctx, page, '6221000000028', '02-zero-stock-online') // WATER 0
    await sell(ctx, page, '160*6221000000035', '03-insufficient-stock-online') // CHIPS 150 → −10
    await sell(ctx, page, '6221000000035', '04-negative-stock-online') // CHIPS −10 → −11
    await sell(ctx, page, 'OWNPPNEW1', '05-missing-stockitem-online') // no StockItem
    const topUps = proxy.requests(TOPUP).length
    ctx.step('foreground top-ups sent during PP sales', { topUps })
    if (topUps !== 0) throw new Error(`expected no foreground top-up under PP, saw ${topUps}`)
    await waitForServerInvoices(sandbox, deviceUuid, 5)

    // Offline: a zero-stock sale and a COLA sale rung while COLA is tracked in the issued catalog.
    await proxy.offline()
    await page.evaluate(async () => await window.posApi.connectivity.checkNow())
    await sell(ctx, page, '6221000000028', '06-zero-stock-offline')
    await sell(ctx, page, '6221000000011', '07-tracked-at-issue-offline')
    const pendingBefore = queryLocal(
      session.profileDir,
      "SELECT COUNT(*) AS n FROM sync_queue WHERE state != 'synced'"
    )[0].n
    ctx.step('offline sales durable locally', { pendingUploads: pendingBefore })
    // While the till is offline, the owner turns COLA tracking off (a supported product edit).
    ctx.step(
      'COLA tracking turned off server-side after the offline sale',
      sandbox.fixture('set-tracking', 'COLA-CAN:0')
    )
    await relaunch(ctx, session)
    page = session.page
    await waitForRoute(page, 'pos')
    const pendingAfterRestart = queryLocal(
      session.profileDir,
      "SELECT COUNT(*) AS n FROM sync_queue WHERE state != 'synced'"
    )[0].n
    ctx.step('after restart while offline', { pendingUploads: pendingAfterRestart })
    if (pendingAfterRestart !== pendingBefore)
      throw new Error('pending sales changed across restart')
    await ctx.shot(page, '08-after-restart-offline')
    await proxy.online()
    await page.evaluate(async () => await window.posApi.connectivity.checkNow())
    const report = await waitForServerInvoices(sandbox, deviceUuid, 7, 90_000)
    ctx.step('all sales uploaded', report)

    // P16: a sale rung AFTER the server-side product edit, under the older still-valid catalog, is
    // committed locally without any top-up and ACCEPTED at upload at the revision that catalog
    // issued. COLA was tracked when that catalog was issued, so the issued classification wins and
    // the sale decrements stock exactly once. The upload is held at the proxy so the identical
    // request can be delivered again (a byte-identical re-send, then the client's own retry).
    const p16Before = sandbox.fixture('stock-position', 'COLA-CAN')
    const p16InvoicesBefore = sandbox.fixture('report', deviceUuid).device_invoice_count
    const p16Hold = proxy.hold('hold-p16-upload', /^POST \/api\/v1\/desktop\/invoices\/upload/)
    await sell(ctx, page, '6221000000011', '09-sale-after-server-product-edit')
    await p16Hold.captured
    const p16First = await p16Hold.release()
    const p16AfterFirst = sandbox.fixture('stock-position', 'COLA-CAN')
    const p16Resent = await p16Hold.release()
    const p16AfterResend = sandbox.fixture('stock-position', 'COLA-CAN')
    let p16Local = null
    for (let waited = 0; waited < 120_000; waited += 2000) {
      p16Local = queryLocal(
        session.profileDir,
        'SELECT local_uuid, sync_status, last_sync_error FROM local_invoices ORDER BY created_at DESC LIMIT 1'
      )[0]
      if (p16Local.sync_status === 'synced') break
      await page.evaluate(async () => await window.posApi.connectivity.checkNow())
      await new Promise((r) => setTimeout(r, 2000))
    }
    const p16AfterClient = sandbox.fixture('stock-position', 'COLA-CAN')
    const p16Report = sandbox.fixture('report', deviceUuid)
    const p16Facts = {
      first: { status: p16First.status, invoice: JSON.parse(p16First.body ?? '{}').data?.id ?? null },
      resent: { status: p16Resent.status, invoice: JSON.parse(p16Resent.body ?? '{}').data?.id ?? null },
      local: p16Local,
      server: p16Report.invoices[p16Local.local_uuid] ?? null,
      deviceInvoices: { before: p16InvoicesBefore, after: p16Report.device_invoice_count },
      colaMovements: [p16Before.movements, p16AfterFirst.movements, p16AfterResend.movements, p16AfterClient.movements],
      journals: [p16Before.journals, p16AfterFirst.journals, p16AfterResend.journals, p16AfterClient.journals],
      topUps: proxy.requests(TOPUP).length
    }
    ctx.step('P16 sale after a server-side product edit: accepted once, replays write nothing', p16Facts)
    // Delivery order is not fixed: the client's own retry may reach the server before the held
    // original. Every delivery must answer success for the SAME invoice; at most one creates it.
    const deliveries = [p16First, p16Resent]
    if (
      deliveries.some((d) => d.status !== 200 && d.status !== 201) ||
      deliveries.filter((d) => d.status === 201).length > 1 ||
      p16Facts.first.invoice === null ||
      p16Facts.resent.invoice !== p16Facts.first.invoice
    )
      throw new Error(`P16 deliveries did not resolve to one accepted invoice: ${JSON.stringify(p16Facts)}`)
    if (p16Local.sync_status !== 'synced' || p16Local.last_sync_error !== null)
      throw new Error(`P16 sale not synced on the till: ${JSON.stringify(p16Local)}`)
    if (
      p16Facts.server?.sync_records !== 1 ||
      p16Facts.server?.server_invoices !== 1 ||
      p16Facts.server?.stock_movements !== 1 ||
      p16Facts.deviceInvoices.after !== p16Facts.deviceInvoices.before + 1
    )
      throw new Error(`P16 sale not recorded exactly once: ${JSON.stringify(p16Facts)}`)
    if (
      p16AfterFirst.movements !== p16Before.movements + 1 ||
      p16AfterResend.movements !== p16AfterFirst.movements ||
      p16AfterClient.movements !== p16AfterFirst.movements ||
      p16AfterResend.journals !== p16AfterFirst.journals ||
      p16AfterClient.journals !== p16AfterFirst.journals
    )
      throw new Error(`P16 replay wrote stock or accounting effects: ${JSON.stringify(p16Facts)}`)

    // Exactly-once and stock effects.
    for (const [local, facts] of Object.entries(sandbox.fixture('report', deviceUuid).invoices)) {
      if (facts.sync_records !== 1 || facts.server_invoices !== 1) {
        throw new Error(`invoice ${local} not exactly once: ${JSON.stringify(facts)}`)
      }
    }
    const movements = sandbox.fixture('movements', deviceUuid)
    ctx.step('server movements', movements)
    const stock = {
      'COLA-CAN': stockOf(sandbox, 'COLA-CAN'),
      'WATER-500': stockOf(sandbox, 'WATER-500'),
      'CHIPS-S': stockOf(sandbox, 'CHIPS-S'),
      PPNEW1: stockOf(sandbox, 'PPNEW1')
    }
    ctx.step('server stock after all sales', stock)
    // COLA: 100 − 1 (online) − 1 (offline, tracked at issue) − 1 (P16: sold after the edit under the
    // catalog that issued it as tracked) = 97. In each case the issued classification wins.
    const colaMovements = movements.movements.filter((m) => m.sku === 'COLA-CAN')
    const colaSold = colaMovements.reduce((sum, m) => sum + Number(m.quantity), 0)
    ctx.step('COLA-CAN movements', { count: colaMovements.length, sold: colaSold })
    if (colaMovements.length !== 3 || colaSold !== 3 || stock['COLA-CAN'] !== 100 - colaSold)
      throw new Error(`COLA-CAN movements do not explain its balance: ${JSON.stringify(colaMovements)}`)
    const expected = { 'COLA-CAN': 97, 'WATER-500': -2, 'CHIPS-S': -11, PPNEW1: -1 }
    for (const [sku, qty] of Object.entries(expected)) {
      if (stock[sku] !== qty) throw new Error(`${sku}: expected ${qty}, got ${stock[sku]}`)
    }
    // Exactly-once covers inventory effects too: the owner product sold with NO stock row and NO
    // opening stock has exactly one sale movement, one created position, and no opening adjustment.
    const ppNewMovements = movements.movements.filter((m) => m.sku === 'PPNEW1')
    const ppNewPosition = sandbox.fixture('stock-position', 'PPNEW1')
    ctx.step('PPNEW1 exactly-once inventory effects (no opening stock)', {
      movements: ppNewMovements.length,
      position: ppNewPosition
    })
    if (
      ppNewMovements.length !== 1 ||
      ppNewPosition.movements !== 1 ||
      ppNewPosition.opening_adjustments !== 0 ||
      ppNewPosition.position_events !== 1
    ) {
      throw new Error(
        `PPNEW1 inventory effects not exactly once: ${JSON.stringify({ ppNewMovements, ppNewPosition })}`
      )
    }
    const oversold = movements.movements.filter((m) => Number(m.is_oversold) === 1)
    ctx.step('oversold movements (uncovered PP units)', { count: oversold.length })
    ctx.step('card states now', {
      water: await cardState(page, 'Water Bottle'),
      chips: await cardState(page, 'Chips Small')
    })
    await refreshWorkstation(ctx, page)
    await ctx.shot(page, '09-after-refresh')
  } finally {
    ctx.facts.mainLogTail = session.logs
      .join('')
      .split('\n')
      .filter((l) => l.includes('top-up') || l.includes('invoices/upload') || l.includes('renewal'))
      .slice(-60)
    await session.app.close().catch(() => undefined)
    await proxy?.stop()
    await sandbox.stop()
  }
}
