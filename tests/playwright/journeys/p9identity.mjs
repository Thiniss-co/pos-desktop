import { t } from '../support/app.mjs'
import {
  launchAgain,
  openSandboxAndApp,
  payExactCash,
  refreshWorkstation,
  relaunch,
  scan,
  setupPhysicalPresenceTill,
  signIn,
  waitForRoute
} from '../support/journey.mjs'
import { ageAssetRetryStamps, queryLocal } from '../support/localDb.mjs'

/**
 * Owner UX plan P9 — the company identity on the register, against the real app and a disposable backend:
 *  1. the owner's logo, name and colour are applied after a bootstrap;
 *  2. they survive an offline restart;
 *  3. a logo fetch that fails leaves the name and the default mark, never the till offline; it is
 *     not fetched again within its delay, and arrives after it (aged with the app closed), across a restart;
 *  4. a changed colour is applied after the next bootstrap; 5. a removed logo falls back to the mark;
 *  6. a device re-registered to another company carries nothing of the first company over;
 *  7. a low-contrast colour gets adjusted or default text tokens;
 *  8. a sale's receipt is the same document before and after a brand change (it keeps its frozen
 *     receipt profile). Previewed only — no real printer is used.
 */

const BRAND_ASSETS = /^GET \/api\/v1\/desktop\/company-branding\/assets\//

async function topBar(page) {
  return await page.evaluate(() => {
    const logo = document.querySelector('[data-testid="top-bar-logo"]')
    return {
      logo: Boolean(logo && logo.complete && logo.naturalWidth > 0),
      name: document.querySelector('[data-testid="top-bar-name"]')?.textContent?.trim() ?? null,
      pri: document.documentElement.style.getPropertyValue('--color-pri'),
      priText: document.documentElement.style.getPropertyValue('--color-pri-text')
    }
  })
}

async function waitTopBar(page, predicate, label, timeout = 45_000) {
  const deadline = Date.now() + timeout
  let state = null
  while (Date.now() < deadline) {
    state = await topBar(page)
    if (predicate(state)) return state
    await page.waitForTimeout(500)
  }
  throw new Error(`${label}: ${JSON.stringify(state)}`)
}

async function receiptHash(page, profileDir) {
  const invoice = queryLocal(
    profileDir,
    'SELECT local_uuid FROM local_invoices ORDER BY rowid DESC LIMIT 1'
  )[0]
  const result = await page.evaluate(
    async (uuid) =>
      await window.posApi.printing.preview({
        document: { kind: 'sale', invoiceLocalUuid: uuid },
        locale: 'en',
        overrides: {}
      }),
    invoice.local_uuid
  )
  if (!result.ok) throw new Error(`receipt preview failed: ${JSON.stringify(result)}`)
  return result.data.previewDocumentSha256
}

