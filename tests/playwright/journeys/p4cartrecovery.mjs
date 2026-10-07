import {
  openSandboxAndApp,
  payExactCash,
  scan,
  setupPhysicalPresenceTill,
  waitForServerInvoices
} from '../support/journey.mjs'
import { t } from '../support/app.mjs'
import { queryLocal } from '../support/localDb.mjs'

/**
 * Platform Phase 4 closeout — a draft cart whose sale was refused while the subscription had lapsed is recovered and
 * paid, as a cashier would do it, after the platform reactivates the subscription.
 *
 * 1. A physical-presence till sells once (baseline), then builds a draft (WATER).
 * 2. The company's paid period and grace end (labelled precondition). The cashier refreshes (consenting to review the
 *    cart) and presses exact cash: the till's own access decision refuses (`access-denied`, the access reason shown),
 *    nothing is claimed or committed, and nothing about the draft is protected. Escape dismisses the dialog and its
 *    stale message; Clear cart opens its confirmation on that draft and Escape/Cancel keeps it (EN and AR).
 * 3. The platform approves, records the exact payment and activates a same-plan request (production actions).
 * 4. The cashier refreshes again (consent, then the normal catalog review/rebuild of the kept draft) and presses exact
 *    cash twice in a row on THE SAME cart: exactly one sale is committed and uploaded once.
 * 5. Clear cart from the More menu on a new draft: Cancel keeps it, Clear empties only that draft; completed sales and
 *    their upload records are untouched.
 */

const COLA = '6221000000011'
const WATER = '6221000000028'

const store = (page, id, expression) =>
  page.evaluate(
    ([storeId, expr]) =>
      new Function('s', `return (${expr})`)(
        document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get(storeId)
      ),
    [id, expression]
  )

const cartState = (page) =>
  store(
    page,
    'cart',
    '({ lines: s.lines.map((l) => [l.product?.sku ?? l.productUuid ?? "", String(l.quantity)]), catalogChanged: s.catalogChanged })'
  )

const paymentState = (page) =>
  store(
    page,
    'payment',
    '({ attemptKey: s.attemptKey, attemptState: s.attemptState, protected: s.attemptProtected, pending: s.completionPending, rows: s.rows.length, outcome: s.completionOutcome ? JSON.parse(JSON.stringify(s.completionOutcome)) : null, blocking: s.blockingAttemptKey })'
  )

function localCounts(session) {
  const one = (sql) => queryLocal(session.profileDir, sql)[0].n
  return {
    invoices: one('SELECT COUNT(*) AS n FROM local_invoices'),
    attempts: one('SELECT COUNT(*) AS n FROM sale_attempts'),
    claimed: one("SELECT COUNT(*) AS n FROM sale_attempts WHERE state = 'claimed'"),
    invoiceQueue: one("SELECT COUNT(*) AS n FROM sync_queue WHERE aggregate_type = 'invoice'")
  }
}

async function setLocale(page, locale) {
  await store(page, 'locale', `s.setLocale('${locale}')`)
  await page.waitForTimeout(400)
}

/** The header refresh as a cashier uses it, answering the "Refresh and review" consent like a person would. */
async function refreshWithConsent(ctx, page, label) {
  await store(page, 'workstationRefresh', 's.dismissMessage() || true')
  await page.locator('[data-testid="workstation-refresh"]:visible').first().click()
  const consent = await t(page, 'shell.workstationRefresh.consentConfirm')
  const updating = await t(page, 'shell.workstationRefresh.updating')
  const deadline = Date.now() + 90_000
  let consented = false
  for (;;) {
    const state = await store(
      page,
      'workstationRefresh',
      '({ status: s.status, lastMessage: s.lastMessage })'
    )
    if (state.status === 'confirming' && !consented) {
      await ctx.shot(page, `${label}-consent`)
      await page.getByRole('button', { name: consent }).click()
      consented = true
    } else if (state.status === 'idle' && state.lastMessage !== null) {
      await page.waitForFunction((text) => !document.body.innerText.includes(text), updating, {
        timeout: 90_000
      })
      ctx.step(`${label}: workstation refresh`, { outcome: state.lastMessage, consented })
      return state.lastMessage
    }
    if (Date.now() > deadline) throw new Error(`refresh did not settle: ${JSON.stringify(state)}`)
    await page.waitForTimeout(250)
  }
}

