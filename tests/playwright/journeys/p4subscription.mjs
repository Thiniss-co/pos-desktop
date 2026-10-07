import {
  openSandboxAndApp,
  payExactCash,
  currentRoute,
  readiness,
  waitForRoute,
  scan,
  setupPhysicalPresenceTill,
  waitForServerInvoices
} from '../support/journey.mjs'
import { queryLocal } from '../support/localDb.mjs'

/**
 * Platform Phase 4 — subscription requests, as a register sees them, against the real backend and the real app
 * (contract: pos-backend docs/architecture/platform-plans-subscriptions.md §3.4–§3.5).
 *
 * 1. A physical-presence till sells online. Its company's paid period then ends and the grace passes: after a refresh
 *    the till's own commercial-access decision refuses selling (nothing is committed).
 * 2. The company requests the same plan again; the platform approves it, records the exact payment and activates it.
 *    The period ended, so the new one starts now (A-3): after a refresh the till sells again.
 * 3. A second same-plan request while that period runs is activated as a SCHEDULED renewal starting when the current
 *    period ends: the current period is unchanged (no paid time lost, nothing granted early), the till keeps selling,
 *    and its offline authority is never shortened below the limits-disabled window (no 72-hour bound).
 * 4. A third request while one renewal waits is refused at activation (one scheduled renewal at a time).
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

const refreshState = (page) =>
  page.evaluate(() => {
    const s = document
      .querySelector('#app')
      .__vue_app__.config.globalProperties.$pinia._s.get('workstationRefresh')
    return { status: s.status, lastMessage: s.lastMessage }
  })

/**
 * The header refresh as a cashier uses it. With a sale in the cart the app first asks for consent ("Refresh and
 * review"); the journey answers it like a person would, so the cart is kept and reviewed afterwards.
 */
async function refreshWorkstation(ctx, page) {
  await page.evaluate(() =>
    document
      .querySelector('#app')
      .__vue_app__.config.globalProperties.$pinia._s.get('workstationRefresh')
      .dismissMessage()
  )
  await page.locator('[data-testid="workstation-refresh"]:visible').first().click()
  const deadline = Date.now() + 60_000
  let consented = false
  for (;;) {
    const state = await refreshState(page)
    if (state.status === 'confirming' && !consented) {
      await ctx.shot(page, 'refresh-consent')
      await page.getByRole('button', { name: 'Refresh and review' }).click()
      consented = true
    } else if (state.status === 'idle' && state.lastMessage !== null) {
      ctx.step('workstation refresh', { outcome: state.lastMessage, consented })
      return state.lastMessage
    }
    if (Date.now() > deadline) throw new Error(`refresh did not settle: ${JSON.stringify(state)}`)
    await page.waitForTimeout(250)
  }
}

/** After a refresh the app may pass through another screen; selling resumes once the POS route is back. */
async function backToPos(ctx, page, label) {
  await page.waitForTimeout(800)
  ctx.step('screen after the refresh', { route: await currentRoute(page) })
  await ctx.shot(page, label)
  if ((await currentRoute(page)) !== 'pos') await waitForRoute(page, 'pos')
  await page.waitForTimeout(400)
}

function localInvoices(session) {
  return queryLocal(session.profileDir, 'SELECT COUNT(*) AS n FROM local_invoices')[0].n
}

function liveAuthorities(state) {
  return state.authorities.filter((a) => a.superseded_at === null && a.revoked_at === null)
}

function hoursAhead(notAfter) {
  return (Date.parse(notAfter.replace(' ', 'T') + 'Z') - Date.now()) / 3_600_000
}

