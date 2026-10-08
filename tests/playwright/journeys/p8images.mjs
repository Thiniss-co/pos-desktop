import { t } from '../support/app.mjs'
import {
  launchAgain,
  MANAGER,
  openSandboxAndApp,
  payExactCash,
  refreshWorkstation,
  relaunch,
  scan,
  setupPhysicalPresenceTill,
  signIn,
  waitForRoute,
  waitForServerInvoices
} from '../support/journey.mjs'
import { ageAssetRetryStamps, queryLocal } from '../support/localDb.mjs'

/**
 * Owner UX plan P8 — product images on the register, against the real app and a disposable backend:
 *  1. an image set by the owner is shown after a bootstrap;
 *  2. it is shown again from the local cache after an offline restart;
 *  3. asset fetches that fail (404, timeout) leave the monogram, never the till offline, and a sale
 *     still completes; a failed asset is not fetched again within its delay (1 then 5 minutes, aged
 *     with the app closed), and arrives on a bootstrap after it, across restarts;
 *  4. a replaced image is shown after the next bootstrap; 5. a removed one falls back to the monogram;
 *  7. signing out during a sweep stops it and nothing fetched after that is stored;
 *  8. a checkout during a sweep completes and uploads unchanged.
 * Scenario 6 (re-registration to another company) belongs to the P9 company-change journey; the
 * register-side clearing is covered by the productImages Electron suite.
 */

const ASSETS = /^GET \/api\/v1\/desktop\/product-image-assets\//

async function card(page, name) {
  return await page.evaluate((productName) => {
    const frame = [...document.querySelectorAll('.product-card-frame')].find(
      (f) => f.querySelector('.product-card__name')?.textContent?.trim() === productName
    )
    if (!frame) return null
    const image = frame.querySelector('[data-testid="product-card-image"]')
    return {
      image: Boolean(image && image.complete && image.naturalWidth > 0),
      src: image?.getAttribute('src')?.slice(0, 80) ?? null,
      monogram: image ? null : (frame.firstElementChild?.textContent?.trim() ?? null)
    }
  }, name)
}

async function waitCard(page, name, predicate, label, timeout = 45_000) {
  const deadline = Date.now() + timeout
  let state = null
  while (Date.now() < deadline) {
    state = await card(page, name)
    if (state && predicate(state)) return state
    await page.waitForTimeout(500)
  }
  throw new Error(`${label}: ${JSON.stringify(state)}`)
}

async function connectivity(page) {
  return await page.evaluate(
    () =>
      document
        .querySelector('#app')
        .__vue_app__.config.globalProperties.$pinia._s.get('connectivity')?.snapshot?.status ?? null
  )
}

/** Closes the app, ages the image retry stamps by `seconds`, and launches it again on the same profile. */
async function restartAfter(ctx, session, seconds) {
  await session.app.close()
  const aged = ageAssetRetryStamps(session.profileDir, 'product_image_assets', seconds)
  ctx.step(`retry stamps aged ${seconds}s with the app closed`, { aged })
  await launchAgain(ctx, session)
  await waitForRoute(session.page, 'pos')

  return session.page
}

function localAssets(profileDir) {
  const rows = queryLocal(
    profileDir,
    'SELECT status, COUNT(*) AS n FROM product_image_assets GROUP BY status'
  )
  return Object.fromEntries(rows.map((row) => [row.status, row.n]))
}

