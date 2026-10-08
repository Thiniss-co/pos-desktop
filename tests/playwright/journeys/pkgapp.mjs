import { t } from '../support/app.mjs'
import {
  activate,
  deviceUuid,
  openShift,
  payExactCash,
  refreshWorkstation,
  scan,
  signIn,
  waitForRoute,
  waitForServerInvoices
} from '../support/journey.mjs'
import { queryLocal } from '../support/localDb.mjs'
import {
  PACKAGED_APP_DIR,
  buildPackagedApp,
  launchPackagedApp,
  readFuses
} from '../support/packagedApp.mjs'
import { freePort, startSandbox } from '../support/sandbox.mjs'

/**
 * V1 production readiness: the PACKAGED till (dist/linux-unpacked, OS print boundary, release fuses,
 * files allowlist) through the core cashier flow against a disposable Laravel backend.
 *
 *  0. A package built WITHOUT the loopback opt-in refuses the loopback HTTP origin (not configured).
 *  1. The test package (opt-in) carries the release fuses and shows the OS print boundary.
 *  2. activate → sign in → bootstrap → open shift → scanner sale → exact cash → upload (sync).
 *  3. Print: the configured printer does not exist and CUPS is unreachable. The automatic receipt
 *     asks the real OS boundary for it and records `printer_missing` with no job; nothing can reach
 *     a physical printer.
 *  4. Refund the synced sale through the UI; the server accepts it.
 */
const COLA = '6221000000011'
const ABSENT_PRINTER = 'PKG-Absent-Printer'

function local(session, sql, params = []) {
  return queryLocal(session.profileDir, sql, params, PACKAGED_APP_DIR)
}

async function runtimeInfo(page) {
  const result = await page.evaluate(async () => await window.posApi.system.getRuntimeInfo())
  if (!result.ok) throw new Error(`runtime info failed: ${JSON.stringify(result)}`)
  return result.data
}

