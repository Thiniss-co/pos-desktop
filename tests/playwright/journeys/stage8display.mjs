import { t } from '../support/app.mjs'
import {
  openSandboxAndApp,
  payExactCash,
  refreshWorkstation,
  scan,
  setupPhysicalPresenceTill,
  sizeWindow,
  waitForRoute
} from '../support/journey.mjs'

const VIEWPORTS = [
  { name: 'desktop', width: 1366, height: 850 },
  { name: 'compact', width: 900, height: 700 }
]
const LOCALES = ['en', 'ar']
const THEMES = ['light', 'dark']

async function pinia(page, id, expression) {
  return await page.evaluate(
    ([storeId, expr]) =>
      new Function('s', `return (${expr})`)(
        document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get(storeId)
      ),
    [id, expression]
  )
}

async function preferences(page, locale, theme) {
  await pinia(page, 'locale', `s.setLocale('${locale}')`)
  await pinia(page, 'theme', `s.setTheme('${theme}')`)
  await page.waitForFunction(
    ([l, th]) =>
      document.documentElement.lang.startsWith(l) && document.documentElement.dataset.theme === th,
    [locale, theme],
    { timeout: 10_000 }
  )
}

async function goto(page, route) {
  await page.goto(page.url().replace(/#.*$/, `#/${route}`))
  await waitForRoute(page, route)
  await page.waitForTimeout(700)
}

/** Every visible product card: name, stock chip, and whether it is dimmed, muted or disabled. */
async function cards(page) {
  return await page.evaluate(() =>
    [...document.querySelectorAll('.product-card-frame')].map((frame) => {
      const button = frame.querySelector('button.product-card')
      const chip = frame.querySelector('.app-status-chip')
      return {
        name: frame.querySelector('.product-card__name')?.textContent?.trim(),
        disabled: button?.disabled === true,
        dimmed: frame.querySelector('.opacity-60') !== null,
        muted: button?.classList.contains('text-muted') === true,
        chip: chip?.textContent?.trim(),
        chipTone: [...(chip?.classList ?? [])].find((c) => c.startsWith('app-status-chip--'))
      }
    })
  )
}

async function headerControlVisible(page, viewport) {
  const visible = async () =>
    await page.locator('[data-testid="workstation-refresh"]:visible').count()
  if ((await visible()) > 0) return true
  if (viewport !== 'compact') return false
  // Compact: the status group lives in the navigation drawer.
  const menu = page.getByRole('button', { name: await t(page, 'shell.menu') })
  if ((await menu.count()) === 0) return false
  await menu.first().click()
  await page.waitForTimeout(400)
  const found = (await visible()) > 0
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  return found
}

/**
 * Stage 8 (Rev 4 §4.3, §13, H1): on a physical-presence till, recorded zero, negative and missing
 * stock never dims, mutes or disables a product; figures are neutral "Recorded …" facts; the header
 * refresh control is on every page; EN/AR × light/dark × desktop/compact; RTL; scanning and
 * paying a zero-stock and a no-record product; focus returns to the scanner. Print is never pressed.
 */
export async function run(ctx) {
  const session = await openSandboxAndApp(ctx, {
    flags: { POS_OFFLINE_PHYSICAL_PRESENCE_ENABLED: 'true' },
    proxy: true
  })
  const { sandbox, proxy } = session
  const page = session.page
  try {
    ctx.step('WATER-500 recorded stock to 0', sandbox.fixture('adjust-stock', 'WATER-500:200'))
    ctx.step('owner product with no StockItem', sandbox.fixture('create-owner-product', 'PPNEW1'))
    await setupPhysicalPresenceTill(ctx, session)

    // CHIPS 150 → −10 through a real sale, then refresh so every figure is current.
    await scan(ctx, page, '160*6221000000035')
    await payExactCash(ctx, page)
    await page.keyboard.press('F9')
    await page.waitForTimeout(600)
    await refreshWorkstation(ctx, page)

    const matrix = []
    for (const viewport of VIEWPORTS) {
      await sizeWindow(session, viewport.width, viewport.height)
      for (const locale of LOCALES) {
        for (const theme of THEMES) {
          await preferences(page, locale, theme)
          await goto(page, 'pos')
          const facts = await cards(page)
          const dir = await page.evaluate(() => document.documentElement.dir)
          const header = await headerControlVisible(page, viewport.name)
          const bad = facts.filter((card) => card.disabled || card.dimmed || card.muted)
          const red = facts.filter((card) => card.chipTone === 'app-status-chip--error')
          matrix.push({
            viewport: viewport.name,
            locale,
            theme,
            dir,
            header,
            cards: facts.length,
            disabledOrDimmed: bad.map((card) => card.name),
            redChips: red.map((card) => card.name),
            chips: Object.fromEntries(facts.map((card) => [card.name, card.chip]))
          })
          await ctx.shot(page, `pos-${viewport.name}-${locale}-${theme}`)
          if (facts.length === 0) throw new Error('no product cards rendered')
          if (bad.length || red.length) {
            throw new Error(`a card was dimmed/disabled/red: ${JSON.stringify(matrix.at(-1))}`)
          }
          if (dir !== (locale === 'ar' ? 'rtl' : 'ltr')) throw new Error(`dir=${dir} for ${locale}`)
          if (!header) throw new Error(`header refresh control missing (${viewport.name})`)
        }
      }
    }
    ctx.step('A5 matrix: no product dimmed, disabled or red by stock', matrix)

    const recordedLabel = await t(page, 'pos.stock.noStockRecordYet')
    const chipsSeen = Object.values(matrix.at(-1).chips)
    if (!chipsSeen.includes(recordedLabel)) {
      throw new Error(`expected "${recordedLabel}" for the product with no stock record`)
    }

    // H1: the header control on every app page (desktop, both locales).
    await sizeWindow(session, 1366, 850)
    const pages = {}
    for (const locale of LOCALES) {
      await preferences(page, locale, 'light')
      for (const route of ['sales', 'sync', 'offline-stock', 'settings', 'pos']) {
        await goto(page, route)
        pages[`${locale}:${route}`] = await headerControlVisible(page, 'desktop')
        if (route === 'sales') await ctx.shot(page, `header-${route}-${locale}`)
      }
    }
    ctx.step('H1: header refresh control on every page', pages)
    if (Object.values(pages).some((visible) => !visible)) throw new Error('header control missing')

    // Scanner + payment in Arabic, dark, compact: zero-stock and no-record products sell; the
    // scanner has focus again afterwards. (Never press Print.)
    await sizeWindow(session, 900, 700)
    await preferences(page, 'ar', 'dark')
    await goto(page, 'pos')
    await scan(ctx, page, '6221000000028') // WATER, recorded 0
    await scan(ctx, page, 'OWNPPNEW1') // no stock record
    await payExactCash(ctx, page)
    await ctx.shot(page, 'sale-ar-dark-compact-committed')
    await page.keyboard.press('F9')
    await page.waitForTimeout(800)
    const focus = await page.evaluate(() => ({
      tag: document.activeElement?.tagName,
      label: document.activeElement?.getAttribute('aria-label') ?? null,
      id: document.activeElement?.id ?? null
    }))
    const scanLabel = await t(page, 'pos.quickSale.scanLabel')
    ctx.step('focus after the sale', { focus, scanLabel })
    await ctx.shot(page, 'after-sale-ar-dark-compact')
    const scanInput = page.getByLabel(scanLabel)
    if (!(await scanInput.evaluate((element) => element === document.activeElement))) {
      throw new Error('the scanner did not get focus back after the sale')
    }
    await preferences(page, 'en', 'light')
  } finally {
    await session.app.close().catch(() => undefined)
    await proxy?.stop()
    await sandbox.stop()
  }
}
