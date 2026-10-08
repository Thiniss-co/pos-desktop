import { readFileSync } from 'node:fs'
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
import { queryLocal } from '../support/localDb.mjs'
import { PACKAGED_APP_DIR, buildPackagedApp, launchPackagedApp } from '../support/packagedApp.mjs'
import { DESKTOP_ROOT } from '../support/paths.mjs'
import { freePort, startSandbox } from '../support/sandbox.mjs'
import { createTestCa, startTlsProxy, trustInIsolatedNss } from '../support/tlsBackend.mjs'

/**
 * V1 closeout — a RELEASE-configured package: built exactly as a release (production bundle, OS print
 * boundary, fuses, files allowlist) with an `https://` API origin and WITHOUT the loopback opt-in.
 * The disposable backend is reached through an HTTPS front with a throwaway CA.
 *
 *  0. The bundle carries the https origin and no loopback opt-in.
 *  1. Without the CA trusted, activation fails and no request reaches the backend: TLS is verified,
 *     not bypassed.
 *  2. With the CA trusted in an isolated NSS store (run-local HOME): activate → sign in → bootstrap →
 *     open shift → scanner sale → exact cash → upload → refund, all over HTTPS.
 */
const COLA = '6221000000011'

export async function run(ctx) {
  const tls = createTestCa(join(ctx.runDir, 'tls'))
  const sandbox = await startSandbox({ runDir: ctx.runDir, port: await freePort() })
  const front = await startTlsProxy(sandbox.origin, {
    port: await freePort(),
    key: tls.key,
    cert: tls.cert
  })
  ctx.step('disposable backend behind HTTPS', { backend: sandbox.origin, origin: front.origin })
  let app = null
  try {
    // 0. A release build: https origin, no opt-in.
    buildPackagedApp(front.origin, { allowLoopback: false })
    const bundle = readFileSync(join(DESKTOP_ROOT, 'out', 'main', 'index.js'), 'utf8')
    const releaseConfig = {
      httpsOrigin: bundle.includes(front.origin),
      loopbackOptIn: /MAIN_VITE_POS_ALLOW_LOOPBACK_ORIGIN["']?\s*:\s*["']true/.test(bundle)
    }
    ctx.step('0: release bundle', releaseConfig)
    if (!releaseConfig.httpsOrigin || releaseConfig.loopbackOptIn)
      throw new Error('0: the package is not release-configured')

    // 1. Untrusted certificate: refused.
    app = await launchPackagedApp({
      runDir: ctx.runDir,
      profileDir: join(ctx.runDir, 'profile-untrusted'),
      home: join(ctx.runDir, 'home-untrusted')
    })
    ctx.session = app
    const untrustedInfo = await app.page.evaluate(
      async () => (await window.posApi.system.getRuntimeInfo()).data
    )
    const servedBefore = front.served.length
    await app.page.getByLabel(await t(app.page, 'activation.companyCode')).fill('DESKTOP-MVP')
    await app.page
      .getByLabel(await t(app.page, 'activation.activationCode'))
      .fill('ACTIVATE-DESKTOP-MVP')
    await app.page.getByRole('button', { name: await t(app.page, 'activation.activate') }).click()
    const refusal = await app.page
      .waitForFunction(
        () =>
          [...document.querySelectorAll('[role=alert]')]
            .map((element) => element.textContent?.trim())
            .find(Boolean) ?? null,
        null,
        { timeout: 60_000 }
      )
      .then((handle) => handle.jsonValue())
    await ctx.shot(app.page, '01-untrusted-certificate-refused')
    const registered = await app.page.evaluate(
      async () => (await window.posApi.device.getIdentitySummary()).data
    )
    ctx.step('1: untrusted certificate', {
      apiConfiguration: untrustedInfo.apiConfiguration,
      refusal,
      registered: registered?.isRegistered ?? null,
      requestsServed: front.served.length - servedBefore
    })
    if (registered?.isRegistered || front.served.length !== servedBefore)
      throw new Error('1: a request went through an untrusted certificate')
    await app.close()
    app = null

    // 2. Trusted (isolated) — the full cashier journey over HTTPS.
    const home = join(ctx.runDir, 'home')
    trustInIsolatedNss(home, tls.caPem)
    const profileDir = join(ctx.runDir, 'profile')
    app = await launchPackagedApp({ runDir: ctx.runDir, profileDir, home })
    ctx.session = app
    const page = app.page
    await activate(ctx, page)
    await signIn(ctx, page)
    await waitForRoute(page, 'pos')
    const device = await deviceUuid(sandbox)
    sandbox.fixture('assign-device', device)
    await refreshWorkstation(ctx, page)
    await openShift(ctx, page)
    await scan(ctx, page, COLA)
    await payExactCash(ctx, page)
    await ctx.shot(page, '02-release-package-sale')
    await waitForServerInvoices(sandbox, device, 1, 90_000)
    const [sale] = queryLocal(
      profileDir,
      'SELECT local_uuid, sync_status FROM local_invoices ORDER BY created_at DESC LIMIT 1',
      [],
      PACKAGED_APP_DIR
    )
    ctx.step('2: sale uploaded over HTTPS', sale)
    const newSale = page
      .getByRole('dialog')
      .getByRole('button', { name: new RegExp(await t(page, 'pos.tender.newSale')) })
    if (await newSale.isVisible().catch(() => false)) await newSale.click()
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
    await dialog.getByText(await t(page, 'refunds.success')).waitFor({ timeout: 30_000 })
    await ctx.shot(page, '03-release-package-refund')
    const refunds = queryLocal(
      profileDir,
      'SELECT submission_state, remote_uuid FROM local_refunds',
      [],
      PACKAGED_APP_DIR
    )
    const served = {
      total: front.served.length,
      invoiceUploads: front.served.filter((line) => line.includes('/invoices/upload')).length,
      refundUploads: front.served.filter((line) => line.includes('/refunds/upload')).length
    }
    ctx.step('2: refund over HTTPS', { refunds, served })
    if (refunds[0]?.submission_state !== 'accepted' || served.refundUploads < 1)
      throw new Error('2: the refund did not complete over HTTPS')
  } finally {
    await app?.close()
    await front.stop()
    await sandbox.stop()
  }
}