export async function run(ctx) {
  const session = await openSandboxAndApp(ctx, {
    flags: { POS_OFFLINE_PHYSICAL_PRESENCE_ENABLED: 'true' },
    proxy: true
  })
  const { sandbox, proxy } = session
  let page = session.page
  try {
    // 1. Applied after a bootstrap.
    ctx.step('brand set by the owner', sandbox.fixture('brand', '#0e9f8e:logo1'))
    const device = await setupPhysicalPresenceTill(ctx, session)
    const applied = await waitTopBar(
      page,
      (s) => s.logo && s.name === 'Desktop MVP Demo Company' && s.pri.includes('#0e9f8e'),
      '1: brand not applied'
    )
    ctx.step('1: logo, name and colour applied', applied)
    await ctx.shot(page, '01-brand-applied')

    // 8 (before): a sale and its receipt preview under the current brand.
    await scan(ctx, page, '6221000000042')
    await payExactCash(ctx, page)
    await page.keyboard.press('F9')
    await page.waitForTimeout(400)
    const receiptBefore = await receiptHash(page, session.profileDir)

    // 3. A logo fetch that fails: the name and the default mark; the till stays online.
    proxy.rule('brand-404', BRAND_ASSETS, { status: 404, code: 'NOT_FOUND', times: 1 })
    ctx.step('new logo; its fetch answers 404', sandbox.fixture('brand', '#0e9f8e:logo2'))
    await refreshWorkstation(ctx, page)
    await page.waitForTimeout(2500)
    const failed = await topBar(page)
    const connectivity = await page.evaluate(
      () =>
        document
          .querySelector('#app')
          .__vue_app__.config.globalProperties.$pinia._s.get('connectivity')?.snapshot?.status ??
        null
    )
    ctx.step('3: logo fetch failed', { ...failed, connectivity })
    if (failed.logo) throw new Error('3: a logo was shown although its fetch failed')
    if (failed.name !== 'Desktop MVP Demo Company') throw new Error('3: the company name was lost')
    if (connectivity !== 'online') throw new Error(`3: connectivity moved to ${connectivity}`)
    proxy.clear('brand-404')

    // The failed logo waits a minute: a bootstrap inside the delay fetches nothing.
    const requestsAfter404 = proxy.requests(BRAND_ASSETS).length
    await refreshWorkstation(ctx, page)
    await page.waitForTimeout(2500)
    const withinDelay = {
      logo: (await topBar(page)).logo,
      logoRequests: proxy.requests(BRAND_ASSETS).length - requestsAfter404
    }
    ctx.step('3: not retried within the delay', withinDelay)
    if (withinDelay.logo || withinDelay.logoRequests !== 0) {
      throw new Error('3: the failed logo was retried within its delay')
    }

    // A minute later (the stamp aged while the app is closed), across a restart: retried and shown.
    await session.app.close()
    ctx.step('logo retry stamp aged 61s with the app closed', {
      aged: ageAssetRetryStamps(session.profileDir, 'company_brand_assets', 61)
    })
    await launchAgain(ctx, session)
    page = session.page
    await waitForRoute(page, 'pos')
    await refreshWorkstation(ctx, page)
    await waitTopBar(page, (s) => s.logo, '3: the new logo did not arrive after its delay')
    ctx.step('3: the new logo arrived on a bootstrap after its delay, across a restart', {
      logoRequests: proxy.requests(BRAND_ASSETS).length - requestsAfter404
    })

    // 4. A changed colour.
    sandbox.fixture('brand', '#2563eb:keep')
    await refreshWorkstation(ctx, page)
    const recoloured = await waitTopBar(
      page,
      (s) => s.pri.includes('#2563eb'),
      '4: colour not updated'
    )
    ctx.step('4: colour updated after the next bootstrap', recoloured)

    // 8 (after): the same sale's receipt is the same document.
    const receiptAfter = await receiptHash(page, session.profileDir)
    ctx.step('8: receipt preview before and after the brand change', {
      receiptBefore,
      receiptAfter
    })
    if (receiptBefore !== receiptAfter) throw new Error('8: the receipt changed with the brand')

    // 2. Offline restart keeps it.
    await proxy.offline()
    await page.evaluate(async () => await window.posApi.connectivity.checkNow())
    await relaunch(ctx, session)
    page = session.page
    await waitForRoute(page, 'pos')
    const offline = await waitTopBar(
      page,
      (s) => s.logo && s.pri.includes('#2563eb'),
      '2: brand lost offline'
    )
    ctx.step('2: brand kept after an offline restart', offline)
    await ctx.shot(page, '02-brand-offline-restart')
    await proxy.online()
    await page.evaluate(async () => await window.posApi.connectivity.checkNow())

    // 7. A low-contrast colour: the text tokens are adjusted or the default.
    sandbox.fixture('brand', '#ffff00:keep')
    await refreshWorkstation(ctx, page)
    const yellow = await waitTopBar(page, (s) => s.pri.includes('#ffff00'), '7: colour not applied')
    const lightText = /light-dark\((#[0-9a-f]{6})/.exec(yellow.priText)?.[1] ?? null
    ctx.step('7: low-contrast colour', { pri: yellow.pri, priText: yellow.priText })
    if (lightText === null || lightText === '#ffff00')
      throw new Error('7: unreadable text token kept')
    await ctx.shot(page, '07-low-contrast')

    // 5. Removed logo: the default mark, the colour stays.
    sandbox.fixture('brand', '#2563eb:nologo')
    await refreshWorkstation(ctx, page)
    const removed = await waitTopBar(
      page,
      (s) => !s.logo && s.pri.includes('#2563eb'),
      '5: logo still shown'
    )
    ctx.step('5: removed logo falls back to the default mark', removed)
    await ctx.shot(page, '05-logo-removed')

    // 6. Re-registered to another company: nothing carries over.
    sandbox.fixture('brand', '#e11d48:logo1')
    sandbox.fixture('product-image', 'COLA-CAN:1')
    await refreshWorkstation(ctx, page)
    await waitTopBar(page, (s) => s.logo, '6: first company logo not shown before re-registration')
    const second = sandbox.fixture('second-company')
    ctx.step('second company seeded (simulated precondition)', second)
    ctx.step(
      'device moved to the other company on the server (simulated: no product flow re-registers a till elsewhere)',
      sandbox.fixture('move-device-other', device)
    )
    // The cashier signs out; the other company's cashier signs in on the same till.
    await page.getByRole('button', { name: await t(page, 'shell.user.menuLabel') }).click()
    await page.getByRole('menuitem', { name: await t(page, 'common.signOut') }).click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: await t(page, 'common.signOut') })
      .click()
    await waitForRoute(page, 'login')
    const otherDevice = queryLocal(session.profileDir, 'SELECT device_uuid FROM device_identity')[0]
      .device_uuid
    sandbox.fixture('assign-device-other', otherDevice)
    await signIn(ctx, page, { email: 'other-cashier@desktop-mvp.test', password: 'Password123!' })
    const companyCode = await t(page, 'activation.companyCode')
    await page.waitForFunction(
      (label) => {
        const route =
          document.querySelector('#app')?.__vue_app__?.config.globalProperties.$router.currentRoute
            .value.name
        return (
          route === 'pos' ||
          [...document.querySelectorAll('label')].some((l) => l.textContent?.includes(label))
        )
      },
      companyCode,
      { timeout: 60_000 }
    )
    if (
      await page
        .getByLabel(companyCode)
        .isVisible()
        .catch(() => false)
    ) {
      // The till asks to be activated again: it is, for the other company.
      await page.getByLabel(companyCode).fill('OTHER-CO')
      await page.getByLabel(await t(page, 'activation.activationCode')).fill('ACTIVATE-OTHER-CO')
      await page
        .getByLabel(await t(page, 'activation.deviceName'))
        .fill('Playwright till (other company)')
      await page.getByRole('button', { name: await t(page, 'activation.activate') }).click()
      ctx.step('activated again for the other company')
      await signIn(ctx, page, { email: 'other-cashier@desktop-mvp.test', password: 'Password123!' })
    }
    await waitForRoute(page, 'pos')
    await refreshWorkstation(ctx, page)
    const other = await waitTopBar(
      page,
      (s) => s.name === 'Other Company',
      '6: other company not shown'
    )
    const leftovers = {
      productImages: queryLocal(
        session.profileDir,
        'SELECT COUNT(*) AS n FROM catalog_product_images WHERE company_uuid <> ? OR thumb_sha256 IS NOT NULL',
        [second.company]
      )[0].n,
      branding: queryLocal(
        session.profileDir,
        'SELECT COUNT(*) AS n FROM company_branding WHERE primary_color IS NOT NULL'
      )[0].n
    }
    ctx.step('6: after re-registration', { ...other, leftovers })
    if (
      other.logo ||
      other.pri !== '' ||
      leftovers.productImages !== 0 ||
      leftovers.branding !== 0
    ) {
      throw new Error('6: something of the first company carried over')
    }
    await ctx.shot(page, '06-other-company')
  } finally {
    await session.app.close().catch(() => undefined)
    await session.proxy?.stop().catch(() => undefined)
    await session.sandbox.stop()
  }
}
