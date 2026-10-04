import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import {
  openSandboxAndApp,
  payExactCash,
  refreshWorkstation,
  relaunch,
  setupPhysicalPresenceTill,
  sizeWindow,
  waitForRoute,
  waitForServerInvoices
} from '../support/journey.mjs'
import { queryLocal } from '../support/localDb.mjs'

/**
 * Owner UX plan P8, end to end through BOTH real UIs against one disposable backend:
 *  1. the owner uploads an image in the company-owner SPA (headless Chrome) and the register shows it
 *     on the same product after a workstation refresh;
 *  2. the owner replaces it, and 3. removes it — the register follows each time although the catalog
 *     `generated_at` (and revision) never change;
 *  4. image cards stay selectable and a checkout completes and uploads;
 *  5. an offline restart shows the cached image and the monogram fallback;
 *  6. EN/AR × light/dark × desktop/compact.
 */

const ADMIN = { email: 'admin@desktop-mvp.test', password: 'Password123!' }
const VIEWPORTS = [
  { name: 'desktop', width: 1366, height: 850 },
  { name: 'compact', width: 900, height: 700 }
]

/** A synthetic PNG (GD): a coloured field with a light disc and a dark bar, so a screenshot shows it. */
function syntheticPng(path, width, height, [r, g, b]) {
  const source = `$i=imagecreatetruecolor(${width},${height});imagefill($i,0,0,imagecolorallocate($i,${r},${g},${b}));imagefilledellipse($i,${width / 2},${height / 2},${Math.round(width * 0.6)},${Math.round(height * 0.6)},imagecolorallocate($i,250,250,250));imagefilledrectangle($i,0,${height - 40},${width},${height},imagecolorallocate($i,20,20,20));imagepng($i,$argv[1]);`
  const result = spawnSync('php', ['-r', source, path], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`png: ${result.stderr}`)
  return path
}

