import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { t, virtualPrintDir } from '../support/app.mjs'
import {
  CASHIER,
  MANAGER,
  launchAgain,
  openSandboxAndApp,
  payExactCash,
  scan,
  setupPhysicalPresenceTill,
  signIn,
  signOutViaMenu,
  sizeWindow,
  waitForRoute
} from '../support/journey.mjs'
import { queryLocal } from '../support/localDb.mjs'
import { decodePdfQr, dispatchCount, pdfFiles, waitForCatalogIdle } from './qc6receipts.mjs'

/**
 * POS improvements, Stage 7 — automatic printing after a sale, end to end on the VIRTUAL printer.
 *
 *  A. No printer set up: the POS shows "Automatic printing needs setup"; a sale completes, its panel
 *     says it was not printed, and nothing is dispatched (`skipped_no_printer`). No dialog.
 *  1. Printer set up: a sale prints ONE silent AUTO job to the snapshot printer; the printed PDF's QR
 *     decodes to the sale's frozen payload.
 *  2. The cashier turns it off on the sale panel; it stays off across a restart; a sale writes no intent.
 *  3. Back on (Settings). With the manual mode set to the system dialog, automatic printing is still silent.
 *  4. The printer is disconnected: the banner says so; the sale is `printer_missing`, nothing printed.
 *  5. The printer fails: the job is `failed`; the sale is intact.
 *  6. The printer never answers: `outcome_unknown`, never sent again.
 *  7. FAULT INJECTION: admission held → sale → app closed → relaunch → exactly one AUTO job.
 *     Another cashier signing in never admits it; the same cashier does, once.
 *  8. Reload and a new sign-in after a printed sale: still exactly one AUTO job.
 *  9. FAULT INJECTION: admission held → sale → paper width changed → recovery: `settings_changed`,
 *     no job, and a notice naming the sale.
 * 10. FAULT INJECTION: QR preparation held → sign-out during it → no dispatch, `SESSION_CHANGED` or
 *     `ACCESS_REVOKED`, and never admitted again.
 */

const COLA = '6221000000011'
const CHIPS = '6221000000035'

function control(profileDir, name, value) {
  const dir = virtualPrintDir(profileDir)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  if (value === null) rmSync(path, { force: true })
  else writeFileSync(path, value)
}

function dispatches(profileDir) {
  try {
    return readFileSync(join(virtualPrintDir(profileDir), 'dispatches.log'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

function latestInvoice(profileDir) {
  const [invoice] = queryLocal(
    profileDir,
    'SELECT local_uuid, offline_number, sync_status FROM local_invoices ORDER BY created_at DESC, rowid DESC LIMIT 1'
  )
  return invoice
}

function autoState(profileDir, invoice) {
  const [intent] = queryLocal(
    profileDir,
    `SELECT i.setup_state_at_commit AS setup, i.user_uuid, a.outcome, a.job_uuid,
            j.status AS job_status, j.failure_code, j.resolved_options_json
       FROM auto_print_intents i
       LEFT JOIN auto_print_admissions a ON a.invoice_local_uuid = i.invoice_local_uuid
       LEFT JOIN receipt_print_jobs j ON j.job_uuid = a.job_uuid
      WHERE i.invoice_local_uuid = ?`,
    [invoice]
  )
  const [{ n }] = queryLocal(
    profileDir,
    "SELECT COUNT(*) AS n FROM receipt_print_jobs WHERE trigger = 'auto' AND document_local_uuid = ?",
    [invoice]
  )
  return { intent: intent ?? null, autoJobs: n }
}

async function waitForState(profileDir, invoice, predicate, label, timeout = 30_000) {
  const deadline = Date.now() + timeout
  let state = autoState(profileDir, invoice)
  while (!predicate(state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300))
    state = autoState(profileDir, invoice)
  }
  if (!predicate(state)) throw new Error(`${label}: ${JSON.stringify(state)}`)
  return state
}

/** Sells one item for exact cash and leaves the sale-complete panel OPEN. */
async function sell(ctx, page, code) {
  await waitForCatalogIdle(page)
  await scan(ctx, page, code)
  await payExactCash(ctx, page)
  await page.getByTestId('auto-print-sale-status').waitFor({ timeout: 30_000 })
}

async function chip(page, settled = true) {
  const locator = page.getByTestId('auto-print-chip')
  await locator.waitFor({ timeout: 30_000 })
  if (settled) {
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="auto-print-chip"]')
        const state = el?.getAttribute('data-state')
        const job = el?.getAttribute('data-job-status')
        return (
          state &&
          state !== 'pending' &&
          !(state === 'admitted' && (job === '' || job === 'in_progress'))
        )
      },
      null,
      { timeout: 120_000 }
    )
  }
  return {
    state: await locator.getAttribute('data-state'),
    job: await locator.getAttribute('data-job-status'),
    text: (await locator.innerText()).replace(/\s+/g, ' ').trim()
  }
}

