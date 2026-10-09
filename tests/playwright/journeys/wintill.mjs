import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
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
import { buildPackagedApp } from '../support/packagedApp.mjs'
import { startProxy } from '../support/proxy.mjs'
import { freePort, startSandbox } from '../support/sandbox.mjs'
import { localTillController, vboxTillController } from '../support/tillController.mjs'
import { tap, touchSession } from '../support/touch.mjs'
import { setLocaleTheme } from '../support/workspace.mjs'

/**
 * V1 Windows acceptance — the cashier journey on a PACKAGED till, driven over CDP.
 *
 *   PW_TILL_CONTROLLER=local (default): the Linux package on this machine (proves the journey).
 *   PW_TILL_CONTROLLER=vbox: the NSIS-installed till in a disposable Windows VM; see
 *     tests/windows/README.md (PW_TILL_VM, PW_TILL_GUEST_USER, PW_TILL_GUEST_PASSWORD_FILE,
 *     PW_TILL_CDP_URL, PW_TILL_API_PORT = the loopback port the test installer was built for).
 *
 *  A. Runtime: platform and version (win32 required with vbox); activation, sign-in, shift.
 *  B. Exact cash sale online: on the server exactly once.
 *  C. Touch only: touch mode switched on by touch; a quick-created product priced on the keypad
 *     (1, 2, ., 5) is stored by the server at 1250 minor units.
 *  D. Offline sale, then a hard kill (power cut): after the restart the till is still signed in, the
 *     sale is still pending (and, where the database is readable, with the same key and bytes); back
 *     online it reaches the server exactly once.
 *  E. Refund of the first sale on the keypad: one refund on the server.
 *  F. Arabic + dark and English + light: right-to-left layout, screenshots.
 *  G. Normal quit and start: still signed in (protected credential storage: DPAPI on Windows).
 */
const COLA = '6221000000011'
const WATER = '6221000000028'
const PRODUCT = 'Acceptance Touch Product'

/** Server refunds of the sale the till knows as `localInvoiceUuid`. */
function serverRefunds(sandbox, localInvoiceUuid) {
  const script = `
import json, sqlite3, sys
con = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True)
rows = con.execute(
  "SELECT DISTINCT r.uuid FROM pos_refunds r JOIN desktop_invoice_syncs s ON s.pos_invoice_id = r.pos_invoice_id "
  "WHERE s.local_invoice_uuid = ?", (sys.argv[2],))
print(json.dumps([r[0] for r in rows]))
`
  const result = spawnSync(
    'python3',
    ['-I', '-c', script, sandbox.databasePath, localInvoiceUuid],
    {
      encoding: 'utf8'
    }
  )
  if (result.status !== 0) throw new Error(`server query failed: ${result.stderr}`)
  return JSON.parse(result.stdout)
}

function serverProduct(sandbox, name) {
  const script = `
import json, sqlite3, sys
con = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True)
print(json.dumps([r[0] for r in con.execute("SELECT price FROM products WHERE name = ?", (sys.argv[2],))]))
`
  const result = spawnSync('python3', ['-I', '-c', script, sandbox.databasePath, name], {
    encoding: 'utf8'
  })
  if (result.status !== 0) throw new Error(`server query failed: ${result.stderr}`)
  return JSON.parse(result.stdout)
}

async function until(read, predicate, label, timeout = 60_000) {
  const deadline = Date.now() + timeout
  let value = await read()
  while (!predicate(value)) {
    if (Date.now() > deadline) throw new Error(`${label}: ${JSON.stringify(value)}`)
    await new Promise((resolve) => setTimeout(resolve, 500))
    value = await read()
  }
  return value
}

async function syncCounts(page) {
  const result = await page.evaluate(async () => await window.posApi.sync.getStatus())
  return result.ok ? result.data.counts : null
}

async function setOnline(page, proxy, on) {
  if (on) await proxy.online()
  else await proxy.offline()
  await page.evaluate(async () => await window.posApi.connectivity.checkNow())
}

async function newSale(page) {
  await page
    .getByRole('dialog')
    .getByRole('button', { name: new RegExp(await t(page, 'pos.tender.newSale')) })
    .click()
}

