import {
  launchAgain,
  openSandboxAndApp,
  payExactCash,
  refreshWorkstation,
  scan,
  setupPhysicalPresenceTill,
  waitForRoute,
  waitForServerInvoices
} from '../support/journey.mjs'
import { queryLocal } from '../support/localDb.mjs'

/**
 * Owner receipt copies — the register freezes each sale's receipt snapshot at the sale and uploads it once,
 * against the real app (isolated profile) and a disposable backend:
 *  1. an online sale's snapshot reaches the server, byte-identical (same sha256), with the sale's own QR;
 *  2. an offline sale keeps its snapshot pending until the sale itself is accepted, then uploads it;
 *  3. a lost answer (the server stored it, the register never heard) is resent with the same bytes and
 *     answered "already stored": exactly one server row;
 *  4. a server error is retried within the bound; a restart keeps every state and adds no duplicate.
 */

const RECEIPT = /^POST \/api\/v1\/desktop\/invoices\/[0-9a-f-]+\/receipt-snapshot/

function localSnapshots(profileDir) {
  return queryLocal(
    profileDir,
    `SELECT s.invoice_local_uuid AS uuid, s.content_sha256 AS sha, s.qr_payload AS qr, u.state, u.attempts, u.last_error_code AS code
     FROM local_invoice_receipt_snapshot s JOIN receipt_snapshot_uploads u ON u.invoice_local_uuid = s.invoice_local_uuid
     ORDER BY s.created_at`
  )
}

async function waitFor(label, probe, timeout = 60_000) {
  const deadline = Date.now() + timeout
  let last = null
  while (Date.now() < deadline) {
    last = await probe()
    if (last.ok) return last
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`${label}: ${JSON.stringify(last)}`)
}

/** Every local snapshot accepted, each stored once on the server with the same hash and its own sale's QR. */
function agreement(sandbox, device, profileDir, expected) {
  const local = localSnapshots(profileDir)
  const server = sandbox.fixture('receipt-snapshots', device).snapshots
  const byUuid = new Map(server.map((row) => [row.local_invoice_uuid, row]))
  const ok =
    local.length === expected &&
    server.length === expected &&
    local.every((row) => {
      const stored = byUuid.get(row.uuid)
      return (
        row.state === 'accepted' &&
        stored &&
        stored.content_sha256 === row.sha &&
        stored.qr_payload === row.qr &&
        stored.qr_payload === stored.expected_qr
      )
    })
  return { ok, local, server }
}

export async function run(ctx) {
  const session = await openSandboxAndApp(ctx, {
    flags: { POS_OFFLINE_PHYSICAL_PRESENCE_ENABLED: 'true' },
    proxy: true
  })
  const { sandbox, proxy } = session
  let page = session.page
  try {
    const device = await setupPhysicalPresenceTill(ctx, session)
    if (sandbox.fixture('receipt-snapshots', device).supported !== true) {
      throw new Error('the backend under test does not store receipt snapshots')
    }
    ctx.step('register negotiated receipt snapshot v1', {
      capability: queryLocal(
        session.profileDir,
        'SELECT capability, version FROM bootstrap_capabilities'
      )
    })

    // 1. Online sale.
    await scan(ctx, page, '6221000000028')
    await payExactCash(ctx, page)
    await page.keyboard.press('F9')
    await waitForServerInvoices(sandbox, device, 1)
    const first = await waitFor('1: online snapshot', () =>
      agreement(sandbox, device, session.profileDir, 1)
    )
    ctx.step('1: online sale snapshot stored, same bytes and QR', {
      local: first.local,
      server: first.server
    })
    await ctx.shot(page, '01-online-sale')

    // 2. Offline sale: frozen at the sale, sent only after the sale itself is accepted.
    await proxy.offline()
    await page.evaluate(async () => await window.posApi.connectivity.checkNow())
    await scan(ctx, page, '6221000000028')
    await payExactCash(ctx, page)
    await page.keyboard.press('F9')
    const offline = localSnapshots(session.profileDir)
    if (offline.length !== 2 || offline[1].state !== 'pending') {
      throw new Error(
        `2: the offline sale's snapshot was not frozen pending: ${JSON.stringify(offline)}`
      )
    }
    ctx.step('2: offline sale snapshot frozen, pending', { snapshot: offline[1] })
    await proxy.online()
    await page.evaluate(async () => await window.posApi.connectivity.checkNow())
    await waitForServerInvoices(sandbox, device, 2, 120_000)
    await refreshWorkstation(ctx, page)
    const second = await waitFor(
      '2: offline snapshot after reconnect',
      () => agreement(sandbox, device, session.profileDir, 2),
      120_000
    )
    ctx.step('2: offline sale snapshot uploaded after the sale', { server: second.server.length })

    // 3. Lost answer: the server stores it, the register never hears; the resend is "already stored".
    proxy.rule('receipt-drop', RECEIPT, { dropResponse: true, times: 1 })
    await scan(ctx, page, '6221000000028')
    await payExactCash(ctx, page)
    await page.keyboard.press('F9')
    await waitForServerInvoices(sandbox, device, 3)
    await waitFor('3: answer dropped', async () => ({
      ok: proxy.requests(RECEIPT).some((entry) => entry.rule === 'receipt-drop')
    }))
    const afterDrop = localSnapshots(session.profileDir)
    ctx.step('3: answer lost after the server stored it', {
      local: afterDrop[2],
      server: sandbox.fixture('receipt-snapshots', device).snapshots.length
    })
    proxy.clear('receipt-drop')
    await refreshWorkstation(ctx, page)
    const third = await waitFor('3: resent once, accepted', () =>
      agreement(sandbox, device, session.profileDir, 3)
    )
    ctx.step('3: resend answered already stored; one server row per sale', {
      sends: proxy.requests(RECEIPT).length,
      server: third.server.length
    })

    // 4. A server error is a counted retry; a restart keeps every state and adds nothing.
    proxy.rule('receipt-500', RECEIPT, { status: 500, code: 'SERVER_ERROR', times: 1 })
    await scan(ctx, page, '6221000000028')
    await payExactCash(ctx, page)
    await page.keyboard.press('F9')
    await waitForServerInvoices(sandbox, device, 4)
    await waitFor('4: server error recorded', async () => {
      const row = localSnapshots(session.profileDir)[3]
      return { ok: row?.state === 'pending' && row.attempts === 1, row }
    })
    proxy.clear('receipt-500')
    ctx.step('4: server error counted, still pending', {
      snapshot: localSnapshots(session.profileDir)[3]
    })
    await session.app.close()
    await launchAgain(ctx, session)
    page = session.page
    await waitForRoute(page, 'pos')
    await refreshWorkstation(ctx, page)
    // The retry waits its one-minute spacing; a restart does not shorten it.
    await new Promise((resolve) => setTimeout(resolve, 3000))
    const waiting = localSnapshots(session.profileDir)[3]
    if (waiting.state !== 'pending')
      throw new Error(`4: retried before its delay: ${JSON.stringify(waiting)}`)
    ctx.step('4: after a restart the retry still waits its delay', { snapshot: waiting })
    await new Promise((resolve) => setTimeout(resolve, 60_000))
    await refreshWorkstation(ctx, page)
    const fourth = await waitFor('4: retried after its delay', () =>
      agreement(sandbox, device, session.profileDir, 4)
    )
    ctx.step('4: retried after its delay; four sales, four rows, all accepted', {
      server: fourth.server.length,
      sends: proxy.requests(RECEIPT).length
    })
    await ctx.shot(page, '02-after-restart')
  } finally {
    await session.app.close().catch(() => undefined)
  }
}