/** The normal review of a kept draft after a catalog install: the banner's "Rebuild cart", then the dialog's. */
async function reviewAndRebuild(ctx, page, label) {
  const cart = await cartState(page)
  if (!cart.catalogChanged) {
    ctx.step(`${label}: no catalog review needed`, { cart })
    return false
  }
  await page
    .getByRole('button', { name: await t(page, 'pos.rebuildCart') })
    .first()
    .click()
  const dialog = page.getByRole('dialog').filter({ hasText: await t(page, 'pos.dialog.rebuild') })
  await dialog.waitFor({ timeout: 15_000 })
  await ctx.shot(page, `${label}-rebuild-review`)
  await dialog.getByRole('button', { name: await t(page, 'pos.rebuildCart') }).click()
  await page.waitForFunction(
    () =>
      document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('cart')
        .catalogChanged === false,
    null,
    { timeout: 15_000 }
  )
  ctx.step(`${label}: draft reviewed and rebuilt`, { cart: await cartState(page) })
  return true
}

/** Observation only: records every `payment.complete` call and the state the page sees when it settles. */
async function watchCompletions(page) {
  await page.evaluate(() => {
    const s = document
      .querySelector('#app')
      .__vue_app__.config.globalProperties.$pinia._s.get('payment')
    if (window.__pwCompletions) return
    window.__pwCompletions = []
    s.$onAction(({ name, after }) => {
      if (name !== 'complete') return
      const entry = { settled: false, outcome: null }
      window.__pwCompletions.push(entry)
      after(() => {
        entry.settled = true
        entry.outcome = s.completionOutcome ? JSON.parse(JSON.stringify(s.completionOutcome)) : null
        entry.protectedAtSettle = s.attemptProtected
        entry.attemptStateAtSettle = s.attemptState
      })
    })
  })
}

const completions = (page) => page.evaluate(() => window.__pwCompletions ?? [])

