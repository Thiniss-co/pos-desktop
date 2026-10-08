import { spawnSync } from 'node:child_process'
import { t } from '../support/app.mjs'
import {
  activate,
  deviceUuid,
  openSandboxAndApp,
  openShift,
  payExactCash,
  refreshWorkstation,
  signIn,
  sizeWindow,
  waitForRoute,
  waitForServerInvoices
} from '../support/journey.mjs'
import { queryLocal } from '../support/localDb.mjs'
import { tap, touchSession } from '../support/touch.mjs'
import { scanInField } from '../support/workspace.mjs'

/**
 * V1 Windows readiness — fractional refund quantities on the on-screen keypad (by touch).
 *
 *  1. A sale of 1.250 units (scan field prefix `1.250*`) is uploaded.
 *  2. Refund 0.5 of it: the line's keypad button opens the quantity entry; 0, ., 5 are tapped; the
 *     refund is reviewed and confirmed; the server holds it.
 *  3. Reopened, the line shows 0.75 refundable; 0.8 is refused in the dialog (nothing selected).
 *  4. Exactly 0.75 is refunded; the server holds two refunds and nothing is refundable any more.
 */
const COLA = '6221000000011'

function serverRefunds(sandbox, invoiceUuid) {
  const script = `
import json, sqlite3, sys
con = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True)
con.row_factory = sqlite3.Row
rows = con.execute(
  "SELECT r.uuid, r.grand_total_amount, (SELECT SUM(CAST(quantity AS REAL)) FROM pos_refund_items ri WHERE ri.pos_refund_id = r.id) AS quantity "
  "FROM pos_refunds r JOIN pos_invoices i ON i.id = r.pos_invoice_id WHERE i.uuid = ? ORDER BY r.id", (sys.argv[2],))
print(json.dumps([dict(r) for r in rows]))
`
  const result = spawnSync('python3', ['-I', '-c', script, sandbox.databasePath, invoiceUuid], {
    encoding: 'utf8'
  })
  if (result.status !== 0) throw new Error(`server query failed: ${result.stderr}`)
  return JSON.parse(result.stdout)
}

async function openRefundFor(page, saleUuid) {
  const refundButton = page.locator('.quick-actions button[data-action="refund"]').first()
  if (!(await refundButton.isVisible().catch(() => false))) {
    await page.locator('.quick-actions [data-action="more"]').first().click()
  }
  await page.locator('[data-action="refund"]:visible').first().click()
  await page.getByTestId(`refund-entry-${saleUuid}`).click()
  return page.getByRole('dialog')
}

async function keypadQuantity(cdp, dialog, keys) {
  await tap(cdp, dialog.getByTestId('refund-enter-quantity').first())
  const entry = dialog.getByTestId('refund-quantity-entry')
  await entry.waitFor()
  await tap(cdp, entry.locator('[data-key="clear"]'))
  for (const key of keys) await tap(cdp, entry.locator(`[data-key="${key}"]`))
  await tap(cdp, dialog.getByTestId('refund-quantity-apply'))
  return entry
}

async function reviewAndConfirm(page, dialog) {
  await dialog.getByRole('button', { name: await t(page, 'refunds.previewAction') }).click()
  const confirmPrefix = (await t(page, 'refunds.confirmActionAmount', { amount: '\u0000' })).split(
    '\u0000'
  )[0]
  await dialog.getByRole('button', { name: new RegExp(`^${confirmPrefix}`) }).click()
  await dialog.getByText(await t(page, 'refunds.success')).waitFor({ timeout: 30_000 })
}

export async function run(ctx) {
  const session = await openSandboxAndApp(ctx)
  const { sandbox } = session
  try {
    const page = session.page
    await sizeWindow(session, 1366, 850)
    await activate(ctx, page)
    await signIn(ctx, page)
    await waitForRoute(page, 'pos')
    const device = await deviceUuid(sandbox)
    sandbox.fixture('assign-device', device)
    await refreshWorkstation(ctx, page)
    await openShift(ctx, page)

    // 1. 1.250 units sold and uploaded.
    await scanInField(page, `1.250*${COLA}`)
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
    ctx.step('1: 1.250 sold and uploaded', sale)
    const cdp = await touchSession(page)

    // 2. 0.5 on the keypad.
    let dialog = await openRefundFor(page, sale.local_uuid)
    await keypadQuantity(cdp, dialog, ['0', '.', '5'])
    await ctx.shot(page, '02-half-selected')
    await reviewAndConfirm(page, dialog)
    await dialog.getByRole('button', { name: await t(page, 'refunds.close') }).click()
    const afterHalf = serverRefunds(sandbox, sale.remote_uuid)
    ctx.step('2: 0.5 refunded', { server: afterHalf })
    if (afterHalf.length !== 1 || Number(afterHalf[0].quantity) !== 0.5)
      throw new Error('2: the server does not hold a 0.5 refund')

    // 3. 0.75 left; 0.8 refused in the dialog.
    dialog = await openRefundFor(page, sale.local_uuid)
    const refundableShown = await dialog.locator('tbody tr td').nth(3).innerText()
    const entry = await keypadQuantity(cdp, dialog, ['0', '.', '8'])
    const overMessage = await t(page, 'refunds.quantityOverRefundable', { max: '0.75' })
    await entry.getByText(overMessage).waitFor()
    await ctx.shot(page, '03-over-refund-refused')
    const reviewDisabled = await dialog
      .getByRole('button', { name: await t(page, 'refunds.previewAction') })
      .isDisabled()
    ctx.step('3: remaining and over-refund', { refundableShown, overMessage, reviewDisabled })
    if (refundableShown.trim() !== '0.75') throw new Error(`3: refundable shows ${refundableShown}`)
    if (!reviewDisabled) throw new Error('3: an over-refund was selected')

    // 4. Exactly the 0.75 left.
    await tap(cdp, entry.locator('[data-key="clear"]'))
    for (const key of ['0', '.', '7', '5']) await tap(cdp, entry.locator(`[data-key="${key}"]`))
    await tap(cdp, dialog.getByTestId('refund-quantity-apply'))
    await reviewAndConfirm(page, dialog)
    await ctx.shot(page, '04-rest-refunded')
    await dialog.getByRole('button', { name: await t(page, 'refunds.close') }).click()
    const finalRefunds = serverRefunds(sandbox, sale.remote_uuid)
    ctx.step('4: the rest refunded', { server: finalRefunds })
    if (finalRefunds.length !== 2 || Number(finalRefunds[1].quantity) !== 0.75)
      throw new Error('4: the server does not hold the 0.75 refund')
  } finally {
    await session.app.close().catch(() => undefined)
    await sandbox.stop()
  }
}
