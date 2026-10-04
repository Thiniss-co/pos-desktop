import {
  deviceUuid as findDevice,
  mainTrace,
  openSandboxAndApp,
  payExactCash,
  scan,
  setupPhysicalPresenceTill,
  waitForRoute,
  waitForServerInvoices
} from '../support/journey.mjs'
import { queryLocal } from '../support/localDb.mjs'

const UP = /GET \/up/

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

function invoices(session) {
  return queryLocal(
    session.profileDir,
    `SELECT i.local_uuid AS invoice, i.sold_at, q.state, q.attempt_count, q.payload_hash
       FROM local_invoices i JOIN sync_queue q ON q.local_aggregate_uuid = i.local_uuid
      ORDER BY q.queue_sequence`
  )
}

async function gotoSync(page) {
  await page.goto(page.url().replace(/#.*$/, '#/sync'))
  await waitForRoute(page, 'sync')
  await page.waitForTimeout(1200)
}

async function gotoPos(page) {
  await page.goto(page.url().replace(/#.*$/, '#/pos'))
  await waitForRoute(page, 'pos')
  await page.waitForTimeout(800)
}

/**
 * Stage 7 (Rev 4 §10.1–10.2), SIMULATED fast clock: main's `Date` runs 90 s ahead of the server.
 * Before this change the v3 upload carried `sold_at` > received + 60 s and was TERMINALLY rejected
 * (`DESKTOP_OFFLINE_SALE_AUTHORITY_INVALID`). Now it is deferred in memory — row, bytes, hash and key
 * untouched — until the server-time lower bound admits it, then accepted exactly once. A simulated
 * suspend/resume drops the sample, and the next deferred item waits for a fresh one.
 */
export async function run(ctx) {
  const session = await openSandboxAndApp(ctx, {
    flags: { POS_OFFLINE_PHYSICAL_PRESENCE_ENABLED: 'true' },
    proxy: true
  })
  const { sandbox, proxy, app } = session
  const page = session.page
  try {
    await setupPhysicalPresenceTill(ctx, session)
    const device = await findDevice(sandbox)

    await shiftMainClock(app, 90_000)
    ctx.step('main-process clock shifted +90 s (simulation)')
    await scan(ctx, page, '6221000000011')
    await payExactCash(ctx, page)
    await page.keyboard.press('F9')
    await page.waitForTimeout(3000)

    const [deferred] = invoices(session)
    const report0 = sandbox.fixture('report', device)
    ctx.step('v3 sale 90 s ahead of the server is deferred, unchanged', {
      local: deferred,
      serverInvoices: report0.device_invoice_count,
      trace: (await mainTrace(session, 'upload-time-deferred')).slice(-2)
    })
    if (deferred.state !== 'pending' || deferred.attempt_count !== 0) {
      throw new Error('the deferred row must be untouched')
    }
    if (report0.device_invoice_count !== 0) throw new Error('nothing may be sent early')
    await gotoSync(page)
    await ctx.shot(page, '01-sync-time-deferred')

    const report1 = await waitForServerInvoices(sandbox, device, 1, 90_000)
    const [sent] = invoices(session)
    ctx.step('accepted exactly once when the server bound admits it', {
      local: sent,
      server: report1.invoices
    })
    if (sent.payload_hash !== deferred.payload_hash || sent.attempt_count !== 1) {
      throw new Error('expected one send of the identical payload')
    }
    const outcome = Object.values(report1.invoices)[0]
    if (outcome.statuses.some((s) => s !== 'processed') || outcome.server_invoices !== 1) {
      throw new Error(`unexpected server outcome ${JSON.stringify(outcome)}`)
    }
    await page.reload()
    await gotoSync(page)
    await ctx.shot(page, '02-sync-uploaded-after-deferral')

    // Suspend/resume (simulated power events in main) invalidates the sample.
    const upBefore = proxy.requests(UP).length
    await app.evaluate(({ powerMonitor }) => {
      powerMonitor.emit('suspend')
      powerMonitor.emit('resume')
    })
    ctx.step('simulated suspend/resume emitted in main')
    await gotoPos(page)
    await scan(ctx, page, '6221000000011')
    await payExactCash(ctx, page)
    await page.keyboard.press('F9')
    const report2 = await waitForServerInvoices(sandbox, device, 2, 120_000)
    const rows = invoices(session)
    ctx.step('after resume: a fresh sample was taken, then the item was sent once', {
      upProbesSinceResume: proxy.requests(UP).length - upBefore,
      local: rows,
      server: report2.invoices
    })
    if (rows.some((row) => row.state !== 'synced' || row.attempt_count !== 1)) {
      throw new Error('every sale must upload exactly once')
    }
    await page.waitForTimeout(1500)
    await ctx.shot(page, '03-after-resume')
  } finally {
    ctx.facts.uploadTrace = session.logs
      .join('')
      .split('\n')
      .filter((line) => line.includes('invoice-upload'))
      .slice(-40)
    await session.app.close().catch(() => undefined)
    await proxy?.stop()
    await sandbox.stop()
  }
}
