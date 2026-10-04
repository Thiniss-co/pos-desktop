import { t } from '../support/app.mjs'
import {
  activate,
  deviceUuid as findDevice,
  openSandboxAndApp,
  openShift,
  payExactCash,
  readiness,
  refreshWorkstation,
  scan,
  signIn,
  sizeWindow,
  waitForRoute,
  waitForServerInvoices
} from '../support/journey.mjs'
import { queryLocal } from '../support/localDb.mjs'

const NO_DEADLINE = Date.parse('2038-01-19T00:00:00Z')

/** Shift the MAIN process wall clock (simulation; the renderer and the server keep real time). */
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

async function cards(page) {
  return await page.evaluate(() =>
    [...document.querySelectorAll('.product-card-frame')].map((frame) => ({
      name: frame.querySelector('.product-card__name')?.textContent?.trim(),
      disabled: frame.querySelector('button.product-card')?.disabled === true,
      dimmed: frame.querySelector('.opacity-60') !== null,
      chip: frame.querySelector('.app-status-chip')?.textContent?.trim()
    }))
  )
}

function invoices(session) {
  return queryLocal(
    session.profileDir,
    `SELECT i.local_uuid AS invoice, i.stock_authorization_policy AS policy, q.state, q.attempt_count
       FROM local_invoices i JOIN sync_queue q ON q.local_aggregate_uuid = i.local_uuid
      ORDER BY q.queue_sequence`
  )
}

async function sell(ctx, page, code) {
  await scan(ctx, page, code)
  await payExactCash(ctx, page)
  await page.keyboard.press('F9')
  await page.waitForTimeout(600)
}

/**
 * The reported real-till situation, with NO offline-sale policy fixture at all: the seeded warehouse
 * gets the default physical-presence policy, and the backend runs with its shipped configuration
 * (PP on, offline time limits off). A new owner product ("test2") and a zero-stock product sell
 * offline; tracked cards and scans are never disabled by stock; the licence, catalog and authority
 * carry no offline deadline; four simulated days offline still sell.
 */
export async function run(ctx) {
  const session = await openSandboxAndApp(ctx, { proxy: true })
  const { sandbox, proxy, app } = session
  const page = session.page
  try {
    ctx.step('WATER-500 recorded stock to 0', sandbox.fixture('adjust-stock', 'WATER-500:200'))
    await sizeWindow(session)
    await activate(ctx, page)
    await signIn(ctx, page)
    await waitForRoute(page, 'pos')
    const device = await findDevice(sandbox)
    sandbox.fixture('assign-device', device)
    await refreshWorkstation(ctx, page)
    await openShift(ctx, page)

    const ready = await readiness(page)
    const license = await page.evaluate(async () => await window.posApi.license.getAccess())
    const catalog = await page.evaluate(async () => await window.posApi.catalog.getStatus())
    const deadlines = {
      mode: ready.mode,
      noTimeLimit: ready.noTimeLimit,
      authorityNotAfter: ready.notAfter,
      nextValidationDueAt: license?.data?.sell?.nextValidationDueAt ?? null,
      catalogValidUntil: catalog?.data?.contract?.validUntil ?? null,
      authorities: sandbox.fixture('authorities')
    }
    ctx.step('default policy, shipped config: PP with no offline deadline', deadlines)
    // Offline limits are off: nothing ends after 72 h. The licence has no offline deadline; the
    // authority and catalog run to the seeded subscription's expiry (about 30 days), which still
    // bounds selling by design.
    if (ready.mode !== 'physical_presence') {
      throw new Error('expected a default physical-presence till')
    }
    if (Date.parse(deadlines.nextValidationDueAt) !== NO_DEADLINE) {
      throw new Error(
        `licence re-validation still has a deadline: ${deadlines.nextValidationDueAt}`
      )
    }
    const minimum = Date.now() + 25 * 24 * 3_600_000
    for (const value of [deadlines.authorityNotAfter, deadlines.catalogValidUntil]) {
      if (!(Date.parse(value) > minimum)) {
        throw new Error(`a short offline deadline is still issued: ${JSON.stringify(deadlines)}`)
      }
    }
    await page.goto(page.url().replace(/#.*$/, '#/offline-stock'))
    await page.waitForTimeout(1200)
    await ctx.shot(page, '01-readiness-no-time-limit')

    // The owner creates "test2"; the till refreshes and it appears.
    ctx.step('owner creates TEST2', sandbox.fixture('create-owner-product', 'TEST2'))
    await page.goto(page.url().replace(/#.*$/, '#/pos'))
    await waitForRoute(page, 'pos')
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await refreshWorkstation(ctx, page)

    // Offline: nothing is disabled by stock; a zero-stock product and the new product sell.
    await proxy.offline()
    await page.waitForTimeout(1500)
    const offlineCards = await cards(page)
    ctx.step('offline cards', offlineCards)
    if (offlineCards.some((card) => card.disabled || card.dimmed)) {
      throw new Error('a card is disabled or dimmed by stock while offline')
    }
    if (offlineCards.some((card) => /reserved/i.test(card.chip ?? ''))) {
      throw new Error('reservation wording shown as a gate')
    }
    await ctx.shot(page, '02-offline-cards-enabled')
    await sell(ctx, page, '6221000000028') // WATER, recorded 0
    await sell(ctx, page, 'OWNTEST2') // created after issue, no stock record
    ctx.step('offline sales committed', { invoices: invoices(session) })

    // Four days offline (simulated main clock): the till still sells.
    await shiftMainClock(app, 4 * 24 * 3_600_000)
    const later = await readiness(page)
    ctx.step('main-process clock +4 days (simulation)', {
      mode: later.mode,
      noTimeLimit: later.noTimeLimit,
      clockUntrusted: later.clockUntrusted
    })
    if (later.mode !== 'physical_presence') throw new Error('authority lapsed after 4 days')
    await sell(ctx, page, '6221000000011')
    const local = invoices(session)
    ctx.step('sale after 4 simulated days committed', { invoices: local })
    if (local.length !== 3 || local.some((row) => row.policy !== 'physical_presence')) {
      throw new Error('expected three physical-presence sales')
    }
    await ctx.shot(page, '03-sold-after-four-days')

    // Reconnect: the two real-time sales upload exactly once. The +4-day sale is correctly held
    // by the send gate (its sold_at is 4 days ahead of the server) — a simulation artifact.
    await proxy.online()
    const report = await waitForServerInvoices(sandbox, device, 2, 90_000)
    const after = invoices(session)
    ctx.step('reconnected', { server: report.invoices, local: after })
    for (const invoice of Object.values(report.invoices)) {
      if (invoice.server_invoices !== 1 || invoice.statuses.some((s) => s !== 'processed')) {
        throw new Error(`unexpected server outcome ${JSON.stringify(invoice)}`)
      }
    }
    const deferred = after[2]
    if (deferred.state !== 'pending' || deferred.attempt_count !== 0) {
      throw new Error('the simulated future sale must stay pending, untouched')
    }
    await page.goto(page.url().replace(/#.*$/, '#/sync'))
    await page.waitForTimeout(1200)
    await ctx.shot(page, '04-sync-after-reconnect')
    void t
  } finally {
    ctx.facts.mainTrace = session.logs
      .join('')
      .split('\n')
      .filter((line) => /bootstrap|license|refresh|renewal|install|error|invalid/i.test(line))
      .slice(-80)
    await session.app.close().catch(() => undefined)
    await proxy?.stop()
    await sandbox.stop()
  }
}
