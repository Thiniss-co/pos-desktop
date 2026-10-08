import {
  mainTrace,
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
 * Platform Phase 6, criterion C3 — compatibility in both directions, as a register sees it, against REAL backends.
 *
 * - OLD backend: a tree at the pre-Phase-6 commit (PW_OLD_BACKEND_ROOT; the integration run used the canonical
 *   checkout at `main` b34d508, read-only: its logs, cache, views and config cache are redirected into the run
 *   directory and the tree is compared before and after by the caller).
 * - NEW backend: PW_BACKEND_ROOT (the feature backend). Both serve ONE sandbox database: the switch to the new backend
 *   runs its migrations on that database (an upgrade); a switch back is a code rollback on the newer schema.
 *
 * A. New desktop, fresh profile, old backend: no sequence ever stored; sign-in, bootstrap, validation and a sale work.
 * B. Upgrade: the desktop declares access_sequence_version=1 (visible in the bootstrap request) and stores the
 *    sequence; a suspension (higher sequence) refuses selling and survives an offline restart; a resume (newer
 *    sequence) restores it.
 * C. Rollback while sequenced state exists: an unsequenced answer that would RELAX access is refused (main-process
 *    reason), the stored sequence and the refusal stay, also across an offline restart; an unsequenced RESTRICTION
 *    (a feature turned off, while selling is allowed) is applied without touching the sequence; turning the feature
 *    back on is a relaxation and is discarded. Recovery 1: the sequencing backend comes back and its newer answer
 *    restores selling. Recovery 2: sign out and in (a new session starts a fresh order).
 *
 * The 72-hour limit stays off; nothing here issues check-ins, shortens authority or deletes pending sales.
 */

const COLA = '6221000000011'
const WATER = '6221000000028'

function oldBackendRoot() {
  const root = process.env.PW_OLD_BACKEND_ROOT
  if (!root) throw new Error('PW_OLD_BACKEND_ROOT (a pre-Phase-6 backend tree) is required')
  return root
}

async function access(page) {
  const result = await page.evaluate(async () => await window.posApi.license.getAccess())
  return result?.data?.sell ?? result
}

async function sell(ctx, page, code, label) {
  await scan(ctx, page, code)
  await payExactCash(ctx, page)
  await ctx.shot(page, label)
  await page.keyboard.press('F9')
  await page.waitForTimeout(400)
}

function local(session) {
  const profile = session.profileDir
  const sequence = queryLocal(
    profile,
    "SELECT value FROM app_settings WHERE key = 'license.access_sequence'"
  )[0]
  const status = queryLocal(
    profile,
    'SELECT details_json FROM license_state_metadata WHERE id = 1'
  )[0]
  const features = queryLocal(
    profile,
    'SELECT feature_code FROM bootstrap_features WHERE is_enabled = 1 ORDER BY feature_code'
  ).map((row) => row.feature_code)
  const details = status?.details_json ? JSON.parse(status.details_json) : null
  return {
    accessSequence: sequence ? JSON.parse(sequence.value).sequence : null,
    canSell: details?.canSell ?? null,
    features,
    authorities: queryLocal(profile, 'SELECT authority_uuid FROM offline_sale_authorities').length
  }
}

async function goOffline(proxy, page) {
  await proxy.offline()
  await page.evaluate(async () => await window.posApi.connectivity.checkNow())
}

async function goOnline(proxy, page) {
  await proxy.online()
  await page.evaluate(async () => await window.posApi.connectivity.checkNow())
}

async function offlineRestart(ctx, session, proxy) {
  await goOffline(proxy, session.page)
  await relaunch(ctx, session)
  await session.page.waitForFunction(
    () => window.posApi !== undefined && document.querySelector('#app')?.__vue_app__ !== undefined,
    null,
    { timeout: 60_000 }
  )
  await session.page.waitForTimeout(2000)
  const result = await access(session.page)
  await goOnline(proxy, session.page)
  return result
}

function lifecycle(ctx, sandbox, argument) {
  const result = sandbox.fixture('subscription-lifecycle', argument)
  ctx.step(`platform lifecycle: ${argument}`, result)
  if (!result.applied)
    throw new Error(`the lifecycle operation ${argument} was refused: ${JSON.stringify(result)}`)
  return result
}

export async function run(ctx) {
  const oldRoot = oldBackendRoot()
  const newRoot = process.env.PW_BACKEND_ROOT
  if (!newRoot) throw new Error('PW_BACKEND_ROOT (the sequencing backend) is required')
  const session = await openSandboxAndApp(ctx, {
    flags: {
      POS_OFFLINE_PHYSICAL_PRESENCE_ENABLED: 'true',
      // Nothing is written into the backend trees themselves (the old one is a canonical checkout).
      LOG_CHANNEL: 'stderr',
      CACHE_STORE: 'array',
      VIEW_COMPILED_PATH: `${ctx.runDir}/views`
    },
    proxy: true,
    backendRoot: oldRoot
  })
  const { sandbox, proxy } = session
  try {
    // A. Old backend.
    ctx.step('serving the OLD backend', { root: sandbox.backendRoot })
    const deviceUuid = await setupPhysicalPresenceTill(ctx, session)
    await sell(ctx, session.page, COLA, '01-sale-old-backend')
    await waitForServerInvoices(sandbox, deviceUuid, 1)
    const afterOld = local(session)
    ctx.step('A: old backend', { local: afterOld })
    if (afterOld.accessSequence !== null)
      throw new Error('an access sequence was stored against an old backend')
    if ((await access(session.page))?.allowed !== true)
      throw new Error('the till cannot sell against the old backend')

    // B. Upgrade: same database, new code and migrations.
    await sandbox.useBackend(newRoot, { migrate: true })
    ctx.step('upgraded to the NEW backend (migrated the same database)', {
      root: sandbox.backendRoot
    })
    await refreshWorkstation(ctx, session.page)
    const upgraded = local(session)
    ctx.step('B: after the first answers of the new backend', { local: upgraded })
    if (!(upgraded.accessSequence > 0))
      throw new Error('no access sequence stored after the upgrade (not negotiated?)')
    const declared = proxy
      .requests(/^GET \/api\/v1\/desktop\/bootstrap\?/)
      .map((entry) => entry.line)
    ctx.step('B: the desktop declares the access-sequence contract', {
      bootstrapRequests: declared.length,
      declaring: declared.filter((line) => line.includes('access_sequence_version=1')).length
    })
    if (
      declared.length === 0 ||
      !declared.every((line) => line.includes('access_sequence_version=1'))
    )
      throw new Error('a bootstrap request did not declare access_sequence_version=1')

    lifecycle(ctx, sandbox, 'suspend')
    await refreshWorkstation(ctx, session.page)
    const suspended = local(session)
    if ((await access(session.page))?.allowed !== false)
      throw new Error('the suspension was not applied')
    if (!(suspended.accessSequence > upgraded.accessSequence))
      throw new Error('the denial did not carry a newer sequence')
    const restartDenied = await offlineRestart(ctx, session, proxy)
    ctx.step('B: suspended, after an offline restart', {
      access: restartDenied,
      local: local(session)
    })
    if (restartDenied?.allowed !== false)
      throw new Error('the denial did not survive an offline restart')

    lifecycle(ctx, sandbox, 'resume')
    await refreshWorkstation(ctx, session.page)
    const resumed = local(session)
    if ((await access(session.page))?.allowed !== true)
      throw new Error('a newer resume did not restore selling')
    if (!(resumed.accessSequence > suspended.accessSequence))
      throw new Error('the resume did not carry a newer sequence')
    await waitForRoute(session.page, 'pos')
    await sell(ctx, session.page, WATER, '02-sale-after-upgrade')
    await waitForServerInvoices(sandbox, deviceUuid, 2)
    ctx.step('B: resumed and sold', { local: resumed })

    // C. Rollback while sequenced state exists: suspended at sequence S on the new backend, then (with the new code's
    // CLI) resumed in the database, then the OLD code serves it.
    lifecycle(ctx, sandbox, 'suspend')
    await refreshWorkstation(ctx, session.page)
    const recorded = local(session)
    if ((await access(session.page))?.allowed !== false)
      throw new Error('the second suspension was not applied')
    lifecycle(ctx, sandbox, 'resume')
    await sandbox.useBackend(oldRoot)
    ctx.step('rolled back to the OLD backend code (newer schema kept)', {
      root: sandbox.backendRoot,
      recorded
    })

    const relaxing = await session.page.evaluate(async () => await window.posApi.license.validate())
    const afterRelax = local(session)
    await session.page.waitForTimeout(500)
    const staleTrace = (await mainTrace(session, 'StaleAccessResponseError')).concat(
      await mainTrace(session, 'older access answer')
    )
    const recentLog = session.logs
      .join('')
      .split('\n')
      .filter((line) => /error|stale|license/i.test(line))
      .slice(-12)
    ctx.step('C: unsequenced relaxing answer', {
      relaxing,
      local: afterRelax,
      trace: staleTrace.slice(-1),
      recentLog
    })
    if ((await access(session.page))?.allowed !== false)
      throw new Error('an unsequenced answer relaxed a recorded restriction')
    if (afterRelax.accessSequence !== recorded.accessSequence)
      throw new Error('an unsequenced answer changed the ordering state')
    if (staleTrace.length === 0)
      throw new Error('the refused unsequenced relaxation left no main-process reason')
    const restartStillDenied = await offlineRestart(ctx, session, proxy)
    if (restartStillDenied?.allowed !== false)
      throw new Error('the recorded restriction did not survive an offline restart')
    await ctx.shot(session.page, '03-rollback-relaxation-refused')

    // Recovery 1: the sequencing backend comes back; its next, newer answer restores selling.
    await sandbox.useBackend(newRoot, { migrate: true })
    await refreshWorkstation(ctx, session.page)
    const recovered = local(session)
    ctx.step('C: recovery 1 — the new backend is back', { local: recovered })
    if ((await access(session.page))?.allowed !== true)
      throw new Error('the returning sequencing backend did not restore selling')
    if (!(recovered.accessSequence > recorded.accessSequence))
      throw new Error('the returning backend answer was not newer')

    // Rolled back again while selling is allowed (an old backend refuses bootstrap while sync is blocked, so a
    // bootstrap restriction only exists while access is open): an unsequenced RESTRICTION — inventory turned off —
    // is applied and keeps the order; turning it back on is a RELAXATION and is discarded.
    await sandbox.useBackend(oldRoot)
    ctx.step(
      'inventory feature off (old backend)',
      sandbox.fixture('company-feature', 'inventory:0')
    )
    await refreshWorkstation(ctx, session.page)
    const restricted = local(session)
    ctx.step('C: unsequenced restriction', { local: restricted })
    if (restricted.features.includes('inventory'))
      throw new Error('an unsequenced restriction from the old backend was not applied')
    if (restricted.accessSequence !== recovered.accessSequence)
      throw new Error('an unsequenced restriction changed the ordering state')
    if ((await access(session.page))?.allowed !== true)
      throw new Error('an equal unsequenced answer refused selling')

    ctx.step(
      'inventory feature back on (old backend)',
      sandbox.fixture('company-feature', 'inventory:1')
    )
    await refreshWorkstation(ctx, session.page)
    const stillRestricted = local(session)
    ctx.step('C: unsequenced relaxation of a feature', { local: stillRestricted })
    if (stillRestricted.features.includes('inventory'))
      throw new Error('an unsequenced answer re-enabled a feature after sequenced state')
    if (stillRestricted.accessSequence !== recovered.accessSequence)
      throw new Error('a discarded answer changed the ordering state')
    await ctx.shot(session.page, '04-rollback-feature-relaxation-refused')

    // Recovery 2: sign out and in on the old backend — a new session starts a fresh order and admits its answers.
    await signOutViaMenu(ctx, session.page)
    await signIn(ctx, session.page)
    await waitForRoute(session.page, 'pos')
    await refreshWorkstation(ctx, session.page)
    const freshSession = local(session)
    ctx.step('C: recovery 2 — signed in again on the old backend', {
      local: freshSession,
      access: await access(session.page)
    })
    if (!freshSession.features.includes('inventory'))
      throw new Error('a new session on the old backend did not admit its unsequenced answers')
    if ((await access(session.page))?.allowed !== true)
      throw new Error('the till cannot sell after signing in again')
    await ctx.shot(session.page, '05-recovered-new-session')
  } finally {
    proxy?.clear()
    await sandbox.stop()
  }
}