function controllerFor(ctx, proxyOrigin) {
  if ((process.env.PW_TILL_CONTROLLER ?? 'local') === 'vbox') {
    return vboxTillController({
      vm: process.env.PW_TILL_VM,
      username: process.env.PW_TILL_GUEST_USER,
      passwordFile: process.env.PW_TILL_GUEST_PASSWORD_FILE,
      cdpUrl: process.env.PW_TILL_CDP_URL
    })
  }
  return localTillController({
    runDir: ctx.runDir,
    profileDir: join(ctx.runDir, 'profile'),
    binary: buildPackagedApp(proxyOrigin, { allowLoopback: true })
  })
}

export async function run(ctx) {
  const vbox = (process.env.PW_TILL_CONTROLLER ?? 'local') === 'vbox'
  const apiPort = vbox ? Number(process.env.PW_TILL_API_PORT) : await freePort()
  if (!Number.isInteger(apiPort) || apiPort <= 0) throw new Error('PW_TILL_API_PORT is required')
  const sandbox = await startSandbox({
    runDir: ctx.runDir,
    port: await freePort(),
    flags: { POS_OFFLINE_PHYSICAL_PRESENCE_ENABLED: 'true' }
  })
  const proxy = await startProxy(sandbox.origin, apiPort)
  const controller = controllerFor(ctx, proxy.origin)
  ctx.step('disposable backend and till', { api: proxy.origin, controller: controller.kind })
  try {
    sandbox.fixture('quick-create-grant', 'cashier:catalog.products.create:1')
    let page = await controller.start()

    // A. Runtime, activation, shift.
    const runtime = (await page.evaluate(async () => await window.posApi.system.getRuntimeInfo()))
      .data
    ctx.step('A: packaged till running', runtime)
    if (vbox && runtime.platform !== 'win32') throw new Error('A: the vbox till is not Windows')
    await activate(ctx, page)
    await signIn(ctx, page)
    await waitForRoute(page, 'pos')
    const device = await deviceUuid(sandbox)
    sandbox.fixture('assign-device', device)
    sandbox.fixture('mode-physical-presence', '')
    await refreshWorkstation(ctx, page)
    await openShift(ctx, page)

    // B. Online sale, exactly once.
    await scan(ctx, page, COLA)
    await payExactCash(ctx, page)
    await newSale(page)
    const first = await waitForServerInvoices(sandbox, device, 1, 90_000)
    const firstSale = Object.keys(first.invoices)[0]
    ctx.step('B: online sale on the server exactly once', { count: first.device_invoice_count })
    await ctx.shot(page, 'B-after-online-sale')

    // C. Touch only: touch mode and a keypad price.
    const cdp = await touchSession(page)
    await tap(cdp, page.getByRole('button', { name: await t(page, 'shell.user.menuLabel') }))
    await tap(cdp, page.getByTestId('touch-mode-switch'))
    await page.waitForFunction(() => document.documentElement.dataset.touch === 'on')
    await tap(cdp, page.getByRole('button', { name: await t(page, 'shell.user.menuLabel') }))
    const inline = page.locator('.quick-actions button[data-action="quick-create"]').first()
    if (await inline.isVisible().catch(() => false)) {
      await tap(cdp, inline)
    } else {
      await tap(cdp, page.locator('.quick-actions [data-action="more"]').first())
      await tap(cdp, page.locator('[role="menuitem"][data-action="quick-create"]').first())
    }
    await tap(cdp, page.getByTestId('more-actions-product'))
    const create = page.getByTestId('quick-create-dialog')
    await create.waitFor()
    await create
      .getByLabel(await t(page, 'quickCreate.field.name'))
      .first()
      .fill(PRODUCT)
    const price = create.getByTestId('quick-create-price')
    await price.getByTestId('numeric-keypad').waitFor()
    for (const key of ['1', '2', '.', '5']) await tap(cdp, price.locator(`[data-key="${key}"]`))
    await ctx.shot(page, 'C-keypad-price')
    await tap(cdp, page.getByTestId('quick-create-save'))
    await create.waitFor({ state: 'detached', timeout: 15_000 })
    const stored = await until(
      () => serverProduct(sandbox, PRODUCT),
      (rows) => rows.length === 1,
      'C: the server never stored the product'
    )
    ctx.step('C: quick-created by touch, priced on the keypad', { serverPrice: stored[0] })
    if (Number(stored[0]) !== 1250) throw new Error(`C: the server stored ${stored[0]}`)
    await tap(cdp, page.getByRole('button', { name: await t(page, 'shell.user.menuLabel') }))
    await tap(cdp, page.getByTestId('touch-mode-switch'))
    await page.waitForFunction(() => document.documentElement.dataset.touch !== 'on')
    await page.keyboard.press('Escape')

    // D. Offline sale, power cut, restart, reconnect.
    await setOnline(page, proxy, false)
    await scan(ctx, page, WATER)
    await payExactCash(ctx, page)
    await newSale(page)
    const pendingBefore = await until(
      () => syncCounts(page),
      (counts) => counts?.pending === 1,
      'D: the offline sale is not pending'
    )
    const queuedBefore = controller.query(
      "SELECT idempotency_key, payload_json FROM sync_queue WHERE state = 'pending'"
    )
    await controller.kill()
    ctx.step('D: offline sale pending; till killed', { pendingBefore })
    page = await controller.start()
    await waitForRoute(page, 'pos')
    const pendingAfter = await syncCounts(page)
    const queuedAfter = controller.query(
      "SELECT idempotency_key, payload_json FROM sync_queue WHERE state = 'pending'"
    )
    const sameBytes =
      queuedBefore === null
        ? 'not observable'
        : JSON.stringify(queuedBefore) === JSON.stringify(queuedAfter)
    ctx.step('D: restarted after the kill, still signed in', { pendingAfter, sameBytes })
    if (pendingAfter?.pending !== 1) throw new Error('D: the pending sale did not survive the kill')
    if (sameBytes === false) throw new Error('D: the queued sale changed across the kill')
    await setOnline(page, proxy, true)
    const second = await waitForServerInvoices(sandbox, device, 2, 120_000)
    ctx.step('D: uploaded exactly once after reconnecting', { count: second.device_invoice_count })
    if (second.device_invoice_count !== 2) throw new Error('D: not exactly two server invoices')

    // E. Refund of the first sale, quantity on the keypad.
    const refundButton = page.locator('.quick-actions button[data-action="refund"]').first()
    if (!(await refundButton.isVisible().catch(() => false))) {
      await page.locator('.quick-actions [data-action="more"]').first().click()
    }
    await page.locator('[data-action="refund"]:visible').first().click()
    await page.getByTestId(`refund-entry-${firstSale}`).click()
    const refund = page.getByRole('dialog')
    const touch = await touchSession(page)
    await tap(touch, refund.getByTestId('refund-enter-quantity').first())
    const entry = refund.getByTestId('refund-quantity-entry')
    await entry.waitFor()
    await tap(touch, entry.locator('[data-key="clear"]'))
    await tap(touch, entry.locator('[data-key="1"]'))
    await tap(touch, refund.getByTestId('refund-quantity-apply'))
    await refund.getByRole('button', { name: await t(page, 'refunds.previewAction') }).click()
    const confirmPrefix = (
      await t(page, 'refunds.confirmActionAmount', { amount: '\u0000' })
    ).split('\u0000')[0]
    await refund.getByRole('button', { name: new RegExp(`^${confirmPrefix}`) }).click()
    await refund.getByText(await t(page, 'refunds.success')).waitFor({ timeout: 30_000 })
    await ctx.shot(page, 'E-refund-done')
    await refund.getByRole('button', { name: await t(page, 'refunds.close') }).click()
    const refunds = serverRefunds(sandbox, firstSale)
    ctx.step('E: refund on the server', { refunds: refunds.length })
    if (refunds.length !== 1) throw new Error('E: not exactly one server refund')

    // F. Arabic + dark, English + light.
    await setLocaleTheme(page, 'ar', 'dark')
    const arabic = await page.evaluate(() => ({
      dir: document.documentElement.dir,
      lang: document.documentElement.lang,
      dark:
        document.documentElement.classList.contains('dark') ||
        document.documentElement.dataset.theme === 'dark'
    }))
    await ctx.shot(page, 'F-arabic-dark')
    await setLocaleTheme(page, 'en', 'light')
    await ctx.shot(page, 'F-english-light')
    ctx.step('F: Arabic dark and English light', arabic)
    if (arabic.dir !== 'rtl') throw new Error('F: Arabic is not right-to-left')

    // G. Normal quit and start: still signed in.
    await controller.quit()
    page = await controller.start()
    await waitForRoute(page, 'pos')
    ctx.step('G: signed in after a normal restart (protected credentials read back)')
    await ctx.shot(page, 'G-after-restart')
    await controller.quit()
  } finally {
    await controller.stop().catch(() => undefined)
    await proxy.stop().catch(() => undefined)
    await sandbox.stop()
  }
}
