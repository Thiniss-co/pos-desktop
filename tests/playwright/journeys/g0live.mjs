import {
  activate,
  attemptExactCash,
  cardState,
  deviceUuid,
  mainTrace,
  openSandboxAndApp,
  openShift,
  refreshWorkstation,
  scan,
  signIn,
  sizeWindow,
  waitForRoute
} from '../support/journey.mjs'

/**
 * G0 (Rev 4 §17), user-visible symptoms on the PRE-FIX build, against a real Laravel with physical
 * presence enabled for this disposable run only:
 *  - `/up` carries an HTTP `Date` header (the server-time sample source the plan assumes);
 *  - a PP product whose recorded quantity is 0 is dimmed (A5);
 *  - D1: an online PP sale is blocked by a foreground top-up refusal although an authority is held;
 *  - a manual refresh while that attempt is claimed supersedes it (terminal `catalog-superseded`).
 */
export async function run(ctx) {
  const session = await openSandboxAndApp(ctx, {
    flags: { POS_OFFLINE_PHYSICAL_PRESENCE_ENABLED: 'true' }
  })
  const { page, sandbox } = session
  try {
    const up = await fetch(new URL('/up', sandbox.origin))
    ctx.step('G0 /up Date header', { status: up.status, date: up.headers.get('date') })
    if (!up.headers.get('date')) throw new Error('/up has no Date header')

    await sizeWindow(session)
    await activate(ctx, page)
    await signIn(ctx, page)
    await waitForRoute(page, 'pos')
    const uuid = await deviceUuid(sandbox)
    sandbox.fixture('assign-device', uuid)
    ctx.step('policy set to physical presence', sandbox.fixture('mode-physical-presence'))
    ctx.step(
      'WATER-500 recorded stock reduced to 0',
      sandbox.fixture('adjust-stock', 'WATER-500:200')
    )
    await refreshWorkstation(ctx, page)
    await openShift(ctx, page)
    const readiness = await page.evaluate(
      async () => await window.posApi.offlineSale.getReadiness()
    )
    ctx.step('G0 readiness after refresh (authority held?)', readiness)
    const water = await cardState(page, 'Water Bottle')
    ctx.step('G0 A5: Water Bottle card at recorded 0 under PP', water)
    await ctx.shot(page, '01-pp-zero-stock-card')

    ctx.step(
      'CHIPS-S tracking turned off on the server after catalog issue',
      sandbox.fixture('set-tracking', 'CHIPS-S:0')
    )
    await scan(ctx, page, '6221000000035')
    ctx.step(
      'readiness at the D1 sale',
      await page.evaluate(async () => await window.posApi.offlineSale.getReadiness())
    )
    const d1 = await attemptExactCash(ctx, page)
    await ctx.shot(page, '02-d1-online-pp-sale-blocked')
    ctx.step('G0 D1 trace', { topUp: await mainTrace(session, 'top-up') })
    ctx.facts.d1Outcome = d1.outcome

    // Manual refresh while that attempt is claimed, then retry it.
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    await refreshWorkstation(ctx, page)
    const retried = await page.evaluate(async () => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
      const payment = pinia._s.get('payment')
      const key = payment.blockingAttemptKey ?? payment.attemptKey
      const outcome = await window.posApi.checkout.retryAttempt({ attemptKey: key })
      return { key, outcome }
    })
    ctx.step('G0 manual refresh during a claimed attempt, then retry', retried)
    await ctx.shot(page, '03-after-refresh-retry')
    ctx.facts.refreshRetry = retried
  } finally {
    ctx.facts.mainLogTail = session.logs.join('').split('\n').slice(-80)
    await session.app.close().catch(() => undefined)
    await sandbox.stop()
  }
}
