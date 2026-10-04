import {
  activate,
  deviceUuid as findDevice,
  mainTrace,
  openSandboxAndApp,
  openShift,
  payExactCash,
  refreshWorkstation,
  scan,
  signIn,
  sizeWindow,
  waitForRoute,
  waitForServerInvoices
} from '../support/journey.mjs'
import { queryLocal } from '../support/localDb.mjs'

const UPLOAD = /invoices\/upload/

function chain(session) {
  return queryLocal(
    session.profileDir,
    `SELECT c.invoice_local_uuid AS invoice, c.allocation_uuid AS allocation,
            c.rights_generation AS generation, c.consumption_sequence AS sequence,
            q.state, q.attempt_count, q.queue_sequence
       FROM local_stock_allocation_consumptions c
       JOIN sync_queue q ON q.local_aggregate_uuid = c.invoice_local_uuid
      ORDER BY q.queue_sequence, c.consumption_sequence`
  )
}

function preparedGrant(session) {
  const [row] = queryLocal(
    session.profileDir,
    `SELECT g.allocation_uuid AS allocation, g.granted_quantity_milli AS granted,
            b.accepted_consumption_sequence IS NOT NULL AS covered
       FROM stock_allocation_grants g
       LEFT JOIN stock_allocation_coverage_boundaries b
         ON b.allocation_uuid = g.allocation_uuid AND b.rights_generation = g.rights_generation
      WHERE g.granted_quantity_milli >= 2000 AND g.status = 'active'
      ORDER BY g.received_at DESC LIMIT 1`
  )
  return row ? { ...row, covered: row.covered === 1 } : null
}

