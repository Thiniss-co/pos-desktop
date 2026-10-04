import { t } from '../support/app.mjs'
import {
  activate,
  attemptExactCash,
  deviceUuid as findDevice,
  openSandboxAndApp,
  openShift,
  payExactCash,
  refreshWorkstation,
  scan,
  signIn,
  sizeWindow,
  waitForRoute,
  waitForServerInvoices
} from '../support/journey.mjs'
import { queryLocal } from '../support/localDb.mjs'

const TOPUP = /stock-allocations\/top-up/

async function pinia(page, id, expression) {
  return await page.evaluate(
    ([storeId, expr]) =>
      new Function('s', `return (${expr})`)(
        document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get(storeId)
      ),
    [id, expression]
  )
}

async function goto(page, route) {
  await page.goto(page.url().replace(/#.*$/, `#/${route}`))
  await page.waitForTimeout(800)
}

function colaStock(sandbox) {
  const items = sandbox.fixture('stock', 'COLA-CAN').stock_items
  return items.reduce((sum, item) => sum + Number(item.quantity), 0)
}

function dispatches(session) {
  return queryLocal(
    session.profileDir,
    'SELECT attempt_key, state, send_count, request_hash FROM attempt_allocation_dispatches'
  )
}

async function refund(ctx, page, { returnToStock, shot }) {
  await page.getByRole('button', { name: await t(page, 'sales.refundItemsAction') }).click()
  const dialog = page.getByRole('dialog')
  await dialog.waitFor()
  await page.waitForTimeout(1500)
  ctx.step(`${shot}: refund dialog opened`, {
    text: (await dialog.innerText()).replace(/\s+/g, ' ').slice(0, 700)
  })
  await ctx.shot(page, `${shot}-opened`)
  await dialog
    .getByRole('button', { name: await t(page, 'refunds.increaseQuantity') })
    .first()
    .click()
  const checkbox = dialog.getByLabel(await t(page, 'refunds.stockReturned'))
  if ((await checkbox.isChecked()) !== returnToStock) await checkbox.click()
  await dialog.getByRole('button', { name: await t(page, 'refunds.previewAction') }).click()
  const confirmPrefix = (await t(page, 'refunds.confirmActionAmount', { amount: '\u0000' })).split(
    '\u0000'
  )[0]
  await dialog.getByRole('button', { name: new RegExp(`^${confirmPrefix}`) }).click()
  await dialog.getByText(await t(page, 'refunds.success')).waitFor({ timeout: 30_000 })
  await ctx.shot(page, shot)
  await dialog
    .getByRole('button', { name: await t(page, 'refunds.close') })
    .first()
    .click()
  await page.waitForTimeout(600)
}

/**
 * Stage 9 final live journeys:
 *
 *  T  (Rev 4 §14 transition) — allocation mode: a sale's reservation request reaches the server,
 *     which commits a grant, but the answer is lost (the proxy drops the response). The warehouse then
 *     becomes physical presence. Retry runs one license leg, receives the authority, and commits WITHOUT
 *     a new reservation request; the reconciler later re-sends the identical request and the grant is
 *     ingested once; one invoice, one movement.
 *  H2 (Rev 4 §16.8) — a POS draft exists; the header refresh is used from the Sales page: consent,
 *     install, and the POS cart comes back flagged for review with its line kept.
 *  P17/P18 — refunds of a physical-presence sale with and without stock return; limits enforced.
 */
export async function run(ctx) {
  const session = await openSandboxAndApp(ctx, {
    flags: { POS_OFFLINE_PHYSICAL_PRESENCE_ENABLED: 'true' },
    proxy: true
  })
  const { sandbox, proxy } = session
  const page = session.page
  try {
    await sizeWindow(session)
    await activate(ctx, page)
    await signIn(ctx, page)
    await waitForRoute(page, 'pos')
    const device = await findDevice(sandbox)
    sandbox.fixture('assign-device', device)
    ctx.step('allocation-mode warehouse', sandbox.fixture('mode-allocation', 'COLA-CAN'))
    await refreshWorkstation(ctx, page)
    await openShift(ctx, page)

    // T1. The reservation answer is lost after the server committed it.
    const stock0 = colaStock(sandbox)
    proxy.rule('lose top-up answer', TOPUP, { dropResponse: true, times: 1 })
    await scan(ctx, page, '6221000000011')
    const lost = await attemptExactCash(ctx, page)
    const serverAfterLoss = sandbox.fixture('allocations', device)
    ctx.step('T1: reservation committed server-side, answer lost', {
      outcome: lost.outcome,
      dispatches: dispatches(session),
      serverAllocations: serverAfterLoss.allocations.length,
      serverRequests: serverAfterLoss.requests
    })
    if (lost.outcome?.code !== 'allocation-acquisition-unresolved') {
      throw new Error(`expected allocation-acquisition-unresolved, got ${lost.outcome?.code}`)
    }
    if (serverAfterLoss.requests !== 1) throw new Error('the server should hold the request')
    const [recorded] = dispatches(session)
    await ctx.shot(page, 'T1-answer-lost')

    // T2. The warehouse becomes physical presence; Retry renews and commits with no new request.
    ctx.step('T2: policy → physical presence', sandbox.fixture('mode-physical-presence'))
    const topUpsBeforeRetry = proxy.requests(TOPUP).length
    await page
      .getByRole('dialog')
      .getByRole('button', { name: await t(page, 'pos.payment.completion.retry') })
      .click()
    await page.waitForFunction(
      () => {
        const s = document
          .querySelector('#app')
          .__vue_app__.config.globalProperties.$pinia._s.get('payment')
        return s && s.completionPending !== true && s.completionOutcome?.outcome === 'committed'
      },
      null,
      { timeout: 45_000 }
    )
    const invoice = queryLocal(
      session.profileDir,
      'SELECT local_uuid, stock_authorization_policy FROM local_invoices ORDER BY created_at DESC LIMIT 1'
    )[0]
    ctx.step('T2: retry committed under the new authority', {
      invoice,
      topUpsDuringRetry: proxy.requests(TOPUP).length - topUpsBeforeRetry
    })
    if (invoice.stock_authorization_policy !== 'physical_presence') {
      throw new Error('expected a physical-presence commit')
    }
    // The retry itself requests nothing new. After the commit the reconciler may replay the ONE
    // recorded request (same key, same bytes) — that is the lost answer being recovered.
    const afterRetry = dispatches(session)
    if (
      afterRetry.length !== 1 ||
      afterRetry[0].request_hash !== recorded.request_hash ||
      sandbox.fixture('allocations', device).requests !== 1
    ) {
      throw new Error('the retry must not create a new reservation request')
    }
    await ctx.shot(page, 'T2-committed-under-authority')
    // Acknowledge the completed sale ("New sale") so the next sale starts clean.
    await page
      .getByRole('dialog')
      .getByRole('button', { name: new RegExp(await t(page, 'pos.tender.newSale')) })
      .click()
    await page.waitForTimeout(2500)
    ctx.step('after New sale', {
      cartLines: await pinia(page, 'cart', 's.lines.length'),
      payment: await pinia(
        page,
        'payment',
        'JSON.parse(JSON.stringify({ outcome: s.completionOutcome, blocking: s.blockingAttemptKey, attemptKey: s.attemptKey, state: s.attemptState, error: s.completionError }))'
      ),
      dialogOpen: await page.getByRole('dialog').count()
    })
    await ctx.shot(page, 'T2b-after-new-sale')
    await page.waitForFunction(
      () =>
        document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('cart')
          .lines.length === 0,
      null,
      { timeout: 15_000 }
    )

    // T3. Upload + reconciliation: one invoice, one movement, the lost grant ingested once.
    await waitForServerInvoices(sandbox, device, 1)
    let rows = dispatches(session)
    for (let i = 0; i < 60 && rows[0]?.state !== 'granted'; i += 1) {
      await page.waitForTimeout(1000)
      rows = dispatches(session)
    }
    const report = sandbox.fixture('report', device)
    const serverFinal = sandbox.fixture('allocations', device)
    const localGrants = queryLocal(
      session.profileDir,
      'SELECT allocation_uuid FROM stock_allocation_grants'
    )
    ctx.step('T3: reconciled and uploaded', {
      dispatch: rows,
      server: report.invoices,
      serverAllocations: serverFinal.allocations,
      serverRequests: serverFinal.requests,
      localGrants: localGrants.length,
      colaDelta: colaStock(sandbox) - stock0
    })
    if (rows[0]?.state !== 'granted') throw new Error('the reconciler did not resolve the dispatch')
    if (serverFinal.requests !== 1) throw new Error('a duplicate reservation request was stored')
    if (rows[0].send_count !== 2 || rows[0].request_hash !== recorded.request_hash) {
      throw new Error('expected the original send plus one identical replay')
    }
    if (localGrants.length !== 1) throw new Error('the late grant must be ingested exactly once')
    const effects = Object.values(report.invoices)[0]
    if (effects.server_invoices !== 1 || effects.stock_movements !== 1) {
      throw new Error(`unexpected server effects ${JSON.stringify(effects)}`)
    }

    // H2. A POS draft, then the header refresh from the Sales page.
    await scan(ctx, page, '6221000000028')
    await goto(page, 'sales')
    await waitForRoute(page, 'sales')
    const revisionBefore = await pinia(page, 'catalog', 's.status?.contract?.revision ?? null')
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await page.locator('[data-testid="workstation-refresh"]:visible').first().click()
    const consent = page.getByRole('alertdialog')
    await consent.waitFor()
    await ctx.shot(page, 'H2-consent-on-sales-page')
    await consent
      .getByRole('button', { name: await t(page, 'shell.workstationRefresh.consentConfirm') })
      .click()
    await page.waitForFunction(
      () => {
        const s = document
          .querySelector('#app')
          .__vue_app__.config.globalProperties.$pinia._s.get('workstationRefresh')
        return s && s.status === 'idle' && s.lastMessage !== null
      },
      null,
      { timeout: 60_000 }
    )
    const h2Outcome = await pinia(page, 'workstationRefresh', 's.lastMessage')
    await goto(page, 'pos')
    await waitForRoute(page, 'pos')
    const cart = await pinia(
      page,
      'cart',
      '({ lines: s.lines.length, catalogChanged: s.catalogChanged, revision: s.contract?.revision ?? null })'
    )
    const revisionAfter = await pinia(page, 'catalog', 's.status?.contract?.revision ?? null')
    ctx.step('H2: refreshed from the Sales page with a POS draft', {
      outcome: h2Outcome,
      revisionChanged: revisionBefore !== revisionAfter,
      cart
    })
    if (h2Outcome !== 'installed' || cart.lines !== 1 || cart.catalogChanged !== true) {
      throw new Error('expected an install and a kept, review-flagged cart')
    }
    await ctx.shot(page, 'H2-pos-cart-needs-review')
    await pinia(page, 'cart', 's.resetDraft("cleared") || true')
    await page.waitForTimeout(400)

    // P17/P18. A 2-unit physical-presence sale, refunded 1 with and 1 without stock return.
    await scan(ctx, page, '2*6221000000011')
    await payExactCash(ctx, page)
    await page.keyboard.press('F9')
    await waitForServerInvoices(sandbox, device, 2)
    // The 2-unit sale, once its upload is recorded locally (refunds need the server invoice).
    const twoUnitSale = () =>
      queryLocal(
        session.profileDir,
        `SELECT i.local_uuid, i.sync_status FROM local_invoices i
           JOIN local_invoice_items it ON it.invoice_local_uuid = i.local_uuid
          WHERE it.quantity_milli = 2000`
      )[0]
    let sale = twoUnitSale()
    for (let i = 0; i < 30 && sale?.sync_status !== 'synced'; i += 1) {
      await page.waitForTimeout(1000)
      sale = twoUnitSale()
    }
    if (sale?.sync_status !== 'synced') throw new Error('the 2-unit sale did not sync')
    const beforeRefunds = colaStock(sandbox)
    await goto(page, `sales/${sale.local_uuid}`)
    await waitForRoute(page, 'sale-detail')
    await refund(ctx, page, { returnToStock: true, shot: 'P17-refund-with-stock-return' })
    const afterReturn = colaStock(sandbox)
    await refund(ctx, page, { returnToStock: false, shot: 'P18-refund-without-stock-return' })
    const afterNoReturn = colaStock(sandbox)
    await page.getByRole('button', { name: await t(page, 'sales.refundItemsAction') }).click()
    const limitDialog = page.getByRole('dialog')
    await limitDialog.waitFor()
    await page.waitForTimeout(1500)
    // Nothing is left: the quantity cannot be raised and the review cannot start.
    const limitShown =
      (await limitDialog
        .getByRole('button', { name: await t(page, 'refunds.increaseQuantity') })
        .first()
        .isDisabled()) &&
      (await limitDialog
        .getByRole('button', { name: await t(page, 'refunds.previewAction') })
        .isDisabled())
    await ctx.shot(page, 'P17-limit-nothing-left')
    ctx.step('P17/P18: refunds of a physical-presence sale', {
      beforeRefunds,
      afterReturn,
      afterNoReturn,
      limitShown
    })
    if (afterReturn !== beforeRefunds + 1) throw new Error('a stock-return refund must add 1')
    if (afterNoReturn !== afterReturn)
      throw new Error('a refund without return must not move stock')
    if (!limitShown) throw new Error('the refund limit was not enforced')
    await page.keyboard.press('Escape')
  } finally {
    await session.app.close().catch(() => undefined)
    await proxy?.stop()
    await sandbox.stop()
  }
}
