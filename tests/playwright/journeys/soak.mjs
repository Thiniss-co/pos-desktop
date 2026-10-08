import { t } from '../support/app.mjs'
import {
  activate,
  deviceUuid,
  openSandboxAndApp,
  openShift,
  refreshWorkstation,
  signIn,
  signOutViaMenu,
  waitForRoute,
  waitForServerInvoices
} from '../support/journey.mjs'
import { queryLocal } from '../support/localDb.mjs'

/**
 * V1 closeout — scale and endurance on the real app against a disposable backend.
 *
 *  A. Large catalog: BULK products created through the owner product path, installed by the till;
 *     catalog search and barcode lookup latency measured over the IPC the page uses.
 *  B. Sustained scanner: SCANS keyboard-wedge bursts over LINES distinct products, no waits between
 *     them except the page's own serialisation; every scan lands, in order, with the right quantity;
 *     the long cart sells and uploads as one invoice.
 *  C. The checkout line limit: the 101st distinct line is refused at the scan with CART_LINE_LIMIT
 *     (a clear message, not a generic invalid request at checkout); the 100-line cart is kept.
 *  D. Endurance: CYCLES × (scan, exact cash, sign out, sign in). Renderer event listeners, DOM nodes
 *     and heap (after GC), and main-process active timers/handles and listener counts are compared
 *     between cycle WARMUP and the last cycle: steady state, no per-cycle growth.
 */
const BULK = 2000
const LINES = 50
const SCANS = 150
const CYCLES = 12
const WARMUP = 3

const bulkBarcode = (index) => `6293${String(index).padStart(9, '0')}`

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

async function cartLines(page) {
  return await page.evaluate(() =>
    document
      .querySelector('#app')
      .__vue_app__.config.globalProperties.$pinia._s.get('cart')
      .lines.map((line) => [line.product.name, line.quantity])
  )
}

async function burst(page, code) {
  await page.keyboard.type(code, { delay: 2 })
  await page.keyboard.press('Enter')
}

async function blur(page) {
  await page.evaluate(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement && active !== document.body) active.blur()
  })
}

async function exactCashAndNewSale(page) {
  await blur(page)
  await page.keyboard.press('Shift+F9')
  const newSale = page
    .getByRole('dialog')
    .getByRole('button', { name: new RegExp(await t(page, 'pos.tender.newSale')) })
  await newSale.waitFor({ timeout: 60_000 })
  await newSale.click()
}

async function metrics(session, cdp) {
  await cdp.send('HeapProfiler.collectGarbage')
  const renderer = Object.fromEntries(
    (await cdp.send('Performance.getMetrics')).metrics.map((metric) => [metric.name, metric.value])
  )
  const main = await session.app.evaluate(({ app, powerMonitor, ipcMain }) => {
    const resources = {}
    for (const type of process.getActiveResourcesInfo())
      resources[type] = (resources[type] ?? 0) + 1
    return {
      resources,
      heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1048576),
      listeners: {
        powerMonitor: powerMonitor
          .eventNames()
          .reduce((sum, name) => sum + powerMonitor.listenerCount(name), 0),
        app: app.eventNames().reduce((sum, name) => sum + app.listenerCount(name), 0),
        ipcMain: ipcMain.eventNames().reduce((sum, name) => sum + ipcMain.listenerCount(name), 0)
      }
    }
  })
  return {
    rendererListeners: renderer.JSEventListeners,
    rendererNodes: renderer.Nodes,
    rendererDocuments: renderer.Documents,
    rendererHeapMb: Math.round(renderer.JSHeapUsedSize / 1048576),
    main
  }
}