function queue(session) {
  return queryLocal(
    session.profileDir,
    `SELECT local_aggregate_uuid AS invoice, state, attempt_count, queue_sequence
       FROM sync_queue WHERE aggregate_type = 'invoice' ORDER BY queue_sequence`
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
 * Stage 7 (Rev 4 §10.3/§10.5): on an allocation-mode warehouse, the upload of consumption N fails
 * transiently (503 + Retry-After through the proxy) while N+1 is already committed. N+1 must NOT be
 * sent first (before this change it was, and the server quarantined it as `allocation_sequence_gap`);
 * it is held unchanged, N retries by its own timer, and both are accepted in order, exactly once.
 * Then: offline selling and reconnect upload exactly once.
 */
export async function run(ctx) {
  const session = await openSandboxAndApp(ctx, {
    flags: { STOCK_ALLOCATION_PREPARATION_ENABLED: 'true' },
    proxy: true
  })
  const { sandbox, proxy } = session
  const page = session.page
  try {
    await sizeWindow(session)
    await activate(ctx, page)
    await signIn(ctx, page)
    await waitForRoute(page, 'pos')
    const device = await findDevice(sandbox)
    sandbox.fixture('assign-device', device)
    ctx.step('allocation-mode warehouse', sandbox.fixture('mode-allocation', 'COLA-CAN'))
    await refreshWorkstation(ctx, page)
    await openShift(ctx, page)

    // 0. One online sale makes COLA a preparation candidate; preparation then grants an advance
    //    allocation, and a refresh installs its coverage boundary, so the next sales share ONE chain.
    await scan(ctx, page, '6221000000011')
    await payExactCash(ctx, page)
    await page.keyboard.press('F9')
    await waitForServerInvoices(sandbox, device, 1)
    const prepared = await page.evaluate(async () => await window.posApi.preparation.runCycle())
    ctx.step('offline stock preparation requested', { ok: prepared.ok })
    // Preparation may first block on the just-uploaded sale and complete on its own trigger; wait
    // for the advance grant, then refresh until bootstrap has installed its coverage boundary.
    let advance = null
    for (let tries = 0; tries < 30 && !advance; tries += 1) {
      advance = preparedGrant(session)
      if (!advance) {
        await page.waitForTimeout(1000)
        if (tries % 5 === 4)
          await page.evaluate(async () => await window.posApi.preparation.runCycle())
      }
    }
    if (!advance) throw new Error('no prepared (advance) grant arrived')
    for (let tries = 0; tries < 3 && !advance.covered; tries += 1) {
      await refreshWorkstation(ctx, page)
      advance = preparedGrant(session)
    }
    ctx.step('advance grant usable', advance)
    if (!advance.covered) throw new Error('the prepared grant never received its coverage boundary')
    const baseline = proxy.requests(UPLOAD).length

    // 1. N's first upload answers 503 with Retry-After 12 s; N+1 is committed right after.
    proxy.rule('first upload 503', UPLOAD, { status: 503, retryAfter: 12, times: 1 })
    await scan(ctx, page, '6221000000011')
    await payExactCash(ctx, page)
    await page.keyboard.press('F9') // new sale
    await page.waitForTimeout(400)
    await scan(ctx, page, '6221000000011')
    await payExactCash(ctx, page)
    await page.keyboard.press('F9')
    await page.waitForTimeout(1500)

    const held = chain(session).slice(-2)
    ctx.step('two consumptions of one chain; N failed transiently', {
      chain: held,
      uploadsSoFar: proxy.requests(UPLOAD).length - baseline
    })
    const [first, second] = held
    if (!first || !second || first.allocation !== second.allocation) {
      throw new Error('expected two consumptions of the same allocation chain')
    }
    if (second.sequence !== first.sequence + 1) throw new Error('expected consecutive sequences')
    if (second.attempt_count !== 0 || second.state !== 'pending') {
      throw new Error('N+1 must be held unchanged while N is retrying')
    }
    if (!(await mainTrace(session, 'upload-held')).length) {
      throw new Error('expected an upload-held decision in the worker log')
    }
    await gotoSync(page)
    await ctx.shot(page, '01-sync-while-n-retries')

    // 2. N retries on its own timer (no external trigger), then N+1 is released in the same drain.
    const report = await waitForServerInvoices(sandbox, device, 3, 60_000)
    const after = chain(session)
    ctx.step('both accepted in order, exactly once', {
      chain: after,
      server: report.invoices,
      uploadRequests: proxy.requests(UPLOAD).map((entry) => entry.line)
    })
    for (const invoice of Object.values(report.invoices)) {
      if (invoice.server_invoices !== 1 || invoice.statuses.some((s) => s !== 'processed')) {
        throw new Error(`unexpected server outcome ${JSON.stringify(invoice)}`)
      }
    }
    if (proxy.requests(UPLOAD).length - baseline !== 3) {
      throw new Error('expected exactly 3 upload requests (503, N, N+1)')
    }
    await page.reload()
    await gotoSync(page)
    await ctx.shot(page, '02-sync-all-uploaded')

    // 3. Offline: two more sales stay pending; reconnect uploads each exactly once.
    await gotoPos(page)
    await proxy.offline()
    await page.waitForTimeout(1500)
    await scan(ctx, page, '6221000000011')
    await payExactCash(ctx, page)
    await page.keyboard.press('F9')
    await page.waitForTimeout(400)
    await scan(ctx, page, '6221000000011')
    await payExactCash(ctx, page)
    await page.keyboard.press('F9')
    ctx.step('offline sales queued', { queue: queue(session) })
    await gotoSync(page)
    await ctx.shot(page, '03-sync-offline-pending')
    await proxy.online()
    const reconnected = await waitForServerInvoices(sandbox, device, 5, 90_000)
    ctx.step('reconnected: every sale uploaded exactly once', {
      queue: queue(session),
      server: reconnected.invoices,
      count: reconnected.device_invoice_count
    })
    if (reconnected.device_invoice_count !== 5) throw new Error('expected 5 server invoices')
    if (queue(session).some((row) => row.state !== 'synced')) throw new Error('queue not drained')
    await page.waitForTimeout(1500)
    await ctx.shot(page, '04-sync-after-reconnect')
  } finally {
    ctx.facts.uploadTrace = session.logs
      .join('')
      .split('\n')
      .filter((line) => line.includes('invoice-upload'))
      .slice(-60)
    await session.app.close().catch(() => undefined)
    await proxy?.stop()
    await sandbox.stop()
  }
}