export async function run(ctx) {
  const session = await openSandboxAndApp(ctx, {
    flags: { POS_OFFLINE_PHYSICAL_PRESENCE_ENABLED: 'true' }
  })
  const { sandbox } = session
  const page = session.page
  try {
    const deviceUuid = await setupPhysicalPresenceTill(ctx, session)
    const start = sandbox.fixture('inspect-subscription')
    ctx.step('before', start)
    if (start.offline_limits_enforced !== false)
      throw new Error('offline limits are enforced in this run')
    if (start.current === null || start.scheduled !== null)
      throw new Error('unexpected starting subscription state')

    await sell(ctx, page, COLA, '01-sale-with-current-subscription')
    await waitForServerInvoices(sandbox, deviceUuid, 1)

    // 1. The paid period ended and the grace passed.
    ctx.step('period ended, grace passed', sandbox.fixture('subscription-lapse'))
    await refreshWorkstation(ctx, page)
    const lapsedReadiness = await readiness(page)
    ctx.step('readiness after the lapse', lapsedReadiness)
    // The app's own commercial-access decision (what every sale is checked against). No sale is attempted here: a
    // refused attempt leaves a protected draft whose recovery is desktop checkout behaviour outside Phase 4.
    const lapsedAccess = await page.evaluate(async () => await window.posApi.license.getAccess())
    ctx.step('commercial access after the lapse', lapsedAccess)
    if (lapsedAccess?.data?.sell?.allowed !== false)
      throw new Error('the till may still sell after the paid period and grace ended')
    const invoicesBefore = localInvoices(session)
    await ctx.shot(page, '02-lapsed')

    // 2. Same-plan request, approved, paid exactly, activated: starts now.
    const started = sandbox.fixture('subscription-request')
    ctx.step('request approved, paid and activated', started)
    if (!started.activated || started.outcome !== 'started')
      throw new Error(`expected an activation starting now: ${JSON.stringify(started)}`)
    const afterStart = sandbox.fixture('inspect-subscription')
    ctx.step('after activation', afterStart)
    if (afterStart.current === null || afterStart.current.id === start.current.id)
      throw new Error('the new period is not the current subscription')
    const renewedRefresh = await refreshWorkstation(ctx, page)
    if (renewedRefresh === 'denied')
      throw new Error('the till is still denied after the activation')
    const renewedAccess = await page.evaluate(async () => await window.posApi.license.getAccess())
    ctx.step('commercial access after the activation', renewedAccess)
    if (renewedAccess?.data?.sell?.allowed !== true)
      throw new Error('the till cannot sell after the activation')
    if (localInvoices(session) !== invoicesBefore)
      throw new Error('a sale was committed while the subscription had lapsed')
    await backToPos(ctx, page, '03a-after-activation-refresh')
    await sell(ctx, page, WATER, '03-sale-after-activation')
    await waitForServerInvoices(sandbox, deviceUuid, 2)

    // 3. A same-plan renewal while the period runs is scheduled at its end.
    const scheduled = sandbox.fixture('subscription-request')
    ctx.step('renewal while the period runs', scheduled)
    if (!scheduled.activated || scheduled.outcome !== 'scheduled')
      throw new Error(`expected a scheduled renewal: ${JSON.stringify(scheduled)}`)
    const afterSchedule = sandbox.fixture('inspect-subscription')
    ctx.step('after scheduling', afterSchedule)
    if (
      afterSchedule.current.id !== afterStart.current.id ||
      afterSchedule.current.expires_at !== afterStart.current.expires_at
    )
      throw new Error('scheduling a renewal changed the current period')
    if (
      afterSchedule.scheduled === null ||
      afterSchedule.scheduled.starts_at !== afterStart.current.expires_at
    )
      throw new Error('the renewal does not start when the current period ends')
    await refreshWorkstation(ctx, page)
    await backToPos(ctx, page, '04a-after-renewal-refresh')
    await sell(ctx, page, COLA, '04-sale-with-a-scheduled-renewal')
    await waitForServerInvoices(sandbox, deviceUuid, 3)
    const authorities = liveAuthorities(sandbox.fixture('inspect-subscription'))
    if (authorities.length < 1) throw new Error('no live offline authority after the renewal')
    const window = hoursAhead(authorities.at(-1).not_after)
    ctx.step('offline authority with limits disabled', {
      notAfter: authorities.at(-1).not_after,
      hoursAhead: Math.round(window)
    })
    if (window <= 72) throw new Error(`authority bounded to ${window}h; limits must stay disabled`)

    // 4. One scheduled renewal at a time.
    const second = sandbox.fixture('subscription-request')
    ctx.step('second renewal while one waits', second)
    if (second.activated || second.refusal !== 'SUBSCRIPTION_RENEWAL_ALREADY_SCHEDULED')
      throw new Error(`a second renewal was not refused: ${JSON.stringify(second)}`)
    const end = sandbox.fixture('inspect-subscription')
    if (end.rows !== afterSchedule.rows) throw new Error('a refused renewal created a subscription')
    ctx.step('done', { rows: end.rows, current: end.current, scheduled: end.scheduled })
  } finally {
    await sandbox.stop()
  }
}
