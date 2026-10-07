import {
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
import { t } from '../support/app.mjs'
import { queryLocal } from '../support/localDb.mjs'

/**
 * Platform Phase 4 closeout (O-7) — offline selling across a paid, scheduled renewal, in the real app against the real
 * backend (contract: pos-backend docs/architecture/subscriptions-devices-licensing.md, "Offline authority across a
 * scheduled renewal"). Offline limits stay disabled throughout.
 *
 * The period boundary is placed a little more than two minutes ahead by a labelled precondition (`subscription-end-soon`,
 * no grace) and then crossed in REAL time, so the till and the server agree on it — an offline sale after it is a sale in
 * the renewal period on both sides. The isolated main-process clock shift (test only) is used last, to look beyond the
 * covered month.
 *
 * A. Incompatible: the plan is edited in place (one more register) before a same-plan renewal is paid and scheduled. The
 *    till validates while online and is told nothing extra: authority and catalog end with the current period. Offline
 *    past the boundary the sale is refused (`access-denied`, the till's own decision), nothing is committed; online again
 *    after the renewal started, the same draft is refreshed, reviewed and paid once.
 * B. Compatible: the (now current) period is renewed with identical entitlements, paid and scheduled. The till validates
 *    and gets authority, catalog and local coverage through the renewal's end; it restarts offline and keeps them; past
 *    the boundary it sells offline; reconnected, that sale uploads exactly once, under the covered authority.
 * C. Beyond the covered window (main clock moved): at the renewal end the authority has expired and selling stops.
 */

const COLA = '6221000000011'
const WATER = '6221000000028'
const BOUNDARY_SECONDS = 140

const store = (page, id, expression) =>
  page.evaluate(
    ([storeId, expr]) =>
      new Function('s', `return (${expr})`)(
        document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get(storeId)
      ),
    [id, expression]
  )

const toMs = (value) =>
  Date.parse(String(value).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? '' : 'Z'))

/** Shift the MAIN process wall clock (an isolated test clock; the renderer and the server keep real time). */
async function shiftMainClock(app, offsetMs) {
  await app.evaluate((_electron, offset) => {
    if (!globalThis.__posRealDate) {
      const Real = Date
      globalThis.__posRealDate = Real
      class Shifted extends Real {
        constructor(...args) {
          if (args.length === 0) super(Real.now() + (globalThis.__posDateOffset ?? 0))
          else super(...args)
        }
        static now() {
          return Real.now() + (globalThis.__posDateOffset ?? 0)
        }
      }
      Shifted.parse = Real.parse
      Shifted.UTC = Real.UTC
      globalThis.Date = Shifted
    }
    globalThis.__posDateOffset = offset
  }, offsetMs)
}

function localState(session) {
  const one = (sql) => queryLocal(session.profileDir, sql)[0]
  const status = one('SELECT details_json FROM license_state_metadata WHERE id = 1')
  return {
    invoices: one('SELECT COUNT(*) AS n FROM local_invoices').n,
    coverage: status?.details_json
      ? (JSON.parse(status.details_json).subscription?.offlineCoverage ?? null)
      : null,
    authorities: queryLocal(
      session.profileDir,
      'SELECT authority_uuid, not_after FROM offline_sale_authorities ORDER BY issued_at'
    ),
    catalogValidUntil:
      queryLocal(session.profileDir, 'SELECT valid_until FROM catalog_metadata WHERE id = 1')[0]
        ?.valid_until ?? null
  }
}

const liveAuthority = (inspect) =>
  inspect.authorities.filter((a) => a.superseded_at === null && a.revoked_at === null).at(-1)

async function access(page) {
  const result = await page.evaluate(async () => await window.posApi.license.getAccess())
  return result?.data?.sell ?? result
}

async function goOffline(proxy, page) {
  await proxy.offline()
  await page.evaluate(async () => await window.posApi.connectivity.checkNow())
}

async function goOnline(proxy, page) {
  await proxy.online()
  await page.evaluate(async () => await window.posApi.connectivity.checkNow())
}

async function waitPast(ctx, instant, label) {
  const wait = toMs(instant) - Date.now() + 3_000
  ctx.step(`waiting for ${label}`, { instant, seconds: Math.max(0, Math.round(wait / 1000)) })
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
}