export async function run(ctx) {
  const port = await freePort()
  const sandbox = await startSandbox({ runDir: ctx.runDir, port })
  ctx.step('disposable backend ready', { origin: sandbox.origin, database: sandbox.databasePath })
  let app = null
  try {
    // 0. The release guard, in a real package: no opt-in, no loopback origin.
    buildPackagedApp(sandbox.origin, { allowLoopback: false })
    app = await launchPackagedApp({
      runDir: ctx.runDir,
      profileDir: `${ctx.runDir}/profile-guard`
    })
    ctx.session = app
    const guarded = await runtimeInfo(app.page)
    ctx.step('0: package without the loopback opt-in', guarded)
    await ctx.shot(app.page, '00-release-package-not-configured')
    if (guarded.apiConfiguration !== 'not_configured')
      throw new Error('0: a release package accepted a loopback HTTP origin')
    await app.close()
    app = null

    // 1. The test package: same release configuration, loopback opt-in only.
    buildPackagedApp(sandbox.origin, { allowLoopback: true })
    const fuses = readFuses()
    ctx.step('1: fuses in the packaged binary', fuses)
    if (
      fuses.RunAsNode !== false ||
      fuses.EnableNodeOptionsEnvironmentVariable !== false ||
      fuses.EnableNodeCliInspectArguments !== false ||
      fuses.OnlyLoadAppFromAsar !== true
    )
      throw new Error('1: the packaged binary does not carry the release fuses')
    const profileDir = `${ctx.runDir}/profile`
    app = await launchPackagedApp({ runDir: ctx.runDir, profileDir })
    ctx.session = app
    const session = { ...app, profileDir }
    const { page } = app
    const info = await runtimeInfo(page)
    ctx.step('1: packaged runtime', info)
    if (info.apiConfiguration !== 'configured')
      throw new Error('1: the test package is unconfigured')

    // 2. Core cashier flow.
    await activate(ctx, page)
    await signIn(ctx, page)
    await waitForRoute(page, 'pos')
    const device = await deviceUuid(sandbox)
    ctx.step('device assigned through the fence', sandbox.fixture('assign-device', device))
    await refreshWorkstation(ctx, page)
    await openShift(ctx, page)
    const printers = await page.evaluate(async () => await window.posApi.printing.listPrinters())
    ctx.step('3: printers visible to the packaged OS boundary', printers)
    if (!printers.ok || printers.data.some((printer) => printer.name.startsWith('PW-Virtual-')))
      throw new Error('3: the packaged app is not on the OS print boundary')
    const saved = await page.evaluate(async (printerName) => {
      const current = (await window.posApi.printing.getWorkstationSettings()).data
      return await window.posApi.printing.saveWorkstationSettings({ ...current, printerName })
    }, ABSENT_PRINTER)
    ctx.step('3: receipt printer set to a printer that does not exist', { ok: saved.ok })
    if (!saved.ok) throw new Error(`3: printer settings refused: ${JSON.stringify(saved)}`)
    await ctx.shot(page, '01-packaged-pos-shift-open')
    await scan(ctx, page, COLA)
    await payExactCash(ctx, page)
    await ctx.shot(page, '02-packaged-sale-committed')
    const report = await waitForServerInvoices(sandbox, device, 1, 90_000)
    const [sale] = local(
      session,
      'SELECT local_uuid, sync_status FROM local_invoices ORDER BY created_at DESC LIMIT 1'
    )
    ctx.step('2: sale committed and uploaded', {
      sale,
      serverInvoices: report.device_invoice_count
    })

    // 3. Print through the real OS boundary: the automatic receipt asks the OS for the configured
    //    printer, finds it absent and records that, with no job and nothing dispatched.
    const deadline = Date.now() + 60_000
    let admission = null
    while (Date.now() < deadline) {
      ;[admission] = local(
        session,
        'SELECT outcome, job_uuid FROM auto_print_admissions WHERE invoice_local_uuid = ?',
        [sale.local_uuid]
      )
      if (admission) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    const [{ jobs }] = local(
      session,
      'SELECT COUNT(*) AS jobs FROM receipt_print_jobs WHERE document_local_uuid = ?',
      [sale.local_uuid]
    )
    ctx.step('3: automatic receipt through the OS boundary', { admission, jobs })
    await ctx.shot(page, '03-packaged-printer-missing')
    if (admission?.outcome !== 'printer_missing' || admission.job_uuid !== null || jobs !== 0)
      throw new Error('3: expected printer_missing with no print job for an absent printer')

    // Leave the sale-complete panel, if it is still open.
    const newSale = page
      .getByRole('dialog')
      .getByRole('button', { name: new RegExp(await t(page, 'pos.tender.newSale')) })
    if (await newSale.isVisible().catch(() => false)) await newSale.click()

    // 4. Refund through the UI.
    const refundButton = page.locator('.quick-actions button[data-action="refund"]').first()
    if (!(await refundButton.isVisible().catch(() => false))) {
      await page.locator('.quick-actions [data-action="more"]').first().click()
    }
    await page.locator('[data-action="refund"]:visible').first().click()
    await page.getByTestId(`refund-entry-${sale.local_uuid}`).click()
    const refundDialog = page.getByRole('dialog')
    await refundDialog
      .getByRole('button', { name: await t(page, 'refunds.increaseQuantity') })
      .first()
      .click()
    await refundDialog.getByRole('button', { name: await t(page, 'refunds.previewAction') }).click()
    const confirmPrefix = (
      await t(page, 'refunds.confirmActionAmount', { amount: '\u0000' })
    ).split('\u0000')[0]
    await refundDialog.getByRole('button', { name: new RegExp(`^${confirmPrefix}`) }).click()
    await refundDialog.getByText(await t(page, 'refunds.success')).waitFor({ timeout: 30_000 })
    await ctx.shot(page, '04-packaged-refund-accepted')
    await refundDialog.getByRole('button', { name: await t(page, 'refunds.close') }).click()
    const refunds = local(session, 'SELECT submission_state, remote_uuid FROM local_refunds')
    ctx.step('4: refund through the packaged app', { refunds })
    if (
      refunds.length !== 1 ||
      refunds[0].submission_state !== 'accepted' ||
      !refunds[0].remote_uuid
    )
      throw new Error('4: the refund was not accepted by the server')
  } finally {
    ctx.facts.mainLogTail = (app?.logs ?? [])
      .join('')
      .split('\n')
      .filter((line) => /\[pos-|error|Error/.test(line))
      .slice(-80)
    await app?.close()
    await sandbox.stop()
  }
}
