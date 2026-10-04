import { t } from '../support/app.mjs'
import {
  MANAGER,
  openSandboxAndApp,
  payExactCash,
  readiness,
  scan,
  setupPhysicalPresenceTill,
  signIn,
  waitForRoute,
  waitForServerInvoices
} from '../support/journey.mjs'
import { queryLocal } from '../support/localDb.mjs'

const VALIDATE = /^POST \/api\/v1\/desktop\/license\/validate/

function localAuthorities(session) {
  return queryLocal(
    session.profileDir,
    'SELECT authority_uuid, warehouse_uuid, not_before, not_after FROM offline_sale_authorities ORDER BY created_at, authority_uuid'
  )
}

async function waitFor(predicate, timeout = 30_000, label = 'condition') {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 300))
  }
}

/**
 * Stage 3 (Rev 4 §7): the license leg carries a warehouse-bound authority (v2), a transient renewal
 * failure leaves the still-valid authority selling, an owner change during a delayed response
 * discards that result entirely, and reconnecting renews without any cashier action.
 */
export async function run(ctx) {
  const session = await openSandboxAndApp(ctx, {
    flags: { POS_OFFLINE_PHYSICAL_PRESENCE_ENABLED: 'true' },
    proxy: true
  })
  const { page, sandbox, proxy } = session
  try {
    const deviceUuid = await setupPhysicalPresenceTill(ctx, session)

    // 1. v2 authority stored with its warehouse.
    const first = await readiness(page)
    const stored = localAuthorities(session)
    ctx.step('authority after setup (local rows)', { readiness: first, stored })
    if (first.mode !== 'physical_presence') throw new Error('expected a usable PP authority')
    if (!stored.every((row) => row.warehouse_uuid))
      throw new Error('authority stored without warehouse')

    // 2. Transient renewal failure: 503 on the next validation; the held authority still sells.
    proxy.rule('503 validate', VALIDATE, { status: 503, code: 'SERVICE_UNAVAILABLE', times: 1 })
    const failed = await page.evaluate(async () => await window.posApi.license.validate())
    ctx.step('renewal attempt answered 503', { ok: failed.ok, error: failed.error?.category })
    const afterFailure = await readiness(page)
    if (
      afterFailure.authorityUuid !== first.authorityUuid ||
      afterFailure.mode !== 'physical_presence'
    ) {
      throw new Error('the still-valid authority stopped being usable after a transient failure')
    }
    await scan(ctx, page, '6221000000011')
    await payExactCash(ctx, page)
    await ctx.shot(page, '01-sale-after-transient-renewal-failure')
    await page.keyboard.press('F9')
    const report = await waitForServerInvoices(sandbox, deviceUuid, 1)
    ctx.step('sale under the older authority uploaded', report)

    // 3. Owner change during a delayed response: the response arrives after sign-out and a
    //    different sign-in, so NOTHING from it may be written.
    proxy.rule('slow validate', VALIDATE, { delayResponseMs: 6000, times: 1 })
    const serverBefore = sandbox.fixture('authorities').authorities.map((a) => a.uuid)
    await page.evaluate(() => {
      window.__slowValidate = window.posApi.license.validate()
    })
    await waitFor(
      () => sandbox.fixture('authorities').authorities.length > serverBefore.length,
      15_000,
      'the delayed validation to be issued server-side'
    )
    const delayedIssued = sandbox
      .fixture('authorities')
      .authorities.map((a) => a.uuid)
      .filter((uuid) => !serverBefore.includes(uuid))
    ctx.step('server issued the delayed validation authority', { delayedIssued })

    await page.getByRole('button', { name: await t(page, 'shell.user.menuLabel') }).click()
    await page.getByRole('menuitem', { name: await t(page, 'common.signOut') }).click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: await t(page, 'common.signOut') })
      .click()
    await waitForRoute(page, 'login')
    ctx.step('signed out while the validation response was delayed')
    await signIn(ctx, page, MANAGER)
    await waitForRoute(page, 'pos')
    const slow = await page.evaluate(async () => await window.__slowValidate)
    ctx.step('delayed validation settled after the owner changed', {
      ok: slow.ok,
      error: slow.error?.message
    })
    await waitFor(() => true, 2000)
    const localAfter = localAuthorities(session).map((row) => row.authority_uuid)
    ctx.step('local authorities after owner change', { localAfter, delayedIssued })
    for (const uuid of delayedIssued) {
      if (localAfter.includes(uuid)) {
        throw new Error(`the delayed result ${uuid} was written although the owner changed`)
      }
    }

    // 4. Reconnect renews automatically.
    const countBefore = sandbox.fixture('authorities').authorities.length
    await proxy.offline()
    await page.evaluate(async () => await window.posApi.connectivity.checkNow())
    ctx.step('proxy offline; connectivity re-checked')
    await proxy.online()
    await page.evaluate(async () => await window.posApi.connectivity.checkNow())
    await waitFor(
      () => sandbox.fixture('authorities').authorities.length > countBefore,
      30_000,
      'an automatic renewal after reconnect'
    )
    const renewed = await waitFor(async () => {
      const r = await readiness(page)
      return r.mode === 'physical_presence' ? r : null
    })
    ctx.step('renewed after reconnect without cashier action', {
      validations: proxy.requests(VALIDATE).length,
      readiness: renewed
    })
    await ctx.shot(page, '02-after-reconnect-renewal')
  } finally {
    ctx.facts.renewalTrace = session.logs
      .join('')
      .split('\n')
      .filter((l) => l.includes('pos-renewal') || l.includes('license/validate'))
      .slice(-60)
    await session.app.close().catch(() => undefined)
    await proxy?.stop()
    await sandbox.stop()
  }
}
