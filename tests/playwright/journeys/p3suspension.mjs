import {
  attemptExactCash,
  CASHIER,
  openShift,
  openSandboxAndApp,
  payExactCash,
  refreshWorkstation,
  relaunch,
  scan,
  setupPhysicalPresenceTill,
  signIn,
  signOutViaMenu,
  waitForRoute,
  waitForServerInvoices
} from '../support/journey.mjs'
import { queryLocal } from '../support/localDb.mjs'

/**
 * Phase 3 — platform company suspension, end to end against the real backend and the real app
 * (contract: pos-backend docs/architecture/platform-company-suspension.md §7).
 *
 * 1. A physical-presence till sells online, then OFFLINE (queued, authority-covered sales). While it is
 *    offline the platform suspends the company; the till cannot know and sells once more (§2: an offline
 *    register keeps its existing authority — offline limits stay DISABLED, nothing is shortened).
 * 2. Reconnect: every queued sale uploads and is accepted exactly once; the ones rung after the
 *    suspension are flagged for review. One upload is delivered twice: the replay creates nothing.
 * 3. The till observes the suspension: banner, new sales refused locally with ONE message and the
 *    cart kept, no session ended, no data cleared. An offline restart keeps the known suspension (it
 *    is persisted, never re-derived). Shift close and sign-out still work; signing in again
 *    (recovery) works and issues no authority or license.
 * 4. Resume: the binding ended by the sign-out stays revoked, the live session regains selling without
 *    signing in again (the newer-revision `active` state arrives on an ordinary response), and the
 *    offline authority's `not_after` never changed.
 */

const COLA = '6221000000011'
const WATER = '6221000000028'

async function sell(ctx, page, code, label) {
  await scan(ctx, page, code)
  await payExactCash(ctx, page)
  await ctx.shot(page, label)
  await page.keyboard.press('F9')
  await page.waitForTimeout(400)
}

function pending(session) {
  return queryLocal(
    session.profileDir,
    "SELECT COUNT(*) AS n FROM sync_queue WHERE state != 'synced'"
  )[0].n
}

function localInvoices(session) {
  return queryLocal(session.profileDir, 'SELECT COUNT(*) AS n FROM local_invoices')[0].n
}

async function bannerShown(page) {
  return (await page.getByTestId('company-suspended-banner').count()) > 0
}

function cartLines(page) {
  return page.evaluate(
    () =>
      document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('cart').lines
        .length
  )
}

const SUSPENSION_TEXT = 'The platform has suspended this company'

/** A refused sale: named for the suspension, said once, nothing committed, the cart kept. */
async function assertRefused(ctx, session, page, label) {
  const invoicesBefore = localInvoices(session)
  await scan(ctx, page, WATER)
  const linesBefore = await cartLines(page)
  const attempt = await attemptExactCash(ctx, page)
  await ctx.shot(page, label)
  if (localInvoices(session) !== invoicesBefore)
    throw new Error('a sale was committed while suspended')
  if (attempt.outcome?.code !== 'company-suspended')
    throw new Error(`the refusal did not name the suspension: ${JSON.stringify(attempt.outcome)}`)
  if (attempt.text.includes('assignment changed'))
    throw new Error('the cashier was told the shift or workstation changed')
  const mentions = attempt.text.split(SUSPENSION_TEXT).length - 1
  if (mentions !== 1)
    throw new Error(`the payment dialog states the suspension ${mentions} times, expected once`)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  const linesAfter = await cartLines(page)
  if (linesAfter !== linesBefore || linesAfter < 1)
    throw new Error(`the cart was not kept (${linesBefore} -> ${linesAfter})`)
  if (!(await bannerShown(page))) throw new Error('the suspension banner disappeared')
  ctx.step('new sale refused', { outcome: attempt.outcome, mentions, cartLines: linesAfter })
}

