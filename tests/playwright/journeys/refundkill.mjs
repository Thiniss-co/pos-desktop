import { spawnSync } from 'node:child_process'
import { launchApp, t } from '../support/app.mjs'
import {
  activate,
  deviceUuid,
  openSandboxAndApp,
  openShift,
  payExactCash,
  refreshWorkstation,
  scan,
  signIn,
  waitForRoute,
  waitForServerInvoices
} from '../support/journey.mjs'
import { queryLocal } from '../support/localDb.mjs'

/**
 * V1 closeout — a refund whose server commit outlives the till process.
 *
 *  1. A sale is committed and uploaded.
 *  2. A refund is confirmed through the UI. The proxy forwards the upload, the server COMMITS it, and
 *     the answer is held back, so the till is left `dispatched` with no outcome.
 *  3. The till process is killed (SIGKILL) at that moment.
 *  4. Relaunched on the same profile: the startup sweep records the refund `unresolved` (never
 *     rejected, never resent on its own); the frozen request bytes and key are unchanged.
 *  5. The cashier resumes it from the sale page: the same bytes go out under the same key and the
 *     server answers with the ORIGINAL refund. Exactly one refund exists on the server.
 */
const COLA = '6221000000011'
const REFUND_UPLOAD = /^POST \/api\/v1\/desktop\/refunds\/upload/

function serverRefunds(sandbox, invoiceUuid) {
  const script = `
import json, sqlite3, sys
con = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True)
con.row_factory = sqlite3.Row
rows = con.execute(
  "SELECT r.uuid, r.idempotency_key, r.local_refund_uuid FROM pos_refunds r "
  "JOIN pos_invoices i ON i.id = r.pos_invoice_id WHERE i.uuid = ? ORDER BY r.id", (sys.argv[2],))
print(json.dumps([dict(r) for r in rows]))
`
  const result = spawnSync('python3', ['-I', '-c', script, sandbox.databasePath, invoiceUuid], {
    encoding: 'utf8'
  })
  if (result.status !== 0) throw new Error(`server query failed: ${result.stderr}`)
  return JSON.parse(result.stdout)
}

function localRefund(profileDir) {
  const [row] = queryLocal(
    profileDir,
    `SELECT local_uuid, submission_state, dispatch_count, remote_uuid, request_json, request_sha256
       FROM local_refunds ORDER BY rowid DESC LIMIT 1`
  )
  return row ?? null
}

