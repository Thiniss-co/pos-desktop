import {
  openSandboxAndApp,
  payExactCash,
  refreshWorkstation,
  scan,
  setupPhysicalPresenceTill,
  waitForServerInvoices
} from '../support/journey.mjs'
import { queryLocal } from '../support/localDb.mjs'

/**
 * Phase 4 final review — an OLDER desktop build (one that does not know `offline_coverage`) against the current backend
 * while a paid renewal with identical entitlements is scheduled. Run it with the app built from the pre-Phase-4 desktop
 * commit (see the release notes for how); it also passes against current builds.
 *
 * The current period ends ~2 minutes ahead but keeps a one-day grace (labelled precondition), so the old client's own
 * access decision would still allow selling past the boundary ("grace"). What must stop it is what stopped it before
 * Phase 4: the authority and the catalog the server issued it end with the current period.
 *
 * 1. The old client validates and bootstraps: it is given no extended window.
 * 2. A representative newer licence response that carries `subscription.offline_coverage` (injected by the proxy) is
 *    parsed and installed as before; the unknown block is not used.
 * 3. Offline past the boundary, a sale is refused and nothing is committed.
 */

const COLA = '6221000000011'
const WATER = '6221000000028'

const toMs = (value) =>
  Date.parse(String(value).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? '' : 'Z'))

function local(session) {
  const one = (sql) => queryLocal(session.profileDir, sql)[0]
  const status = one('SELECT details_json FROM license_state_metadata WHERE id = 1')
  const parsed = status?.details_json ? JSON.parse(status.details_json) : null
  return {
    invoices: one('SELECT COUNT(*) AS n FROM local_invoices').n,
    validatedAt: parsed?.validatedAt ?? null,
    subscription: parsed?.subscription ?? null,
    catalogValidUntil: one('SELECT valid_until FROM catalog_metadata WHERE id = 1')?.valid_until,
    authorityNotAfter: queryLocal(
      session.profileDir,
      'SELECT not_after FROM offline_sale_authorities ORDER BY issued_at DESC LIMIT 1'
    )[0]?.not_after
  }
}

async function exactCashOutcome(ctx, page, label) {
  await page.keyboard.press('F9')
  await page.getByRole('dialog').waitFor({ timeout: 15_000 })
  await page.waitForTimeout(400)
  await page.keyboard.press('Shift+F9')
  await page.waitForFunction(
    () => {
      const s = document
        .querySelector('#app')
        .__vue_app__.config.globalProperties.$pinia._s.get('payment')
      return s && s.completionPending !== true && s.completionOutcome !== null
    },
    null,
    { timeout: 45_000 }
  )
  await page.waitForTimeout(500)
  await ctx.shot(page, label)
  return await page.evaluate(() =>
    JSON.parse(
      JSON.stringify(
        document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('payment')
          .completionOutcome
      )
    )
  )
}

export async function run(ctx) {
  const session = await openSandboxAndApp(ctx, {
    flags: { POS_OFFLINE_PHYSICAL_PRESENCE_ENABLED: 'true' },
    proxy: true
  })
  const { sandbox, proxy, page } = session
  try {
    const deviceUuid = await setupPhysicalPresenceTill(ctx, session)
    await scan(ctx, page, COLA)
    await payExactCash(ctx, page)
    await page.keyboard.press('F9')
    await waitForServerInvoices(sandbox, deviceUuid, 1)

    const end = sandbox.fixture('subscription-end-soon', '140:86400')
    ctx.step('current period ends soon, one-day grace (labelled precondition)', end)
    const renewal = sandbox.fixture('subscription-request')
    ctx.step('identical same-plan renewal approved, paid, scheduled', renewal)
    if (renewal.outcome !== 'scheduled') throw new Error('expected a scheduled renewal')

    // 1. Validation and bootstrap as the old client sends them.
    await refreshWorkstation(ctx, page)
    const inspect = sandbox.fixture('inspect-subscription')
    const first = local(session)
    ctx.step('after the old client validated', { coverage: inspect.coverage, local: first })
    if (toMs(first.authorityNotAfter) !== toMs(end.expires_at))
      throw new Error(
        `the old client was given authority past the current end: ${first.authorityNotAfter}`
      )
    if (toMs(first.catalogValidUntil) !== toMs(end.expires_at))
      throw new Error(
        `the old client was given a catalog past the current end: ${first.catalogValidUntil}`
      )

    // 2. A representative newer response carrying offline_coverage parses and installs as before.
    proxy.rule('inject-offline-coverage', /^POST \/api\/v1\/desktop\/license\/validate/, {
      transformBody(text) {
        try {
          const body = JSON.parse(text)
          if (body?.data?.subscription) {
            body.data.subscription.offline_coverage = {
              renewal_id: '00000000-0000-4000-8000-00000000c0de',
              starts_at: new Date(toMs(end.expires_at)).toISOString(),
              expires_at: new Date(toMs(renewal.expires_at)).toISOString(),
              grace_ends_at: new Date(toMs(renewal.expires_at) + 7 * 86_400_000).toISOString()
            }
          }
          return JSON.stringify(body)
        } catch {
          return text
        }
      }
    })
    await page.waitForTimeout(1_100)
    const outcome = await refreshWorkstation(ctx, page)
    const second = local(session)
    ctx.step('after a licence response carrying offline_coverage', { outcome, local: second })
    if (
      second.validatedAt === first.validatedAt ||
      toMs(second.validatedAt) <= toMs(first.validatedAt)
    )
      throw new Error('the licence carrying offline_coverage was not installed')
    if (toMs(second.subscription?.graceEndsAt) !== toMs(end.grace_ends_at))
      throw new Error('the installed licence does not keep the current period')

    // 3. Offline past the old boundary (current period still in grace): refused, nothing committed.
    await proxy.offline()
    await page.evaluate(async () => await window.posApi.connectivity.checkNow())
    const wait = toMs(end.expires_at) - Date.now() + 3_000
    ctx.step('waiting for the old period end (offline)', { seconds: Math.round(wait / 1000) })
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    const access = await page.evaluate(async () => await window.posApi.license.getAccess())
    const readiness = await page.evaluate(
      async () => await window.posApi.offlineSale.getReadiness()
    )
    ctx.step('past the old boundary, offline', {
      access: access?.data?.sell,
      readiness: readiness?.data
    })
    let added = true
    try {
      await scan(ctx, page, WATER)
    } catch {
      added = false
    }
    const refused = added ? await exactCashOutcome(ctx, page, '01-old-client-past-boundary') : null
    if (!added) await ctx.shot(page, '01-old-client-past-boundary')
    ctx.step('sale attempt past the old boundary', { itemAdded: added, outcome: refused })
    if (refused?.outcome === 'committed')
      throw new Error('the old client sold past the current period end under an extended window')
    if (local(session).invoices !== 1) throw new Error('something was committed past the boundary')
    ctx.step('done', { local: local(session) })
  } finally {
    await sandbox.stop()
  }
}