export async function run(ctx) {
  const session = await openSandboxAndApp(ctx, {
    flags: { POS_OFFLINE_PHYSICAL_PRESENCE_ENABLED: 'true' },
    proxy: true
  })
  const { sandbox, proxy } = session
  let page = session.page
  try {
    const deviceUuid = await setupPhysicalPresenceTill(ctx, session)
    const start = sandbox.fixture('inspect-suspension')
    ctx.step('before suspension', start)
    if (start.offline_limits_enforced !== false)
      throw new Error('offline limits are enforced in this run')
    const authoritiesBefore = start.authorities.filter(
      (a) => a.superseded_at === null && a.revoked_at === null
    )
    if (authoritiesBefore.length < 1) throw new Error('no offline authority was issued to the till')
    const notAfter = authoritiesBefore.at(-1).not_after
    const hoursAhead = (Date.parse(notAfter.replace(' ', 'T') + 'Z') - Date.now()) / 3_600_000
    ctx.step('offline authority window with limits disabled', {
      notAfter,
      hoursAhead: Math.round(hoursAhead)
    })
    if (hoursAhead <= 72)
      throw new Error(`authority bounded to ${hoursAhead}h; limits must stay disabled`)

    await sell(ctx, page, COLA, '01-online-sale-before-suspension')
    await waitForServerInvoices(sandbox, deviceUuid, 1)

    // 1. Offline, then suspended while offline.
    await proxy.offline()
    await page.evaluate(async () => await window.posApi.connectivity.checkNow())
    await sell(ctx, page, WATER, '02-offline-sale-before-suspension')
    const suspended = sandbox.fixture('suspend-company', 'Unpaid platform invoices')
    ctx.step('platform suspends the company while the till is offline', suspended)
    if (!suspended.applied) throw new Error('the company was not suspended')
    await sell(ctx, page, COLA, '03-offline-sale-after-suspension')
    if (await bannerShown(page))
      throw new Error('an offline till cannot know about the suspension yet')
    ctx.step('queued offline sales', { pending: pending(session) })

    // 2. Reconnect: uploads accepted (one delivered twice), the later one flagged.
    const hold = proxy.hold('hold-suspended-upload', /^POST \/api\/v1\/desktop\/invoices\/upload/)
    await proxy.online()
    await page.evaluate(async () => await window.posApi.connectivity.checkNow())
    await hold.captured
    const first = await hold.release()
    const resent = await hold.release()
    ctx.step('first queued upload delivered twice', { first: first.status, resent: resent.status })
    if (![200, 201].includes(first.status) || ![200, 201].includes(resent.status))
      throw new Error('an upload during the suspension was not accepted')
    const report = await waitForServerInvoices(sandbox, deviceUuid, 3, 90_000)
    for (const [local, facts] of Object.entries(report.invoices)) {
      if (facts.sync_records !== 1 || facts.server_invoices !== 1)
        throw new Error(`invoice ${local} not recorded exactly once: ${JSON.stringify(facts)}`)
    }
    const afterUpload = sandbox.fixture('inspect-suspension')
    ctx.step('uploads accepted during the suspension', afterUpload.uploads)
    if (afterUpload.uploads.length !== 2)
      throw new Error('expected 2 audited uploads during the suspension')
    if (!afterUpload.uploads.some((u) => Number(u.flagged) === 1))
      throw new Error('the sale rung after the suspension was not flagged')

    // 3. The till observed the suspension: banner, selling refused, nothing ended or cleared.
    await page.getByTestId('company-suspended-banner').waitFor({ timeout: 30_000 })
    await ctx.shot(page, '04-suspended-banner')
    await assertRefused(ctx, session, page, '05-sale-refused-while-suspended')

    // 3b. Offline restart: the known suspension is read back from the device, not re-learned.
    await proxy.offline()
    await page.evaluate(async () => await window.posApi.connectivity.checkNow())
    await relaunch(ctx, session)
    page = session.page
    await waitForRoute(page, 'pos')
    await page.getByTestId('company-suspended-banner').waitFor({ timeout: 30_000 })
    await ctx.shot(page, '05b-offline-restart-still-suspended')
    await assertRefused(ctx, session, page, '05c-offline-sale-refused-after-restart')
    await proxy.online()
    await page.evaluate(async () => await window.posApi.connectivity.checkNow())
    await page.waitForTimeout(1_000)
    if (!(await bannerShown(page)))
      throw new Error('reconnecting while still suspended cleared the suspension')
    ctx.step('offline restart kept the suspension; reconnecting did not clear it')

    // After the offline restart the store holds only the local authority; read the server's current
    // shift (a read, allowed while suspended) exactly as the shift screen does.
    const shift = await page.evaluate(async () => {
      const s = document
        .querySelector('#app')
        .__vue_app__.config.globalProperties.$pinia._s.get('shift')
      await s?.loadCurrent?.()
      const current = s?.currentShift ?? s?.shift
      return current
        ? {
            uuid: current.uuid,
            expected: current.expectedCashAmount ?? current.openingCashAmount ?? 0
          }
        : null
    })
    if (!shift) throw new Error('no open shift to close')
    const closed = await page.evaluate(
      async ([uuid, amount]) =>
        await window.posApi.shifts.close({ uuid, actualCashAmount: amount }),
      [shift.uuid, Math.max(0, Number(shift.expected) || 0)]
    )
    ctx.step('shift closed while suspended', {
      ok: closed.ok,
      error: closed.ok ? null : closed.error
    })
    if (!closed.ok) throw new Error('shift close was refused during the suspension')

    const tokensBeforeRecovery = sandbox.fixture('inspect-suspension')
    await signOutViaMenu(ctx, page)
    await signIn(ctx, page, CASHIER)
    await waitForRoute(page, 'pos')
    const recovery = sandbox.fixture('inspect-suspension')
    ctx.step('recovery sign-in during the suspension', {
      bindings: recovery.bindings,
      licenseTokens: recovery.license_tokens
    })
    if (recovery.license_tokens !== tokensBeforeRecovery.license_tokens)
      throw new Error('recovery sign-in issued a new license token')
    if (recovery.authorities.length !== tokensBeforeRecovery.authorities.length)
      throw new Error('recovery sign-in issued a new offline authority')
    await page.getByTestId('company-suspended-banner').waitFor({ timeout: 30_000 })
    await ctx.shot(page, '06-recovery-signed-in')

    // 4. Resume: revoked binding stays revoked; the live session sells again without signing in.
    const resumed = sandbox.fixture('resume-company', 'Invoices settled')
    ctx.step('platform lifts the suspension', resumed)
    await refreshWorkstation(ctx, page)
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="company-suspended-banner"]'),
      null,
      { timeout: 60_000 }
    )
    await ctx.shot(page, '07-resumed')
    const end = sandbox.fixture('inspect-suspension')
    ctx.step('after resumption', { bindings: end.bindings, state: end.state })
    if (end.state !== 'active') throw new Error('the company is still suspended')
    if (end.bindings.revoked < recovery.bindings.revoked)
      throw new Error('a revoked binding was revived')
    const original = end.authorities.find((a) => a.not_after === notAfter)
    if (!original) throw new Error('the original authority window changed')
    if (end.offline_limits_enforced !== false) throw new Error('offline limits were enabled')
    ctx.step('offline limits unchanged', {
      enforced: end.offline_limits_enforced,
      notAfter: original.not_after
    })

    // The same signed-in session sells again: a new shift (opened online), then a committed, uploaded sale.
    await openShift(ctx, page)
    await sell(ctx, page, WATER, '08-sale-after-resumption')
    await waitForServerInvoices(sandbox, deviceUuid, 4, 90_000)
    ctx.step('selling resumed without signing in again')
  } finally {
    ctx.facts.mainLogTail = session.logs
      .join('')
      .split('\n')
      .filter(
        (l) =>
          l.includes('COMPANY_SUSPENDED') ||
          l.includes('invoices/upload') ||
          l.includes('company_access')
      )
      .slice(-60)
    await session.app.close().catch(() => undefined)
    await proxy?.stop()
    await sandbox.stop()
  }
}