async function until(read, predicate, label, timeout = 60_000) {
  const deadline = Date.now() + timeout
  let value = await read()
  while (!predicate(value)) {
    if (Date.now() > deadline) throw new Error(`${label}: ${JSON.stringify(value)}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
    value = await read()
  }
  return value
}

export async function run(ctx) {
  const session = await openSandboxAndApp(ctx, { proxy: true })
  const { sandbox, proxy } = session
  try {
    let page = session.page
    await activate(ctx, page)
    await signIn(ctx, page)
    await waitForRoute(page, 'pos')
    const device = await deviceUuid(sandbox)
    sandbox.fixture('assign-device', device)
    await refreshWorkstation(ctx, page)
    await openShift(ctx, page)
    await scan(ctx, page, COLA)
    await payExactCash(ctx, page)
    await page
      .getByRole('dialog')
      .getByRole('button', { name: new RegExp(await t(page, 'pos.tender.newSale')) })
      .click()
    await waitForServerInvoices(sandbox, device, 1, 90_000)
    const [sale] = queryLocal(
      session.profileDir,
      'SELECT local_uuid, remote_uuid FROM local_invoices ORDER BY created_at DESC LIMIT 1'
    )
    ctx.step('1: sale uploaded', sale)

    // 2. The server commits the refund; its answer never reaches the till.
    proxy.rule('refund-answer-held', REFUND_UPLOAD, { delayResponseMs: 600_000, times: 1 })
    const refundButton = page.locator('.quick-actions button[data-action="refund"]').first()
    if (!(await refundButton.isVisible().catch(() => false))) {
      await page.locator('.quick-actions [data-action="more"]').first().click()
    }
    await page.locator('[data-action="refund"]:visible').first().click()
    await page.getByTestId(`refund-entry-${sale.local_uuid}`).click()
    const dialog = page.getByRole('dialog')
    await dialog
      .getByRole('button', { name: await t(page, 'refunds.increaseQuantity') })
      .first()
      .click()
    await dialog.getByRole('button', { name: await t(page, 'refunds.previewAction') }).click()
    const confirmPrefix = (
      await t(page, 'refunds.confirmActionAmount', { amount: '\u0000' })
    ).split('\u0000')[0]
    await dialog.getByRole('button', { name: new RegExp(`^${confirmPrefix}`) }).click()
    const dispatched = await until(
      () => localRefund(session.profileDir),
      (row) => row?.submission_state === 'dispatched',
      '2: the refund never reached dispatched'
    )
    const committed = await until(
      () => serverRefunds(sandbox, sale.remote_uuid),
      (rows) => rows.length === 1,
      '2: the server never committed the refund'
    )
    ctx.step('2: server committed; till dispatched with no answer', {
      local: { state: dispatched.submission_state, dispatches: dispatched.dispatch_count },
      server: committed
    })

    // 3. Kill the till now.
    const child = session.app.process()
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGKILL')
    await exited
    proxy.clear('refund-answer-held')
    ctx.step('3: till killed with SIGKILL while the refund was dispatched')

    // 4. Relaunch: swept to unresolved, bytes unchanged, nothing resent on its own.
    Object.assign(
      session,
      await launchApp({ outDir: session.outDir, profileDir: session.profileDir })
    )
    page = session.page
    await waitForRoute(page, 'pos')
    const swept = await until(
      () => localRefund(session.profileDir),
      (row) => row?.submission_state === 'unresolved',
      '4: the startup sweep did not record the refund unresolved'
    )
    const uploadsBeforeResume = proxy.requests(REFUND_UPLOAD).length
    ctx.step('4: relaunched; refund unresolved', {
      state: swept.submission_state,
      dispatches: swept.dispatch_count,
      sameBytes: swept.request_json === dispatched.request_json,
      sameSha: swept.request_sha256 === dispatched.request_sha256,
      uploadsSoFar: uploadsBeforeResume
    })
    if (swept.request_json !== dispatched.request_json || swept.dispatch_count !== 1)
      throw new Error('4: the frozen request changed or was resent across the restart')

    // 5. Resume from the sale page.
    await page.evaluate(
      (uuid) =>
        document.querySelector('#app').__vue_app__.config.globalProperties.$router.push({
          name: 'sale-detail',
          params: { localUuid: uuid }
        }),
      sale.local_uuid
    )
    await page.getByRole('button', { name: await t(page, 'refunds.resumeAction') }).click()
    const resumed = await until(
      () => localRefund(session.profileDir),
      (row) => row?.submission_state === 'accepted',
      '5: the resumed refund was not accepted'
    )
    await ctx.shot(page, '05-refund-resumed-after-kill')
    const finalServer = serverRefunds(sandbox, sale.remote_uuid)
    const sentBodies = proxy.requests(REFUND_UPLOAD).length
    ctx.step('5: resumed', {
      state: resumed.submission_state,
      dispatches: resumed.dispatch_count,
      remote: resumed.remote_uuid,
      server: finalServer,
      uploads: sentBodies
    })
    if (finalServer.length !== 1) throw new Error('5: the server holds more than one refund')
    if (resumed.remote_uuid !== committed[0].uuid)
      throw new Error('5: the till did not converge to the ORIGINAL server refund')
    if (finalServer[0].idempotency_key !== resumed.local_uuid)
      throw new Error('5: the server refund was not keyed by the frozen local key')
    if (resumed.request_json !== dispatched.request_json || resumed.dispatch_count !== 2)
      throw new Error('5: the resumed request was not the identical frozen bytes (one resend)')
  } finally {
    await session.app.close().catch(() => undefined)
    await proxy?.stop().catch(() => undefined)
    await sandbox.stop()
  }
}