async function newSale(page, ctx = null) {
  const button = page
    .getByRole('dialog')
    .getByRole('button', { name: new RegExp(await t(page, 'pos.tender.newSale')) })
  try {
    await button.click({ timeout: 15_000 })
  } catch (error) {
    if (ctx) {
      await ctx.shot(page, 'debug-new-sale-not-clickable')
      ctx.step('debug: New sale not clickable', {
        box: await button.boundingBox().catch(() => null),
        visibility: await page.evaluate(() => document.visibilityState),
        dialogs: await page.getByRole('dialog').count()
      })
    }
    throw error
  }
  await page.waitForTimeout(400)
}

async function saveSettings(page, patch) {
  return page.evaluate(async (next) => {
    const current = (await window.posApi.printing.getWorkstationSettings()).data
    return (await window.posApi.printing.saveWorkstationSettings({ ...current, ...next })).ok
  }, patch)
}

async function bannerVisible(page, testId, timeout = 12_000) {
  try {
    await page.getByTestId(testId).waitFor({ state: 'visible', timeout })
    return true
  } catch {
    return false
  }
}

export async function run(ctx) {
  const session = await openSandboxAndApp(ctx, {
    flags: { POS_OFFLINE_PHYSICAL_PRESENCE_ENABLED: 'true' }
  })
  const { sandbox, profileDir } = session
  try {
    await setupPhysicalPresenceTill(ctx, session)
    await sizeWindow(session, 1600, 900)
    let page = session.page

    // A. Fresh cashier (preference absent = ON), no printer configured.
    const preference = await page.evaluate(
      async () => (await window.posApi.preferences.getUser()).data
    )
    ctx.step('A: fresh user preference', preference)
    if (preference?.autoPrint !== true) throw new Error('A: automatic printing must default to ON')
    const setupBanner = await bannerVisible(page, 'auto-print-setup-banner')
    await ctx.shot(page, 'A1-setup-banner-no-printer')
    if (!setupBanner) throw new Error('A: the setup banner is missing while no printer is set up')
    const beforeA = dispatchCount(profileDir)
    await sell(ctx, page, COLA)
    const chipA = await chip(page)
    await ctx.shot(page, 'A2-not-printed-no-printer')
    const saleA = latestInvoice(profileDir)
    const stateA = autoState(profileDir, saleA.local_uuid)
    const dialogs = await page.locator('[role=dialog]').count()
    ctx.step('A: sale without a printer', { chip: chipA, db: stateA, openDialogs: dialogs })
    if (
      stateA.intent?.setup !== 'no_printer' ||
      stateA.intent?.outcome !== 'skipped_no_printer' ||
      stateA.autoJobs !== 0 ||
      dispatchCount(profileDir) !== beforeA ||
      chipA.state !== 'skipped_no_printer'
    )
      throw new Error('A: expected skipped_no_printer with no job and no dispatch')
    await newSale(page)

    // 1. Printer configured: one silent AUTO job; the printed QR equals the frozen payload.
    await saveSettings(page, {
      printerName: 'PW-Virtual-80',
      paperWidthMm: 80,
      printableWidthMm: 72,
      dispatchMode: 'direct'
    })
    ctx.step('1: workstation printer PW-Virtual-80 (virtual adapter)')
    await page.waitForTimeout(5500)
    const bannerGone = !(await page.getByTestId('auto-print-setup-banner').isVisible())
    const pdfsBefore = pdfFiles(profileDir).length
    await sell(ctx, page, CHIPS)
    const chip1 = await chip(page)
    await ctx.shot(page, '01-auto-printed')
    const sale1 = latestInvoice(profileDir)
    const state1 = await waitForState(
      profileDir,
      sale1.local_uuid,
      (s) => s.intent?.job_status === 'submitted',
      '1: the AUTO job did not reach submitted'
    )
    const pdf1 = pdfFiles(profileDir).at(-1)
    const [context1] = queryLocal(
      profileDir,
      'SELECT qr_payload FROM local_invoice_fiscal_context WHERE invoice_local_uuid = ?',
      [sale1.local_uuid]
    )
    const qr1 = decodePdfQr(pdf1)
    const record1 = dispatches(profileDir).at(-1)
    ctx.step('1: automatic print', {
      bannerGoneAfterSetup: bannerGone,
      chip: chip1,
      autoJobs: state1.autoJobs,
      pdfs: pdfFiles(profileDir).length - pdfsBefore,
      dispatch: { silent: record1?.silent, deviceName: record1?.deviceName },
      qrMatchesFrozenPayload: qr1 === context1?.qr_payload
    })
    if (
      !bannerGone ||
      state1.autoJobs !== 1 ||
      chip1.job !== 'submitted' ||
      record1?.silent !== true ||
      record1?.deviceName !== 'PW-Virtual-80' ||
      qr1 === null ||
      qr1 !== context1?.qr_payload
    )
      throw new Error('1: expected one silent AUTO job whose printed QR is the frozen payload')

    // 2. Off from the sale panel; persists across a restart; no intent.
    await page.getByTestId('auto-print-switch').click()
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="auto-print-switch"]')
          ?.getAttribute('aria-checked') === 'false'
    )
    await ctx.shot(page, '02a-switched-off-on-panel')
    await newSale(page)
    await session.app.close()
    await launchAgain(ctx, session)
    page = session.page
    await waitForRoute(page, 'pos')
    await sizeWindow(session, 1600, 900)
    const afterRestart = await page.evaluate(
      async () => (await window.posApi.preferences.getUser()).data
    )
    const before2 = dispatchCount(profileDir)
    await sell(ctx, page, COLA)
    const chip2 = await chip(page)
    const sale2 = latestInvoice(profileDir)
    const state2 = autoState(profileDir, sale2.local_uuid)
    await ctx.shot(page, '02b-off-after-restart')
    ctx.step('2: off persists across a restart', {
      preference: afterRestart,
      chip: chip2,
      intent: state2.intent,
      dispatches: dispatchCount(profileDir) - before2
    })
    if (
      afterRestart?.autoPrint !== false ||
      state2.intent !== null ||
      chip2.state !== 'off' ||
      dispatchCount(profileDir) !== before2
    )
      throw new Error('2: an opted-out user must get no intent and no print')
    await newSale(page)

    // 3. Back on in Settings; the manual mode is the system dialog, automatic printing stays silent.
    await page.evaluate(() => window.location.assign('#/settings'))
    await page.getByTestId('auto-print-switch').waitFor()
    await page.getByTestId('auto-print-switch').click()
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="auto-print-switch"]')
          ?.getAttribute('aria-checked') === 'true'
    )
    await ctx.shot(page, '03a-settings-switch-on')
    await saveSettings(page, { dispatchMode: 'system_dialog' })
    await page.evaluate(() => window.location.assign('#/pos'))
    await waitForRoute(page, 'pos')
    await sell(ctx, page, CHIPS)
    const chip3 = await chip(page)
    const sale3 = latestInvoice(profileDir)
    const state3 = await waitForState(
      profileDir,
      sale3.local_uuid,
      (s) => s.intent?.job_status === 'submitted',
      '3: not submitted'
    )
    const record3 = dispatches(profileDir).at(-1)
    ctx.step('3: back on; system-dialog manual mode', {
      chip: chip3,
      autoJobs: state3.autoJobs,
      dispatch: { silent: record3?.silent, deviceName: record3?.deviceName }
    })
    if (state3.autoJobs !== 1 || record3?.silent !== true)
      throw new Error('3: automatic printing must stay silent in system-dialog mode')
    await newSale(page)
    await saveSettings(page, { dispatchMode: 'direct' })

    // 4. Printer disconnected.
    control(profileDir, 'printers', 'PW-Virtual-58\n')
    const missingBanner = await bannerVisible(page, 'auto-print-setup-banner')
    await ctx.shot(page, '04a-banner-printer-missing')
    const before4 = dispatchCount(profileDir)
    await sell(ctx, page, COLA)
    const chip4 = await chip(page)
    await ctx.shot(page, '04b-not-printed-printer-missing')
    const sale4 = latestInvoice(profileDir)
    const state4 = autoState(profileDir, sale4.local_uuid)
    ctx.step('4: printer disconnected', { banner: missingBanner, chip: chip4, db: state4.intent })
    if (
      !missingBanner ||
      state4.intent?.outcome !== 'printer_missing' ||
      state4.autoJobs !== 0 ||
      dispatchCount(profileDir) !== before4
    )
      throw new Error('4: expected printer_missing, no job, no dispatch, and the banner')
    await newSale(page)
    control(profileDir, 'printers', null)

    // 5. The printer reports a failure ("Print job failed"). The existing classifier keeps this
    //    `outcome_unknown` (OS_REPORTED_FAILURE): the job may have reached the spooler, so it is never
    //    sent again automatically. The sale itself is untouched.
    control(profileDir, 'mode', 'fail')
    const before5 = dispatchCount(profileDir)
    await sell(ctx, page, CHIPS)
    const chip5 = await chip(page)
    await ctx.shot(page, '05-print-failed')
    const sale5 = latestInvoice(profileDir)
    const state5 = autoState(profileDir, sale5.local_uuid)
    ctx.step('5: printer failure', {
      chip: chip5,
      job: state5.intent?.job_status,
      failureCode: state5.intent?.failure_code,
      dispatches: dispatchCount(profileDir) - before5,
      sale: sale5.sync_status
    })
    if (
      state5.intent?.job_status !== 'outcome_unknown' ||
      state5.intent?.failure_code !== 'OS_REPORTED_FAILURE' ||
      dispatchCount(profileDir) - before5 !== 1 ||
      !sale5.local_uuid
    )
      throw new Error(
        '5: expected one dispatch reported failed (outcome unknown) and an intact sale'
      )
    await newSale(page)

    // 6. The printer never answers: outcome_unknown after the timeout, never sent again.
    control(profileDir, 'mode', 'hang')
    const before6 = dispatchCount(profileDir)
    await sell(ctx, page, COLA)
    const sale6 = latestInvoice(profileDir)
    const chip6 = await chip(page) // waits up to 120 s (the unknown-outcome timeout is 90 s)
    await ctx.shot(page, '06-outcome-unknown')
    control(profileDir, 'mode', null)
    await newSale(page)
    await signOutViaMenu(ctx, page)
    await signIn(ctx, page, CASHIER)
    await waitForRoute(page, 'pos')
    await page.waitForTimeout(2000)
    const state6 = autoState(profileDir, sale6.local_uuid)
    ctx.step('6: printer never answered', {
      chip: chip6,
      db: state6.intent,
      dispatches: dispatchCount(profileDir) - before6,
      autoJobs: state6.autoJobs
    })
    if (
      state6.intent?.job_status !== 'outcome_unknown' ||
      dispatchCount(profileDir) - before6 !== 1 ||
      state6.autoJobs !== 1
    )
      throw new Error('6: expected outcome_unknown, dispatched once, never resent')

    // 7. FAULT INJECTION: admission held between commit and decision; app closed; relaunch.
    control(profileDir, 'hold-auto-admission', '1')
    await sell(ctx, page, CHIPS)
    const sale7 = latestInvoice(profileDir)
    const chip7 = await chip(page, false)
    await ctx.shot(page, '07a-held-pending')
    const held7 = autoState(profileDir, sale7.local_uuid)
    ctx.step('7: chip while admission is held', chip7)
    await newSale(page, ctx)
    // Another cashier first: the pending intent stays invisible to them.
    await signOutViaMenu(ctx, page)
    control(profileDir, 'hold-auto-admission', null)
    await signIn(ctx, page, MANAGER)
    await page.waitForTimeout(3000)
    const otherOwner = autoState(profileDir, sale7.local_uuid)
    await signOutViaMenu(ctx, page)
    control(profileDir, 'hold-auto-admission', '1')
    await signIn(ctx, page, CASHIER)
    await waitForRoute(page, 'pos')
    await page.waitForTimeout(1500)
    ctx.step(
      '7: FAULT INJECTION — admission held (virtual boundary seam) between commit and admission',
      { afterCommit: held7.intent, afterOtherCashier: otherOwner.intent }
    )
    if (held7.intent?.outcome !== null || otherOwner.intent?.outcome !== null)
      throw new Error('7: the intent must stay pending (held, then another cashier)')
    await session.app.close()
    control(profileDir, 'hold-auto-admission', null)
    await launchAgain(ctx, session)
    page = session.page
    await waitForRoute(page, 'pos')
    await sizeWindow(session, 1600, 900)
    const state7 = await waitForState(
      profileDir,
      sale7.local_uuid,
      (s) => s.intent?.job_status === 'submitted',
      '7: not admitted after the relaunch'
    )
    ctx.step('7: relaunch (same cashier, within 10 minutes)', {
      db: state7.intent,
      autoJobs: state7.autoJobs
    })
    if (state7.autoJobs !== 1) throw new Error('7: expected exactly one AUTO job')

    // 8. Reload and a new sign-in: still exactly one AUTO job for the printed sale.
    await page.reload()
    await waitForRoute(page, 'pos')
    await signOutViaMenu(ctx, page)
    await signIn(ctx, page, CASHIER)
    await waitForRoute(page, 'pos')
    await page.waitForTimeout(2000)
    const state8 = autoState(profileDir, sale1.local_uuid)
    const state8b = autoState(profileDir, sale7.local_uuid)
    ctx.step('8: reload and sign-in again', {
      sale1AutoJobs: state8.autoJobs,
      sale7AutoJobs: state8b.autoJobs
    })
    if (state8.autoJobs !== 1 || state8b.autoJobs !== 1)
      throw new Error('8: a reload or a new sign-in created another AUTO job')

    // 9. FAULT INJECTION: settings changed before recovery.
    control(profileDir, 'hold-auto-admission', '1')
    await sell(ctx, page, COLA)
    const sale9 = latestInvoice(profileDir)
    await chip(page, false)
    await newSale(page, ctx)
    await saveSettings(page, { paperWidthMm: 58, printableWidthMm: 48 })
    control(profileDir, 'hold-auto-admission', null)
    await signOutViaMenu(ctx, page)
    await signIn(ctx, page, CASHIER)
    await waitForRoute(page, 'pos')
    const state9 = await waitForState(
      profileDir,
      sale9.local_uuid,
      (s) => s.intent?.outcome != null,
      '9: not decided after the sign-in'
    )
    const notices = await bannerVisible(page, 'auto-print-notices')
    const noticeText = notices
      ? (await page.getByTestId('auto-print-notices').innerText()).replace(/\s+/g, ' ')
      : ''
    await ctx.shot(page, '09-notice-settings-changed')
    ctx.step('9: FAULT INJECTION — admission held, then the paper width changed before recovery', {
      db: state9.intent,
      autoJobs: state9.autoJobs,
      notice: notices,
      namesTheSale: noticeText.includes(sale9.offline_number)
    })
    if (
      state9.intent?.outcome !== 'settings_changed' ||
      state9.autoJobs !== 0 ||
      !notices ||
      !noticeText.includes(sale9.offline_number)
    )
      throw new Error('9: expected settings_changed, no job, and a notice naming the sale')
    await page.getByTestId('auto-print-notices').getByRole('button').last().click()
    await saveSettings(page, { paperWidthMm: 80, printableWidthMm: 72 })

    // 10. FAULT INJECTION: sign-out while QR preparation is held open.
    control(profileDir, 'qr-capture-delay-ms', '10000')
    const before10 = dispatchCount(profileDir)
    await sell(ctx, page, CHIPS)
    const sale10 = latestInvoice(profileDir)
    await waitForState(
      profileDir,
      sale10.local_uuid,
      (s) => s.intent?.outcome === 'admitted',
      '10: not admitted'
    )
    await chip(page, false)
    await newSale(page, ctx)
    await signOutViaMenu(ctx, page)
    const state10 = await waitForState(
      profileDir,
      sale10.local_uuid,
      (s) => s.intent?.job_status === 'failed_before_dispatch',
      '10: the held job did not end failed_before_dispatch',
      40_000
    )
    control(profileDir, 'qr-capture-delay-ms', null)
    await signIn(ctx, page, CASHIER)
    await waitForRoute(page, 'pos')
    await page.waitForTimeout(2000)
    const after10 = autoState(profileDir, sale10.local_uuid)
    ctx.step(
      '10: FAULT INJECTION — sign-out while QR preparation was held (virtual boundary delay)',
      {
        db: state10.intent,
        dispatches: dispatchCount(profileDir) - before10,
        autoJobsAfterSignIn: after10.autoJobs
      }
    )
    if (
      !['SESSION_CHANGED', 'ACCESS_REVOKED'].includes(state10.intent?.failure_code) ||
      dispatchCount(profileDir) !== before10 ||
      after10.autoJobs !== 1
    )
      throw new Error('10: expected no dispatch, a session/access failure, and no re-admission')
  } finally {
    await session.app.close().catch(() => undefined)
    await sandbox.stop()
  }
}
