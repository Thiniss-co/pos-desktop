import {
  mainTrace,
  openSandboxAndApp,
  payExactCash,
  refreshWorkstation,
  relaunch,
  scan,
  setupPhysicalPresenceTill,
  waitForRoute,
  waitForServerInvoices
} from '../support/journey.mjs'
import { queryLocal } from '../support/localDb.mjs'

/**
 * Platform Phase 6 — subscription lifecycle, FU-P3-2 and access ordering (C3), as a register sees them, against the real
 * backend and the real app (contract: pos-backend docs/architecture/platform-subscription-lifecycle.md).
 *
 * 1. A physical-presence till sells online and holds a live offline authority.
 * 2. The platform SUSPENDS the subscription. A refresh is refused; the validation issues no new authority and
 *    re-delivers none (FU-P3-2), and the authority already on the till stays on disk (nothing claims it was withdrawn).
 * 3. Offline restart: the till still refuses (the denial was persisted with its access sequence).
 * 4. Resume (online): a refresh sells again (a newer sequence restores access).
 * 5. C3 interleave: a bootstrap evaluated while selling was allowed is answered late; meanwhile the subscription is
 *    suspended and a validation (newer sequence) is applied. The late bootstrap answer is refused — no write, no
 *    authority observation — and the till stays refused.
 * 6. Resume, then EXTEND by 30 days: the till's stored subscription end moves with the server's.
 * 7. END NOW: a refresh is refused. Server authority rows are never revoked or shortened by any of this.
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

async function access(page) {
  const result = await page.evaluate(async () => await window.posApi.license.getAccess())
  return result?.data?.sell ?? result
}

async function validate(page) {
  return await page.evaluate(async () => await window.posApi.license.validate())
}

function local(session) {
  const profile = session.profileDir
  const status = queryLocal(
    profile,
    'SELECT details_json FROM license_state_metadata WHERE id = 1'
  )[0]
  const sequence = queryLocal(
    profile,
    "SELECT value FROM app_settings WHERE key = 'license.access_sequence'"
  )[0]
  const bootstrap = queryLocal(profile, 'SELECT server_time FROM bootstrap_state LIMIT 1')[0]
  const details = status?.details_json ? JSON.parse(status.details_json) : null
  return {
    canSell: details?.canSell ?? null,
    subscriptionExpiresAt: details?.subscription?.expiresAt ?? null,
    accessSequence: sequence ? JSON.parse(sequence.value).sequence : null,
    bootstrapServerTime: bootstrap?.server_time ?? null,
    authorities: queryLocal(
      profile,
      'SELECT authority_uuid FROM offline_sale_authorities ORDER BY created_at, authority_uuid'
    ).map((row) => row.authority_uuid)
  }
}

function serverAuthorities(sandbox) {
  return sandbox.fixture('inspect-subscription').authorities
}

function lifecycle(ctx, sandbox, argument) {
  const result = sandbox.fixture('subscription-lifecycle', argument)
  ctx.step(`platform lifecycle: ${argument}`, result)
  if (!result.applied)
    throw new Error(`the lifecycle operation ${argument} was refused: ${JSON.stringify(result)}`)
  return result
}

async function goOffline(proxy, page) {
  await proxy.offline()
  await page.evaluate(async () => await window.posApi.connectivity.checkNow())
}

async function goOnline(proxy, page) {
  await proxy.online()
  await page.evaluate(async () => await window.posApi.connectivity.checkNow())
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
    const start = sandbox.fixture('inspect-subscription')
    if (start.offline_limits_enforced !== false)
      throw new Error('offline limits are enforced in this run')

    // 1. Selling online with a live authority.
    await sell(ctx, page, COLA, '01-sale-active')
    await waitForServerInvoices(sandbox, deviceUuid, 1)
    const before = local(session)
    const serverBefore = serverAuthorities(sandbox)
    ctx.step('before suspension', { local: before, server: serverBefore })
    if (before.authorities.length === 0) throw new Error('the till holds no offline authority')

    // 2. Suspend: refused after a refresh; no new authority, nothing re-delivered, nothing withdrawn.
    lifecycle(ctx, sandbox, 'suspend')
    await refreshWorkstation(ctx, page)
    const suspendedAccess = await access(page)
    const suspended = local(session)
    const serverSuspended = serverAuthorities(sandbox)
    ctx.step('after suspension', {
      access: suspendedAccess,
      local: suspended,
      server: serverSuspended
    })
    if (suspendedAccess?.allowed !== false)
      throw new Error('the till may still sell while the subscription is suspended')
    if (serverSuspended.length !== serverBefore.length)
      throw new Error('a validation issued authority while suspended (FU-P3-2)')
    if (suspended.authorities.length !== before.authorities.length)
      throw new Error('the till received authority while suspended')
    if (!before.authorities.every((uuid) => suspended.authorities.includes(uuid)))
      throw new Error('an authority on the till was withdrawn')
    if (!(suspended.accessSequence > before.accessSequence))
      throw new Error('the denial did not advance the access sequence')
    await ctx.shot(page, '02-suspended')

    // 3. Offline restart: still refused.
    await goOffline(proxy, page)
    await relaunch(ctx, session)
    page = session.page
    await page.waitForFunction(
      () =>
        window.posApi !== undefined && document.querySelector('#app')?.__vue_app__ !== undefined,
      null,
      { timeout: 60_000 }
    )
    await page.waitForTimeout(2000)
    const restartAccess = await access(page)
    ctx.step('after an offline restart while suspended', {
      access: restartAccess,
      local: local(session)
    })
    if (restartAccess?.allowed !== false)
      throw new Error('the till sells after an offline restart while suspended')
    await ctx.shot(page, '03-suspended-offline-restart')
    await goOnline(proxy, page)

    // 4. Resume: a newer answer restores access.
    lifecycle(ctx, sandbox, 'resume')
    await refreshWorkstation(ctx, page)
    const resumedAccess = await access(page)
    ctx.step('after resume', { access: resumedAccess, local: local(session) })
    if (resumedAccess?.allowed !== true)
      throw new Error('the till cannot sell after the subscription was resumed')
    await waitForRoute(page, 'pos')
    await sell(ctx, page, WATER, '04-sale-after-resume')
    await waitForServerInvoices(sandbox, deviceUuid, 2)

    // 5. C3: a late bootstrap answer evaluated while selling was allowed must not overwrite the newer suspension.
    const preInterleave = local(session)
    proxy.rule('late-bootstrap', /^GET \/api\/v1\/desktop\/bootstrap/, {
      delayResponseMs: 6000,
      times: 1
    })
    const lateBootstrap = page.evaluate(async () => await window.posApi.bootstrap.refresh())
    await page.waitForTimeout(1200)
    lifecycle(ctx, sandbox, 'suspend')
    const denial = await validate(page)
    const afterDenial = local(session)
    const bootstrapOutcome = await lateBootstrap
    const afterLate = local(session)
    ctx.step('C3 interleave', { preInterleave, denial, afterDenial, bootstrapOutcome, afterLate })
    const staleTrace = await mainTrace(session, 'StaleAccessResponseError')
    ctx.step('main-process reason for the refused bootstrap', { trace: staleTrace })
    if (bootstrapOutcome?.ok !== false || staleTrace.length === 0)
      throw new Error('the late bootstrap was not refused as an older access answer')
    if (afterDenial.canSell !== false)
      throw new Error('the newer validation did not record the denial')
    if (afterLate.accessSequence !== afterDenial.accessSequence)
      throw new Error('the late bootstrap replaced the newer access sequence')
    if (afterLate.bootstrapServerTime !== preInterleave.bootstrapServerTime)
      throw new Error('the late bootstrap snapshot was written')
    if (afterLate.authorities.length !== afterDenial.authorities.length)
      throw new Error('the late bootstrap delivered an authority')
    if ((await access(page))?.allowed !== false)
      throw new Error('the till sells after the late, older bootstrap answer')
    await ctx.shot(page, '05-late-bootstrap-refused')

    // 6. Resume and extend: the stored subscription end follows the server.
    lifecycle(ctx, sandbox, 'resume')
    const extended = lifecycle(ctx, sandbox, 'extend:30')
    await refreshWorkstation(ctx, page)
    const extendedLocal = local(session)
    ctx.step('after extending by 30 days', {
      server: extended,
      local: extendedLocal,
      access: await access(page)
    })
    if (
      Date.parse(extendedLocal.subscriptionExpiresAt) !==
      Date.parse(extended.expires_at.replace(' ', 'T') + 'Z')
    )
      throw new Error('the till did not store the extended period end')
    if ((await access(page))?.allowed !== true)
      throw new Error('the till cannot sell after the extension')

    // 7. End now: refused; server authority rows were never revoked or shortened by any lifecycle operation.
    lifecycle(ctx, sandbox, 'end_now')
    await refreshWorkstation(ctx, page)
    const endedAccess = await access(page)
    const serverEnd = serverAuthorities(sandbox)
    ctx.step('after end now', { access: endedAccess, local: local(session), server: serverEnd })
    if (endedAccess?.allowed !== false)
      throw new Error('the till sells after the subscription ended')
    for (const row of serverBefore) {
      const now = serverEnd.find((candidate) => candidate.uuid === row.uuid)
      if (!now || now.not_after !== row.not_after || now.revoked_at !== null)
        throw new Error(`a server authority was revoked or shortened: ${row.uuid}`)
    }
    await ctx.shot(page, '06-ended')
  } finally {
    proxy?.clear()
    await sandbox.stop()
  }
}