/** Observation only: every `payment.complete` and its settled outcome. */
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
      })
    })
  })
}

async function exactCash(ctx, page, label) {
  const before = await page.evaluate(() => (window.__pwCompletions ?? []).length)
  await page.keyboard.press('F9')
  await page.getByRole('dialog').waitFor({ timeout: 15_000 })
  await page.waitForTimeout(400)
  await page.keyboard.press('Shift+F9')
  const deadline = Date.now() + 45_000
  for (;;) {
    const list = (await page.evaluate(() => window.__pwCompletions ?? [])).slice(before)
    if (list.length > 0 && list.every((entry) => entry.settled)) {
      await page.waitForTimeout(500)
      await ctx.shot(page, label)
      const outcome = list[0].outcome
      ctx.step(`${label}: exact cash settled`, {
        outcome: outcome?.outcome,
        code: outcome?.code ?? outcome?.failureCode ?? null,
        soldAt: outcome?.invoice?.soldAt ?? null,
        authority: outcome?.invoice?.offlineSaleAuthorityUuid ?? null
      })
      return outcome
    }
    if (Date.now() > deadline) throw new Error(`${label}: exact cash submitted nothing`)
    await page.waitForTimeout(100)
  }
}

/** The header refresh with a draft in the cart: consent, then the normal review/rebuild of the kept draft. */
async function refreshAndReview(ctx, page, label) {
  await store(page, 'workstationRefresh', 's.dismissMessage() || true')
  await page.locator('[data-testid="workstation-refresh"]:visible').first().click()
  const consent = await t(page, 'shell.workstationRefresh.consentConfirm')
  const deadline = Date.now() + 90_000
  let consented = false
  for (;;) {
    const s = await store(
      page,
      'workstationRefresh',
      '({ status: s.status, lastMessage: s.lastMessage })'
    )
    if (s.status === 'confirming' && !consented) {
      await page.getByRole('button', { name: consent }).click()
      consented = true
    } else if (s.status === 'idle' && s.lastMessage !== null) {
      ctx.step(`${label}: refresh`, { outcome: s.lastMessage, consented })
      break
    }
    if (Date.now() > deadline) throw new Error(`${label}: refresh did not settle`)
    await page.waitForTimeout(250)
  }
  const updating = await t(page, 'shell.workstationRefresh.updating')
  await page.waitForFunction((text) => !document.body.innerText.includes(text), updating, {
    timeout: 90_000
  })
  if (await store(page, 'cart', 's.catalogChanged')) {
    await page
      .getByRole('button', { name: await t(page, 'pos.rebuildCart') })
      .first()
      .click()
    const dialog = page.getByRole('dialog').filter({ hasText: await t(page, 'pos.dialog.rebuild') })
    await dialog.waitFor({ timeout: 15_000 })
    await dialog.getByRole('button', { name: await t(page, 'pos.rebuildCart') }).click()
    await page.waitForFunction(
      () =>
        document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('cart')
          .catalogChanged === false,
      null,
      { timeout: 15_000 }
    )
    ctx.step(`${label}: kept draft reviewed and rebuilt`)
  }
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
    if (sandbox.fixture('inspect-subscription').offline_limits_enforced !== false)
      throw new Error('offline limits are enforced in this run')
    await watchCompletions(page)
    await scan(ctx, page, COLA)
    await payExactCash(ctx, page)
    await page.keyboard.press('F9')
    await waitForServerInvoices(sandbox, deviceUuid, 1)

    // ---- A. Incompatible renewal: the current boundary is kept --------------------------------------------------
    const endA = sandbox.fixture('subscription-end-soon', String(BOUNDARY_SECONDS))
    ctx.step('A: current period ends soon (labelled precondition, no grace)', endA)
    ctx.step('A: plan edited in place for future requests', sandbox.fixture('plan-capacity-change'))
    const renewalA = sandbox.fixture('subscription-request')
    ctx.step('A: same-plan renewal approved, paid, scheduled', renewalA)
    if (!renewalA.activated || renewalA.outcome !== 'scheduled')
      throw new Error(`A: expected a scheduled renewal: ${JSON.stringify(renewalA)}`)
    await refreshWorkstation(ctx, page)
    const inspectA = sandbox.fixture('inspect-subscription')
    const authorityA = liveAuthority(inspectA)
    const localA = localState(session)
    ctx.step('A: after validation', {
      coverage: inspectA.coverage,
      authority: authorityA,
      local: localA
    })
    if (inspectA.coverage?.outcome !== 'entitlements_differ')
      throw new Error(`A: expected entitlements_differ: ${JSON.stringify(inspectA.coverage)}`)
    if (toMs(authorityA.not_after) !== toMs(endA.expires_at))
      throw new Error('A: the authority does not end with the current period')
    if (localA.coverage !== null) throw new Error('A: the till was told about a coverage')
    if (toMs(localA.catalogValidUntil) !== toMs(endA.expires_at))
      throw new Error('A: the catalog does not end with the current period')

    await goOffline(proxy, page)
    await scan(ctx, page, WATER)
    await waitPast(ctx, endA.expires_at, 'A: the old period end (offline)')
    ctx.step('A: access past the boundary, offline', { access: await access(page) })
    const refusedA = await exactCash(ctx, page, 'A1-offline-refused-incompatible')
    if (refusedA?.outcome !== 'failed' || refusedA.code !== 'access-denied')
      throw new Error(
        `A: expected the refusal contract (access-denied): ${JSON.stringify(refusedA)}`
      )
    if (localState(session).invoices !== 1) throw new Error('A: the refusal committed a sale')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)

    await goOnline(proxy, page)
    await refreshAndReview(ctx, page, 'A2-online-after-renewal-started')
    const recovered = await exactCash(ctx, page, 'A3-same-draft-paid-online')
    if (recovered?.outcome !== 'committed') throw new Error('A: the kept draft was not paid')
    await page.keyboard.press('F9')
    await waitForServerInvoices(sandbox, deviceUuid, 2)

    // ---- B. Compatible renewal: authority, catalog and local access run through it -----------------------------
    const endB = sandbox.fixture('subscription-end-soon', String(BOUNDARY_SECONDS))
    ctx.step('B: current period ends soon (labelled precondition, no grace)', endB)
    const renewalB = sandbox.fixture('subscription-request')
    ctx.step('B: same-plan renewal approved, paid, scheduled', renewalB)
    if (!renewalB.activated || renewalB.outcome !== 'scheduled')
      throw new Error(`B: expected a scheduled renewal: ${JSON.stringify(renewalB)}`)
    await refreshWorkstation(ctx, page)
    const inspectB = sandbox.fixture('inspect-subscription')
    const authorityB = liveAuthority(inspectB)
    const localB = localState(session)
    ctx.step('B: after validation', {
      coverage: inspectB.coverage,
      authority: authorityB,
      local: localB
    })
    if (inspectB.coverage?.outcome !== 'covered') throw new Error('B: expected a covered renewal')
    if (toMs(authorityB.not_after) !== toMs(renewalB.expires_at))
      throw new Error('B: the authority does not run to the renewal end')
    if (toMs(localB.coverage?.expiresAt) !== toMs(renewalB.expires_at))
      throw new Error('B: the till did not store the coverage')
    if (toMs(localB.catalogValidUntil) !== toMs(renewalB.expires_at))
      throw new Error('B: the catalog does not run to the renewal end')
    if (!localB.authorities.some((a) => a.authority_uuid === authorityB.uuid))
      throw new Error('B: the covered authority is not stored on the till')
    await ctx.shot(page, 'B1-covered-online')

    // Restart offline: everything issued survives and is read back from the device.
    await goOffline(proxy, page)
    await relaunch(ctx, session)
    page = session.page
    await waitForRoute(page, 'pos')
    await watchCompletions(page)
    const afterRestart = localState(session)
    ctx.step('B: after an offline restart', { local: afterRestart, access: await access(page) })
    if (toMs(afterRestart.coverage?.expiresAt) !== toMs(renewalB.expires_at))
      throw new Error('B: the coverage did not survive the restart')

    await waitPast(ctx, endB.expires_at, 'B: the old period end (offline)')
    const accessB = await access(page)
    const readinessB = await readiness(page)
    ctx.step('B: past the old boundary, offline', { access: accessB, readiness: readinessB })
    if (accessB?.allowed !== true) throw new Error('B: the till stopped at the old boundary')
    await scan(ctx, page, COLA)
    const offlineSale = await exactCash(ctx, page, 'B2-offline-sale-in-renewal')
    if (offlineSale?.outcome !== 'committed')
      throw new Error(`B: the offline sale failed: ${JSON.stringify(offlineSale)}`)
    if (toMs(offlineSale.invoice.soldAt) <= toMs(endB.expires_at))
      throw new Error('B: the offline sale was not rung after the old boundary')
    if (offlineSale.invoice.offlineSaleAuthorityUuid !== authorityB.uuid)
      throw new Error('B: the offline sale does not name the covered authority')
    await page.keyboard.press('F9')
    if (localState(session).invoices !== 3) throw new Error('B: expected exactly three local sales')

    // Reconnect: the renewal is now the effective subscription; the sale uploads exactly once.
    await goOnline(proxy, page)
    const report = await waitForServerInvoices(sandbox, deviceUuid, 3, 120_000)
    const uploaded = report.invoices[offlineSale.invoice.localUuid]
    ctx.step('B: uploaded after reconnecting', {
      uploaded,
      current: sandbox.fixture('inspect-subscription').current
    })
    if (!uploaded || uploaded.sync_records !== 1 || uploaded.server_invoices !== 1)
      throw new Error(
        `B: the offline sale was not recorded exactly once: ${JSON.stringify(uploaded)}`
      )
    if (uploaded.authority[0] !== authorityB.uuid || uploaded.sold_while_offline[0] !== true)
      throw new Error('B: the server did not accept the sale under the covered authority')
    await page.waitForTimeout(3_000)
    if (
      sandbox.fixture('report', deviceUuid).invoices[offlineSale.invoice.localUuid].sync_records !==
      1
    )
      throw new Error('B: the sale was uploaded twice')

    // ---- C. Beyond the covered window (isolated main-process clock) ---------------------------------------------
    await goOffline(proxy, page)
    const renewalEnd = toMs(renewalB.expires_at)
    await shiftMainClock(session.app, renewalEnd - 60_000 - Date.now())
    const beforeEnd = { access: await access(page), readiness: await readiness(page) }
    await shiftMainClock(session.app, renewalEnd + 60_000 - Date.now())
    const afterEnd = { access: await access(page), readiness: await readiness(page) }
    ctx.step('C: one minute before and after the covered end (main clock moved)', {
      beforeEnd,
      afterEnd
    })
    if (beforeEnd.access?.allowed !== true || beforeEnd.readiness?.physicalPresenceLapsed !== false)
      throw new Error('C: selling stopped before the covered end')
    // Past the covered end the authority has lapsed and the catalog has expired: the cashier cannot even add an item.
    // (Local access alone would allow the renewal's grace; the authority and catalog windows are the binding bounds.)
    if (
      afterEnd.readiness?.physicalPresenceLapsed !== true ||
      afterEnd.readiness?.authorityUuid !== null
    )
      throw new Error('C: the authority did not lapse at the covered end')
    let itemAdded = true
    try {
      await scan(ctx, page, WATER)
    } catch {
      itemAdded = false
    }
    await ctx.shot(page, 'C1-beyond-covered-window')
    if (itemAdded) {
      const beyond = await exactCash(ctx, page, 'C2-beyond-covered-window-payment')
      if (beyond?.outcome === 'committed')
        throw new Error('C: a sale committed beyond the covered window')
    }
    ctx.step('C: beyond the covered end', { itemAdded })
    if (localState(session).invoices !== 3)
      throw new Error('C: something was committed beyond the window')
    await shiftMainClock(session.app, toMs(renewalB.grace_ends_at) + 60_000 - Date.now())
    const afterGrace = await access(page)
    ctx.step('C: after the renewal grace end', { access: afterGrace })
    if (afterGrace?.allowed !== false || afterGrace.reason !== 'grace-ended')
      throw new Error('C: local access outlived the renewal grace')
    ctx.step('done', { local: localState(session) })
  } finally {
    await shiftMainClock(session.app, 0).catch(() => undefined)
    await sandbox.stop()
  }
}