export async function run(ctx) {
  const session = await openSandboxAndApp(ctx, {
    flags: { POS_OFFLINE_PHYSICAL_PRESENCE_ENABLED: 'true' },
    proxy: true
  })
  const { sandbox, proxy } = session
  let page = session.page
  try {
    // 1. The owner set an image before the till's first bootstrap.
    ctx.step('COLA image set by the owner', sandbox.fixture('product-image', 'COLA-CAN:1'))
    const device = await setupPhysicalPresenceTill(ctx, session)
    const cola1 = await waitCard(page, 'Cola Can', (s) => s.image, '1: COLA image not shown')
    ctx.step('1: image shown after bootstrap', {
      cola: cola1,
      assets: localAssets(session.profileDir)
    })
    await ctx.shot(page, '01-image-after-bootstrap')

    // 3. Failing asset fetches: 404, then a timeout. The monogram stays, the till stays online, a sale works.
    proxy.rule('assets-404', ASSETS, { status: 404, code: 'NOT_FOUND', times: 2 })
    ctx.step(
      'WATER image set; its assets answer 404',
      sandbox.fixture('product-image', 'WATER-500:2')
    )
    await refreshWorkstation(ctx, page)
    await page.waitForTimeout(3000)
    const water404 = await card(page, 'Water Bottle')
    const online404 = await connectivity(page)
    ctx.step('3: 404 assets', {
      water: water404,
      connectivity: online404,
      assetRequests: proxy.requests(ASSETS).length
    })
    if (water404?.image) throw new Error('3: an image was shown although its asset answered 404')
    if (online404 !== 'online')
      throw new Error(`3: connectivity moved to ${online404} after an image failure`)
    await scan(ctx, page, '6221000000028')
    await payExactCash(ctx, page)
    await page.keyboard.press('F9') // New sale: closes the payment result
    await page.waitForTimeout(400)
    await waitForServerInvoices(sandbox, device, 1)
    ctx.step('3: a sale completed and uploaded while images failed')
    proxy.clear('assets-404')

    // The failed assets wait (1 minute after a first failure): a bootstrap inside the delay fetches nothing.
    const requestsAfter404 = proxy.requests(ASSETS).length
    await refreshWorkstation(ctx, page)
    await page.waitForTimeout(3000)
    const withinDelay = { assetRequests: proxy.requests(ASSETS).length - requestsAfter404 }
    ctx.step('3: not retried within the delay', withinDelay)
    if (withinDelay.assetRequests !== 0)
      throw new Error('3: a failed asset was retried within its delay')

    // A minute later (the stamps aged while the app is closed), across a restart: retried, one asset times out.
    page = await restartAfter(ctx, session, 61)
    proxy.rule('assets-timeout', ASSETS, { delayMs: 12_000, times: 1 })
    await refreshWorkstation(ctx, page)
    await page.waitForTimeout(14_000)
    ctx.step(
      '3: retried after the delay and a restart; one asset delayed past the client timeout',
      {
        connectivity: await connectivity(page),
        assetRequests: proxy.requests(ASSETS).length - requestsAfter404,
        local: localAssets(session.profileDir)
      }
    )
    proxy.clear('assets-timeout')

    // After a second failure the wait is five minutes.
    page = await restartAfter(ctx, session, 301)
    await refreshWorkstation(ctx, page)
    const water = await waitCard(
      page,
      'Water Bottle',
      (s) => s.image,
      '3: WATER image not retried on a later bootstrap',
      60_000
    )
    ctx.step('3: image arrived on a later bootstrap', { water })
    await ctx.shot(page, '03-image-after-retry')

    // 4. Replaced: the new image after the next bootstrap. 5. Removed: the monogram.
    ctx.step('COLA image replaced', sandbox.fixture('product-image', 'COLA-CAN:2'))
    await refreshWorkstation(ctx, page)
    const cola2 = await waitCard(
      page,
      'Cola Can',
      (s) => s.image && s.src !== cola1.src,
      '4: replaced image not shown'
    )
    ctx.step('4: replaced image shown', { before: cola1.src, after: cola2.src })
    ctx.step('COLA image removed', sandbox.fixture('product-image', 'COLA-CAN:remove'))
    await refreshWorkstation(ctx, page)
    const colaRemoved = await waitCard(
      page,
      'Cola Can',
      (s) => !s.image && s.monogram,
      '5: removed image still shown'
    )
    ctx.step('5: removed image falls back to the monogram', { cola: colaRemoved })
    await ctx.shot(page, '05-image-removed')

    // 8. A checkout during a sweep, and 7. signing out during it.
    proxy.rule('assets-slow', ASSETS, { delayMs: 4000 })
    sandbox.fixture('product-image', 'CHIPS-S:3')
    sandbox.fixture('product-image', 'COLA-CAN:1')
    await refreshWorkstation(ctx, page)
    const invoicesBefore = sandbox.fixture('report', device).device_invoice_count
    await scan(ctx, page, '6221000000035')
    await payExactCash(ctx, page)
    await page.keyboard.press('F9') // New sale: closes the payment result
    await page.waitForTimeout(400)
    const report = await waitForServerInvoices(sandbox, device, invoicesBefore + 1)
    ctx.step('8: a sale during the image sweep completed and uploaded', {
      invoices: report.device_invoice_count
    })

    await page.getByRole('button', { name: await t(page, 'shell.user.menuLabel') }).click()
    await page.getByRole('menuitem', { name: await t(page, 'common.signOut') }).click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: await t(page, 'common.signOut') })
      .click()
    await waitForRoute(page, 'login')
    // Measured once sign-out has completed: an image that finished before then was fetched for the signed-in owner.
    const beforeSignOut = localAssets(session.profileDir)
    const signOutAt = Date.now()
    await page.waitForTimeout(12_000)
    const afterSignOut = localAssets(session.profileDir)
    const requestsAfter = proxy
      .requests(ASSETS)
      .filter((entry) => entry.at > signOutAt + 500).length
    ctx.step('7: signed out during a sweep', {
      beforeSignOut,
      afterSignOut,
      assetRequestsAfterSignOut: requestsAfter
    })
    if ((afterSignOut.available ?? 0) !== (beforeSignOut.available ?? 0)) {
      throw new Error('7: an image fetched after sign-out was stored')
    }
    if (requestsAfter > 0) throw new Error(`7: ${requestsAfter} asset requests after sign-out`)
    proxy.clear('assets-slow')

    await signIn(ctx, page, MANAGER)
    await waitForRoute(page, 'pos')
    await refreshWorkstation(ctx, page)
    const chips = await waitCard(
      page,
      'Chips Small',
      (s) => s.image,
      'after sign-in: CHIPS image not completed',
      60_000
    )
    ctx.step('the next session completes the sweep', {
      chips,
      assets: localAssets(session.profileDir)
    })
    await ctx.shot(page, '07-after-next-sign-in')

    // 2. Offline restart: the cached image is shown without the backend.
    await proxy.offline()
    await page.evaluate(async () => await window.posApi.connectivity.checkNow())
    await relaunch(ctx, session)
    page = session.page
    await waitForRoute(page, 'pos')
    const waterOffline = await waitCard(
      page,
      'Water Bottle',
      (s) => s.image,
      '2: cached image not shown offline'
    )
    ctx.step('2: cached image shown after an offline restart', { water: waterOffline })
    await ctx.shot(page, '02-image-offline-restart')
    await proxy.online()
    await page.evaluate(async () => await window.posApi.connectivity.checkNow())
  } finally {
    await session.app.close().catch(() => undefined)
    await session.proxy?.stop().catch(() => undefined)
    await session.sandbox.stop()
  }
}