async function card(page, name) {
  return await page.evaluate((productName) => {
    const frame = [...document.querySelectorAll('.product-card-frame')].find(
      (f) => f.querySelector('.product-card__name')?.textContent?.trim() === productName
    )
    if (!frame) return null
    const image = frame.querySelector('[data-testid="product-card-image"]')
    const box = image?.getBoundingClientRect()
    return {
      image: Boolean(image && image.complete && image.naturalWidth > 0),
      natural: image ? `${image.naturalWidth}x${image.naturalHeight}` : null,
      box: box ? `${Math.round(box.width)}x${Math.round(box.height)}` : null,
      src: image?.getAttribute('src')?.slice(0, 80) ?? null,
      monogram: image ? null : (frame.firstElementChild?.textContent?.trim() ?? null),
      disabled: frame.querySelector('button.product-card')?.disabled === true,
      inCart: frame.classList.contains('border-pri'),
      // Fully inside the window (screenshots must show it, not just the DOM).
      onScreen: box
        ? box.top >= 0 &&
          box.left >= 0 &&
          box.bottom <= window.innerHeight &&
          box.right <= window.innerWidth
        : null
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

async function reveal(page, name) {
  await page
    .locator('.product-card-frame', { hasText: name })
    .evaluate((frame) => frame.scrollIntoView({ block: 'center', inline: 'center' }))
  await page.waitForTimeout(300)
}

async function preferences(page, locale, theme) {
  await page.evaluate(
    ([l, th]) => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
      pinia._s.get('locale').setLocale(l)
      pinia._s.get('theme').setTheme(th)
    },
    [locale, theme]
  )
  await page.waitForFunction(
    ([l, th]) =>
      document.documentElement.lang.startsWith(l) && document.documentElement.dataset.theme === th,
    [locale, theme],
    { timeout: 10_000 }
  )
}

function catalogMeta(profileDir) {
  return queryLocal(
    profileDir,
    'SELECT revision, generated_at, valid_until FROM catalog_metadata'
  )[0]
}

/**
 * The backend stamps a catalog contract with the second it was issued, so two refreshes normally
 * install two contracts. This rewrite replays the installed contract's identity (generated_at,
 * valid_until, revision) on every later bootstrap — exactly a same-second re-issue — so an image
 * change reaches the register with an UNCHANGED catalog `generated_at` (the fast path).
 */
function pinContract(proxy, pinned) {
  const seen = []
  proxy.rule('pin-contract', /^GET \/api\/v1\/desktop\/bootstrap\?/, {
    transformBody(text) {
      let contract
      try {
        contract = JSON.parse(text)?.data?.catalog_contract
      } catch {
        return text
      }
      if (!contract?.generated_at) return text
      seen.push(contract.generated_at)
      return text
        .split(contract.generated_at)
        .join(pinned.generated_at)
        .split(contract.valid_until)
        .join(pinned.valid_until)
        .split(contract.revision)
        .join(pinned.revision)
    }
  })
  return seen
}

export async function run(ctx) {
  const session = await openSandboxAndApp(ctx, {
    flags: { POS_OFFLINE_PHYSICAL_PRESENCE_ENABLED: 'true' },
    proxy: true
  })
  const { sandbox, proxy } = session
  let page = session.page
  const images = {
    first: syntheticPng(join(ctx.runDir, 'owner-first.png'), 600, 450, [230, 120, 20]),
    second: syntheticPng(join(ctx.runDir, 'owner-second.png'), 450, 600, [20, 130, 160]),
    water: syntheticPng(join(ctx.runDir, 'owner-water.png'), 500, 500, [60, 90, 220])
  }
  const chrome = await chromium.launchPersistentContext(join(ctx.runDir, 'chrome'), {
    ...(process.env.PW_CHROME_PATH
      ? { executablePath: process.env.PW_CHROME_PATH }
      : { channel: 'chrome' }),
    headless: true,
    viewport: { width: 1280, height: 900 }
  })
  const owner = chrome.pages()[0] ?? (await chrome.newPage())
  const ownerUrl = (path) => new URL(path, sandbox.origin).toString()

  const ownerProduct = async (sku) => {
    const uuid = await owner.evaluate(async (code) => {
      const list = await (
        await fetch(`/api/v1/company-owner/products?search=${code}`, {
          credentials: 'same-origin',
          headers: { Accept: 'application/json' }
        })
      ).json()
      return list.data.find((p) => p.sku === code).id
    }, sku)
    await owner.goto(ownerUrl(`/owner/products/${uuid}`))
    await owner.getByTestId('product-image-field').waitFor()
    return uuid
  }
  const ownerUpload = async (sku, file, shot) => {
    await ownerProduct(sku)
    await owner.locator('#product-image-file').setInputFiles(file)
    const answer = owner.waitForResponse(
      (r) => r.request().method() === 'PUT' && /\/products\/[^/]+\/image$/.test(r.url())
    )
    await owner.getByTestId('product-image-save').click()
    const response = await answer
    if (response.status() !== 200) throw new Error(`owner upload answered ${response.status()}`)
    await owner.getByTestId('product-image-remove').waitFor()
    await owner.waitForTimeout(500)
    await ctx.shot(owner, shot)
    return (await response.json()).data
  }
  const ownerRemove = async (sku, shot) => {
    await ownerProduct(sku)
    const label = (await owner.getByTestId('product-image-remove').innerText()).trim()
    await owner.getByTestId('product-image-remove').click()
    const answer = owner.waitForResponse(
      (r) => r.request().method() === 'POST' && /\/products\/[^/]+\/image\/remove$/.test(r.url())
    )
    await owner
      .locator('[role=dialog],[role=alertdialog],dialog[open]')
      .getByRole('button', { name: label, exact: true })
      .click()
    const response = await answer
    if (response.status() !== 200) throw new Error(`owner remove answered ${response.status()}`)
    await owner.getByTestId('product-image-remove').waitFor({ state: 'detached' })
    await ctx.shot(owner, shot)
  }

  try {
    const device = await setupPhysicalPresenceTill(ctx, session)
    const meta0 = catalogMeta(session.profileDir)
    const before = await card(page, 'Cola Can')
    ctx.step('0: register before any image', { cola: before, catalog: meta0 })
    if (!before || before.image || !before.monogram) throw new Error('0: expected the monogram')
    await ctx.shot(page, '00-register-monogram')
    const issued = pinContract(proxy, meta0)

    await owner.goto(ownerUrl('/owner/login'))
    await owner.locator('#email').fill(ADMIN.email)
    await owner.locator('#password').fill(ADMIN.password)
    await owner.locator('button[type=submit]').click()
    await owner.waitForURL((u) => !u.pathname.endsWith('/login'))
    ctx.step('owner signed in to the company-owner SPA')

    // 1. Upload in the owner UI → shown on the register after a refresh.
    const uploaded = await ownerUpload('COLA-CAN', images.first, '01-owner-uploaded')
    ctx.step('1: owner uploaded COLA image', { image: uploaded?.image ?? uploaded })
    await refreshWorkstation(ctx, page)
    const cola1 = await waitCard(page, 'Cola Can', (s) => s.image, '1: COLA image not shown')
    const meta1 = catalogMeta(session.profileDir)
    ctx.step('1: register shows the uploaded image', { cola: cola1, catalog: meta1 })
    await ctx.shot(page, '01-register-image')

    // 2. Replace in the owner UI.
    await ownerUpload('COLA-CAN', images.second, '02-owner-replaced')
    await refreshWorkstation(ctx, page)
    const cola2 = await waitCard(
      page,
      'Cola Can',
      (s) => s.image && s.src !== cola1.src,
      '2: replaced image not shown'
    )
    const meta2 = catalogMeta(session.profileDir)
    ctx.step('2: register shows the replacement', { before: cola1, after: cola2, catalog: meta2 })
    await ctx.shot(page, '02-register-replaced')

    // A second product keeps an image for the offline and matrix checks.
    await ownerUpload('WATER-500', images.water, '03-owner-water')

    // 3. Remove in the owner UI.
    await ownerRemove('COLA-CAN', '03-owner-removed')
    await refreshWorkstation(ctx, page)
    const colaRemoved = await waitCard(
      page,
      'Cola Can',
      (s) => !s.image && s.monogram,
      '3: removed image still shown'
    )
    const water = await waitCard(page, 'Water Bottle', (s) => s.image, '3: WATER image not shown')
    const meta3 = catalogMeta(session.profileDir)
    ctx.step('3: removed image falls back to the monogram', {
      cola: colaRemoved,
      water,
      catalog: meta3
    })
    await ctx.shot(page, '03-register-removed')
    const metas = [meta0, meta1, meta2, meta3]
    if (metas.some((m) => m.generated_at !== meta0.generated_at || m.revision !== meta0.revision)) {
      throw new Error(`catalog generated_at/revision changed: ${JSON.stringify(metas)}`)
    }
    ctx.step('catalog generated_at and revision unchanged through every image change', {
      installed: meta0,
      backendIssuedMeanwhile: issued
    })
    proxy.clear('pin-contract')

    // 4. Selectable by click, and checkout completes and uploads — one sale per product, because
    // WATER (no tax) and COLA (taxed) may not share a cart (an existing, unrelated cart rule).
    const sellByCard = async (name, invoices, shot) => {
      await page
        .locator('.product-card-frame', { hasText: name })
        .locator('button.product-card')
        .click()
      const selected = await waitCard(
        page,
        name,
        (s) => s.inCart,
        `4: ${name} card click did not add it`
      )
      await ctx.shot(page, shot)
      await payExactCash(ctx, page)
      await page.keyboard.press('F9')
      await page.waitForTimeout(400)
      const report = await waitForServerInvoices(sandbox, device, invoices)
      ctx.step(`4: ${name} selected by its card, sold and uploaded`, {
        card: selected,
        invoices: report.device_invoice_count
      })
    }
    await sellByCard('Water Bottle', 1, '04-image-card-in-cart')
    await sellByCard('Cola Can', 2, '04-monogram-card-in-cart')

    // 6. EN/AR × light/dark × desktop/compact.
    const matrix = []
    for (const viewport of VIEWPORTS) {
      await sizeWindow(session, viewport.width, viewport.height)
      for (const locale of ['en', 'ar']) {
        for (const theme of ['light', 'dark']) {
          await preferences(page, locale, theme)
          await page.waitForTimeout(600)
          await reveal(page, 'Water Bottle')
          const w = await card(page, 'Water Bottle')
          const c = await card(page, 'Cola Can')
          const dir = await page.evaluate(() => document.documentElement.dir)
          matrix.push({ viewport: viewport.name, locale, theme, dir, water: w, cola: c })
          await ctx.shot(page, `matrix-${viewport.name}-${locale}-${theme}`)
          if (!w?.image || !w.onScreen || w.disabled)
            throw new Error(`6: WATER image missing ${JSON.stringify(w)}`)
          if (c?.image || !c?.monogram)
            throw new Error(`6: COLA fallback wrong ${JSON.stringify(c)}`)
        }
      }
    }
    ctx.step('6: matrix', matrix)
    await sizeWindow(session, 1366, 850)
    await preferences(page, 'en', 'light')

    // 5. Offline restart: cached image and fallback, still selectable.
    await proxy.offline()
    await page.evaluate(async () => await window.posApi.connectivity.checkNow())
    await relaunch(ctx, session)
    page = session.page
    await waitForRoute(page, 'pos')
    const waterOffline = await waitCard(
      page,
      'Water Bottle',
      (s) => s.image,
      '5: cached image not shown offline'
    )
    await sizeWindow(session, 1366, 850)
    await reveal(page, 'Water Bottle')
    const waterShown = await card(page, 'Water Bottle')
    if (!waterShown?.onScreen)
      throw new Error(`5: WATER not on screen ${JSON.stringify(waterShown)}`)
    await ctx.shot(page, '05-offline-restart')
    const colaOffline = await card(page, 'Cola Can')
    if (colaOffline?.image || !colaOffline?.monogram)
      throw new Error('5: COLA fallback wrong offline')
    const status = await page.evaluate(
      () =>
        document
          .querySelector('#app')
          .__vue_app__.config.globalProperties.$pinia._s.get('connectivity')?.snapshot?.status ??
        null
    )
    await page
      .locator('.product-card-frame', { hasText: 'Water Bottle' })
      .locator('button.product-card')
      .click()
    await waitCard(page, 'Water Bottle', (s) => s.inCart, '5: WATER not selectable offline')
    ctx.step('5: offline restart', { connectivity: status, water: waterOffline, cola: colaOffline })
    await ctx.shot(page, '05-offline-selected')
    await payExactCash(ctx, page)
    await page.keyboard.press('F9')
    await page.waitForTimeout(400)
    await proxy.online()
    await page.evaluate(async () => await window.posApi.connectivity.checkNow())
    const after = await waitForServerInvoices(sandbox, device, 3, 90_000)
    ctx.step('5: offline sale completed and uploaded after reconnecting', {
      invoices: after.device_invoice_count
    })
  } finally {
    await chrome.close().catch(() => undefined)
    await session.app.close().catch(() => undefined)
    await proxy?.stop()
    await sandbox.stop()
  }
}