export async function run(ctx) {
  const session = await openSandboxAndApp(ctx)
  const { sandbox } = session
  try {
    // A. Large catalog.
    const bulk = sandbox.fixture('create-bulk-products', String(BULK))
    ctx.step('A: bulk products created on the server', bulk)
    const page = session.page
    await activate(ctx, page)
    await signIn(ctx, page)
    await waitForRoute(page, 'pos')
    const device = await deviceUuid(sandbox)
    sandbox.fixture('assign-device', device)
    const installStarted = Date.now()
    await refreshWorkstation(ctx, page)
    const installSeconds = (Date.now() - installStarted) / 1000
    const status = await page.evaluate(async () => (await window.posApi.catalog.getStatus()).data)
    const lookups = []
    for (const index of [1, 250, 500, 999, 1500, 1999, BULK]) {
      const started = performance.now()
      const answer = await page.evaluate(
        async (barcode) => await window.posApi.catalog.findProductByBarcode({ barcode }),
        bulkBarcode(index)
      )
      lookups.push(performance.now() - started)
      if (!answer.ok || answer.data.outcome !== 'found')
        throw new Error(`A: bulk barcode ${index} not found: ${JSON.stringify(answer)}`)
    }
    const searches = []
    for (const query of ['Bulk item 1999', 'Bulk item 0', 'item 15', 'zzz-no-match']) {
      const started = performance.now()
      const answer = await page.evaluate(
        async (q) => await window.posApi.catalog.searchProducts({ query: q, limit: 50 }),
        query
      )
      searches.push(performance.now() - started)
      if (!answer.ok) throw new Error(`A: search "${query}" failed`)
    }
    const catalogFacts = {
      installSeconds,
      counts: status?.counts ?? null,
      lookupMs: { p50: percentile(lookups, 50), max: Math.max(...lookups) },
      searchMs: { p50: percentile(searches, 50), max: Math.max(...searches) }
    }
    ctx.step('A: large catalog installed and searchable', catalogFacts)
    if (Math.max(...lookups) > 1000 || Math.max(...searches) > 1000)
      throw new Error('A: a catalog read took over a second')

    await openShift(ctx, page)

    // B. Sustained scanner, long cart.
    await blur(page)
    const scanStarted = Date.now()
    for (let scan = 0; scan < SCANS; scan += 1) {
      await burst(page, bulkBarcode((scan % LINES) + 1))
    }
    await page.waitForFunction(
      ([lines, perLine]) => {
        const cart = document
          .querySelector('#app')
          .__vue_app__.config.globalProperties.$pinia._s.get('cart')
        return (
          cart.lines.length === lines &&
          cart.lines.every((line) => Number(line.quantity) === perLine)
        )
      },
      [LINES, SCANS / LINES],
      { timeout: 120_000 }
    )
    const scanSeconds = (Date.now() - scanStarted) / 1000
    const lines = await cartLines(page)
    const inOrder = lines.every(([name], index) =>
      name.endsWith(String(index + 1).padStart(4, '0'))
    )
    ctx.step('B: sustained scanning', { scans: SCANS, lines: lines.length, scanSeconds, inOrder })
    if (!inOrder) throw new Error('B: scans did not land in scan order')
    await ctx.shot(page, 'B1-long-cart')
    await exactCashAndNewSale(page)
    await waitForServerInvoices(sandbox, device, 1, 120_000)
    const [longSale] = queryLocal(
      session.profileDir,
      `SELECT i.local_uuid, i.sync_status, (SELECT COUNT(*) FROM local_invoice_items it
          WHERE it.invoice_local_uuid = i.local_uuid) AS items
         FROM local_invoices i ORDER BY i.created_at DESC LIMIT 1`
    )
    ctx.step('B: long cart sold and uploaded', longSale)
    if (longSale.items !== LINES) throw new Error('B: the uploaded sale lost lines')

    // C. The checkout line limit: the 101st distinct line is refused at the scan, clearly, and the
    //    100-line cart is kept.
    const limitMessage = await t(page, 'pos.errors.CART_LINE_LIMIT')
    const [{ before }] = queryLocal(
      session.profileDir,
      'SELECT COUNT(*) AS before FROM local_invoices'
    )
    await blur(page)
    for (let index = 1; index <= 101; index += 1) await burst(page, bulkBarcode(index))
    const refusal = await page
      .waitForFunction(
        (message) =>
          [...document.querySelectorAll('.scan-entry__result')]
            .map((element) => element.textContent?.replace(/\s+/g, ' ').trim() ?? '')
            .find((text) => text.includes(message)) ?? null,
        limitMessage,
        { timeout: 120_000 }
      )
      .then((handle) => handle.jsonValue())
    await ctx.shot(page, 'C1-cart-line-limit')
    const [{ after }] = queryLocal(
      session.profileDir,
      'SELECT COUNT(*) AS after FROM local_invoices'
    )
    const kept = (await cartLines(page)).length
    ctx.step('C: 101st distinct line', { refusal, salesBefore: before, salesAfter: after, kept })
    if (after !== before) throw new Error('C: a sale was committed while testing the line limit')
    if (kept !== 100) throw new Error(`C: expected the 100-line cart to be kept, got ${kept}`)
    await page.keyboard.press('Escape')
    await page.evaluate(() =>
      document
        .querySelector('#app')
        .__vue_app__.config.globalProperties.$pinia._s.get('cart')
        .clear?.()
    )

    // D. Endurance.
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Performance.enable')
    const samples = []
    for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
      await blur(page)
      await burst(page, bulkBarcode(cycle))
      await page.waitForFunction(
        () =>
          document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('cart')
            .lines.length === 1,
        null,
        { timeout: 30_000 }
      )
      await exactCashAndNewSale(page)
      await signOutViaMenu(ctx, page)
      await signIn(ctx, page)
      await waitForRoute(page, 'pos')
      await page.waitForTimeout(0)
      if (cycle === WARMUP || cycle === CYCLES)
        samples.push({ cycle, ...(await metrics(session, cdp)) })
    }
    const [warm, last] = samples
    ctx.step('D: endurance', { warm, last })
    const growth = {
      rendererListeners: last.rendererListeners - warm.rendererListeners,
      rendererNodes: last.rendererNodes - warm.rendererNodes,
      rendererDocuments: last.rendererDocuments - warm.rendererDocuments,
      rendererHeapPct: Math.round(
        ((last.rendererHeapMb - warm.rendererHeapMb) / warm.rendererHeapMb) * 100
      ),
      mainTimeouts: (last.main.resources.Timeout ?? 0) - (warm.main.resources.Timeout ?? 0),
      mainListeners:
        last.main.listeners.powerMonitor +
        last.main.listeners.app +
        last.main.listeners.ipcMain -
        (warm.main.listeners.powerMonitor + warm.main.listeners.app + warm.main.listeners.ipcMain)
    }
    ctx.step('D: growth from cycle 3 to cycle 12', growth)
    if (growth.mainListeners > 0) throw new Error('D: main-process listeners grow per cycle')
    if (growth.mainTimeouts > 2) throw new Error('D: main-process timers grow per cycle')
    if (growth.rendererDocuments > 0) throw new Error('D: renderer documents grow per cycle')
    if (growth.rendererListeners > 50) throw new Error('D: renderer event listeners grow per cycle')
    if (growth.rendererHeapPct > 25) throw new Error('D: renderer heap grows by more than 25%')
  } finally {
    await session.app.close().catch(() => undefined)
    await sandbox.stop()
  }
}