/** F9 opens payment; Shift+F9 is exact cash (pressed `presses` times in a row). Waits for the result. */
async function payWithExactCash(ctx, page, label, presses = 1) {
  const before = (await completions(page)).length
  await page.keyboard.press('F9')
  await page.getByRole('dialog').waitFor({ timeout: 15_000 })
  await page.waitForTimeout(400)
  for (let i = 0; i < presses; i += 1) await page.keyboard.press('Shift+F9')
  const deadline = Date.now() + 45_000
  for (;;) {
    const list = (await completions(page)).slice(before)
    if (list.length > 0 && list.every((entry) => entry.settled)) {
      await page.waitForTimeout(500)
      const dialog = (await page.getByRole('dialog').innerText()).replace(/\s+/g, ' ')
      const first = list[0]
      ctx.step(`${label}: settled`, {
        calls: list.length,
        outcome: first.outcome?.outcome,
        code: first.outcome?.code ?? null,
        attemptKey: first.outcome?.attemptKey ?? null,
        protectedAtSettle: first.protectedAtSettle,
        attemptStateAtSettle: first.attemptStateAtSettle,
        dialog: dialog.slice(0, 300)
      })
      return { outcome: first.outcome, protectedAtSettle: first.protectedAtSettle, dialog }
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${label}: exact cash submitted nothing: ${JSON.stringify(await paymentState(page))}`
      )
    }
    await page.waitForTimeout(100)
  }
}

async function openClearFromMore(page) {
  await page.locator('[data-action="more"]:visible').first().click()
  const item = page.locator('[role="menuitem"][data-action="clear"]:visible').first()
  await item.waitFor({ timeout: 5_000 })
  const disabled = await item.evaluate(
    (el) => el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled')
  )
  if (disabled) {
    await page.keyboard.press('Escape')
    return { opened: false }
  }
  await item.click()
  const title = await t(page, 'pos.clearDialog.title')
  const dialog = page
    .getByRole('alertdialog')
    .or(page.getByRole('dialog'))
    .filter({ hasText: title })
  await dialog.waitFor({ timeout: 5_000 })
  await page.waitForTimeout(200)
  // Keyboard: focus moved into the confirmation.
  const focusInside = await page.evaluate(
    () => document.activeElement?.closest('[role="dialog"],[role="alertdialog"]') !== null
  )
  return { opened: true, dialog, focusInside }
}

export async function run(ctx) {
  const session = await openSandboxAndApp(ctx, {
    flags: { POS_OFFLINE_PHYSICAL_PRESENCE_ENABLED: 'true' }
  })
  const { sandbox, page } = session
  try {
    const deviceUuid = await setupPhysicalPresenceTill(ctx, session)
    await watchCompletions(page)

    // 1. Baseline sale, then the draft that will be refused.
    await scan(ctx, page, COLA)
    await payExactCash(ctx, page)
    await page.keyboard.press('F9')
    await page.waitForTimeout(400)
    await waitForServerInvoices(sandbox, deviceUuid, 1)
    await scan(ctx, page, WATER)
    const draft = await cartState(page)
    ctx.step('draft built while access is valid', { cart: draft, local: localCounts(session) })
    await ctx.shot(page, '01-draft')

    // 2. Lapse, refresh, refused exact cash.
    ctx.step('period ended, grace passed', sandbox.fixture('subscription-lapse'))
    await refreshWithConsent(ctx, page, '02-lapsed-refresh')
    const refused = await payWithExactCash(ctx, page, 'lapsed exact cash')
    await ctx.shot(page, '03-refused-en')
    const accessMessage = await t(page, 'pos.payment.completion.failed.access-denied')
    const contextMessage = await t(page, 'pos.payment.completion.failed.context-changed')
    if (refused.outcome?.outcome !== 'failed' || refused.outcome.code !== 'access-denied')
      throw new Error(`expected an access-denied refusal: ${JSON.stringify(refused.outcome)}`)
    if (refused.outcome.attemptKey !== null) throw new Error('the refusal claimed an attempt')
    if (refused.protectedAtSettle !== false)
      throw new Error('the refused draft was protected although nothing was claimed')
    if (!refused.dialog.includes(accessMessage) || refused.dialog.includes(contextMessage))
      throw new Error('the refusal does not explain itself as an access refusal')
    const afterRefusal = localCounts(session)
    if (afterRefusal.invoices !== 1 || afterRefusal.claimed !== 0)
      throw new Error(`the refusal wrote something: ${JSON.stringify(afterRefusal)}`)
    await setLocale(page, 'ar')
    await ctx.shot(page, '03-refused-ar')
    await setLocale(page, 'en')

    // Escape dismisses the dialog and its message; the draft and its exact-cash row stay.
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
    const dismissed = await paymentState(page)
    ctx.step('after Escape on the refused payment', {
      payment: dismissed,
      cart: await cartState(page)
    })
    if ((await page.getByRole('dialog').count()) !== 0)
      throw new Error('Escape left the dialog open')
    if (dismissed.outcome !== null || dismissed.protected)
      throw new Error('the dismissed refusal left stale state on the draft')
    await ctx.shot(page, '04-refused-dismissed')

    // Clear cart on the refused draft: the confirmation opens with focus inside; Escape and Cancel keep the draft.
    for (const locale of ['en', 'ar']) {
      await setLocale(page, locale)
      const clear = await openClearFromMore(page)
      ctx.step(`Clear cart on the refused draft (${locale})`, {
        opened: clear.opened,
        focusInside: clear.focusInside
      })
      if (!clear.opened) throw new Error('Clear cart did not open for the refused draft')
      if (!clear.focusInside) throw new Error('the Clear confirmation does not hold keyboard focus')
      await ctx.shot(page, `04b-refused-draft-clear-confirmation-${locale}`)
      if (locale === 'en') {
        await page.keyboard.press('Escape')
      } else {
        await clear.dialog.getByRole('button', { name: await t(page, 'common.cancel') }).click()
      }
      await page.waitForTimeout(300)
      if (JSON.stringify((await cartState(page)).lines) !== JSON.stringify(draft.lines))
        throw new Error('dismissing Clear changed the refused draft')
    }
    await setLocale(page, 'en')

    // 3. Reactivation through the production platform actions.
    const started = sandbox.fixture('subscription-request')
    ctx.step('request approved, paid and activated', started)
    if (!started.activated || started.outcome !== 'started')
      throw new Error(`expected an activation starting now: ${JSON.stringify(started)}`)

    // 4. Refresh as a cashier would, review the kept draft, pay the same cart with exact cash (pressed twice).
    await refreshWithConsent(ctx, page, '05-reactivated-refresh')
    await ctx.shot(page, '06-after-reactivation')
    await reviewAndRebuild(ctx, page, '07')
    const sameCart = await cartState(page)
    if (JSON.stringify(sameCart.lines) !== JSON.stringify(draft.lines))
      throw new Error(`the draft changed: ${JSON.stringify({ draft, sameCart })}`)
    const paid = await payWithExactCash(ctx, page, 'recovered draft', 2)
    await ctx.shot(page, '08-recovered-sale')
    if (paid.outcome?.outcome !== 'committed')
      throw new Error(`the recovered cart was not paid: ${JSON.stringify(paid.outcome)}`)
    await page.keyboard.press('F9')
    await page.waitForTimeout(400)
    const server = await waitForServerInvoices(sandbox, deviceUuid, 2)
    await page.waitForTimeout(3_000)
    const afterPay = localCounts(session)
    const serverAfter = sandbox.fixture('report', deviceUuid).device_invoice_count
    ctx.step('recovered sale committed and uploaded once', { local: afterPay, server: serverAfter })
    if (afterPay.invoices !== 2 || serverAfter !== 2 || server.device_invoice_count !== 2)
      throw new Error('the recovered draft did not produce exactly one sale')

    // 5. Clear cart on a new draft: Cancel keeps it, Clear empties only it.
    await scan(ctx, page, COLA)
    const firstClear = await openClearFromMore(page)
    if (!firstClear.opened) throw new Error('Clear cart is disabled for an ordinary draft')
    await ctx.shot(page, '09-clear-confirmation')
    await firstClear.dialog.getByRole('button', { name: await t(page, 'common.cancel') }).click()
    await page.waitForTimeout(300)
    if ((await cartState(page)).lines.length !== 1) throw new Error('Cancel cleared the cart')
    const secondClear = await openClearFromMore(page)
    if (!secondClear.opened) throw new Error('Clear cart did not open a second time')
    await secondClear.dialog.getByRole('button', { name: await t(page, 'pos.cart.clear') }).click()
    await page.waitForTimeout(300)
    if ((await cartState(page)).lines.length !== 0) throw new Error('Clear did not empty the draft')
    const end = localCounts(session)
    if (end.invoices !== 2 || end.invoiceQueue !== afterPay.invoiceQueue)
      throw new Error(
        `clearing the cart touched completed sales or their uploads: ${JSON.stringify(end)}`
      )
    ctx.step('done', { end, server: sandbox.fixture('report', deviceUuid).device_invoice_count })
    await ctx.shot(page, '10-cleared')
  } finally {
    await sandbox.stop()
  }
}
