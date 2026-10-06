import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { t } from '../support/app.mjs'
import {
  activate,
  deviceUuid,
  openSandboxAndApp,
  openShift,
  refreshWorkstation,
  signIn,
  waitForRoute
} from '../support/journey.mjs'
import {
  VIEWPORTS,
  measureCart,
  namedBarcode,
  pinia,
  scanBurst,
  scanInField,
  setContentViewport,
  setLocaleTheme,
  setTouchMode,
  smallControls
} from '../support/workspace.mjs'

/**
 * POS workspace — the visual matrix.
 *
 *  A. EN/AR × light/dark × 1920×1080, 1366×768, 1024×768, 800×600 × compact (pointer) and comfortable
 *     (touch mode), Cart first, a 14-line cart with long names, fractional quantities and an offer:
 *     no horizontal overflow (> 1 CSS px), totals and payment controls fully visible, no visible control
 *     off screen, no two controls overlapping, and (touch) every control ≥ 44×44. Screenshot each.
 *  B. Each preset at 1366×768, both cart sides, the rail open, the More menu and the layout editor.
 *  C. A warning state (offline notice) keeps its content; rows are re-measured.
 *  D. Scanner focus survives menu close, preset change, Apply, Cancel and a resize: an unfocused
 *     scanner burst still adds to the cart after each.
 *  E. The runtime: Chromium version and native Popover / container query / anchor support.
 */
export async function run(ctx) {
  const session = await openSandboxAndApp(ctx, { proxy: true })
  const { page, sandbox, proxy } = session
  const results = []
  try {
    await setContentViewport(session, 1366, 768)
    await activate(ctx, page)
    await signIn(ctx, page)
    await waitForRoute(page, 'pos')
    sandbox.fixture('assign-device', await deviceUuid(sandbox))
    sandbox.fixture('create-named-products', '25')
    sandbox.fixture('offer-start', 'WS-03')
    await refreshWorkstation(ctx, page)
    await openShift(ctx, page)
    // 14 lines: long EN/AR names (WS-11 wraps), an offer (WS-03) and two fractional quantities.
    const fractions = { 4: '1.250', 9: '0.750' }
    for (let index = 1; index <= 14; index += 1) {
      await scanInField(
        page,
        fractions[index] ? `${fractions[index]}*${namedBarcode(index)}` : namedBarcode(index)
      )
    }

    // --- E. Runtime ------------------------------------------------------------------------------------
    const runtime = {
      versions: await session.app.evaluate(() => ({
        electron: process.versions.electron,
        chrome: process.versions.chrome
      })),
      features: await page.evaluate(() => ({
        popover: 'popover' in HTMLElement.prototype,
        containerQueries: CSS.supports('container-type: inline-size'),
        anchorPositioning: CSS.supports('anchor-name: --a')
      }))
    }
    ctx.step('E: runtime', runtime)

    // --- A. Matrix -------------------------------------------------------------------------------------
    for (const touch of [false, true]) {
      await setTouchMode(page, touch)
      for (const locale of ['en', 'ar']) {
        for (const theme of ['light', 'dark']) {
          await setLocaleTheme(page, locale, theme)
          for (const [width, height] of VIEWPORTS) {
            await setContentViewport(session, width, height)
            const facts = await inspect(page, touch)
            const label = `A-${touch ? 'touch' : 'compact'}-${locale}-${theme}-${width}x${height}`
            await ctx.shot(page, label)
            results.push({ label, ...facts })
            ctx.step('A: combination', {
              label,
              rows: facts.rows.fullyVisible,
              ordinary: facts.rows.fullyVisibleOrdinary,
              overflow: facts.horizontalOverflow,
              footer: facts.footerFullyVisible,
              offscreen: facts.offscreen.length,
              overlaps: facts.overlaps.length,
              small: facts.small.length
            })
          }
        }
      }
    }
    await setTouchMode(page, false)
    await setLocaleTheme(page, 'en', 'light')

    // --- B. Presets, sides, rail, menus, editor at 1366×768 -------------------------------------------
    await setContentViewport(session, 1366, 768)
    const apply = async (patch) =>
      await pinia(page, 'posWorkspace', `(s.beginEdit(), ${patch}, s.apply())`)
    for (const preset of ['cartFirst', 'balanced', 'scanner']) {
      await apply(`s.choosePreset('${preset}')`)
      for (const side of ['end', 'start']) {
        await apply(`s.patchDraft({ cartSide: '${side}' })`)
        const facts = await inspect(page, false)
        const label = `B-${preset}-${side}`
        results.push({ label, ...facts })
        await ctx.shot(page, label)
      }
    }
    await apply(`s.choosePreset('scanner')`)
    await page.locator('.pos-workspace-shell__rail-toggle').click()
    await page.locator('.pos-workspace-shell__browser').waitFor()
    results.push({ label: 'B-rail-open', ...(await inspect(page, false)) })
    await ctx.shot(page, 'B-rail-open')
    await page
      .getByRole('button', { name: await t(page, 'pos.workspace.closeProducts') })
      .first()
      .click()
    await apply(`s.choosePreset('cartFirst')`)
    await page.locator('.quick-actions [data-action="more"]').first().click()
    results.push({ label: 'B-more-menu', ...(await inspect(page, false)) })
    await ctx.shot(page, 'B-more-menu')
    await page.keyboard.press('Escape')
    await page.getByTestId('workspace-customize').click()
    results.push({ label: 'B-editor', ...(await inspect(page, false)) })
    await ctx.shot(page, 'B-editor')
    await page.getByTestId('workspace-cancel').click()

    // --- C. Warning state --------------------------------------------------------------------------------
    await proxy.offline()
    await page.evaluate(async () => await window.posApi.connectivity.checkNow())
    await page
      .waitForFunction(
        () =>
          document
            .querySelector('#app')
            .__vue_app__.config.globalProperties.$pinia._s.get('connectivity')?.snapshot?.status !==
          'online',
        null,
        { timeout: 60_000 }
      )
      .catch(() => undefined)
    await page.waitForTimeout(1000)
    for (const [width, height] of [VIEWPORTS[0], VIEWPORTS[1]]) {
      await setContentViewport(session, width, height)
      const facts = await inspect(page, false)
      const status = await pinia(page, 'connectivity', 's.snapshot?.status ?? null')
      results.push({ label: `C-offline-${width}x${height}`, status, ...facts })
      ctx.step('C: warning state', {
        size: `${width}x${height}`,
        status,
        notices: facts.regions.notices,
        rows: facts.rows.fullyVisible,
        ordinary: facts.rows.fullyVisibleOrdinary
      })
      await ctx.shot(page, `C-offline-${width}x${height}`)
    }
    await proxy.online()
    await page.evaluate(async () => await window.posApi.connectivity.checkNow())
    await setContentViewport(session, 1366, 768)

    // --- D. Scanner focus after workspace interactions ---------------------------------------------
    const scanned = []
    let next = 15
    const checkScan = async (after) => {
      await scanBurst(page, namedBarcode(next))
      scanned.push(after)
      next += 1
    }
    await page.locator('.quick-actions [data-action="more"]').first().click()
    await page.keyboard.press('Escape')
    await checkScan('menu closed (Esc)')
    await page
      .getByRole('button', {
        name: await t(page, 'pos.workspace.lineActions', {
          name: await pinia(page, 'cart', 's.lines[0].product.name')
        })
      })
      .click()
    await page.mouse.click(5, 300)
    await checkScan('line menu closed (outside click)')
    await page.getByTestId('workspace-customize').click()
    await page
      .getByTestId('workspace-preset')
      .getByRole('radio', { name: await t(page, 'pos.workspace.presets.balanced') })
      .click()
    await page.getByTestId('workspace-apply').click()
    await checkScan('preset changed + Apply')
    await page.getByTestId('workspace-customize').click()
    await page.getByTestId('workspace-cancel').click()
    await checkScan('Cancel')
    await setContentViewport(session, 1024, 768)
    await checkScan('window resized')
    ctx.step('D: scanner kept working after', { scanned })

    writeFileSync(
      join(ctx.evidenceDir, 'matrix.json'),
      JSON.stringify({ runtime, results }, null, 2)
    )
    const failures = results.filter(
      (r) =>
        r.horizontalOverflow ||
        (r.pageOverflowY?.amount ?? 0) > 1 ||
        r.footerFullyVisible === false ||
        r.offscreen.length > 0 ||
        r.overlaps.length > 0 ||
        (r.touch && r.small.length > 0)
    )
    ctx.step('A-C: summary', {
      checked: results.length,
      failures: failures.map((r) => ({
        label: r.label,
        overflow: r.horizontalOverflow,
        pageOverflowY: r.pageOverflowY?.amount,
        footer: r.footerFullyVisible,
        offscreen: r.offscreen.slice(0, 3),
        overlaps: r.overlaps.slice(0, 3),
        small: r.touch ? r.small.slice(0, 3) : []
      }))
    })
    if (failures.length > 0)
      throw new Error(`${failures.length} of ${results.length} states failed the layout checks`)
  } finally {
    if (results.length > 0)
      writeFileSync(join(ctx.evidenceDir, 'matrix-last.json'), JSON.stringify(results, null, 2))
    await session.app.close().catch(() => undefined)
    await proxy?.stop?.().catch?.(() => undefined)
    await sandbox.stop()
  }
}

/** Layout checks for the current screen: overflow, clipping, off-screen and overlapping controls. */
async function inspect(page, touch) {
  const cart = await measureCart(page)
  const geometry = await page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return (
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        Number(style.opacity) > 0 &&
        rect.width > 1 &&
        rect.height > 1 &&
        element.closest('[aria-hidden="true"], .sr-only, [inert]') === null
      )
    }
    // Clipped by a scroll container is expected for content (lines, products); only report controls
    // outside the viewport that are NOT inside a scroller.
    const insideScroller = (element) => {
      for (let node = element.parentElement; node; node = node.parentElement) {
        const style = getComputedStyle(node)
        if (/(auto|scroll)/.test(style.overflowY + style.overflowX)) return true
      }
      return false
    }
    const controls = [
      ...document.querySelectorAll(
        'button, [role="separator"][tabindex], input:not([type="hidden"]), select, a[href]'
      )
    ].filter(visible)
    const offscreen = controls
      .filter((element) => !insideScroller(element))
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(
        ({ rect }) =>
          rect.left < -1 ||
          rect.top < -1 ||
          rect.right > window.innerWidth + 1 ||
          rect.bottom > window.innerHeight + 1
      )
      .map(
        ({ element, rect }) =>
          `${(element.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 30)} @${Math.round(rect.left)},${Math.round(rect.top)}`
      )
    const boxes = controls
      .filter(
        (element) =>
          !insideScroller(element) ||
          element.closest('.quick-actions, .pos-cart-footer, .pos-page__edit-bar')
      )
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
    const overlaps = []
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i]
        const b = boxes[j]
        if (a.element.contains(b.element) || b.element.contains(a.element)) continue
        const x = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left)
        const y = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top)
        if (x > 1 && y > 1) {
          overlaps.push(
            `${(a.element.getAttribute('aria-label') ?? a.element.textContent ?? '').trim().slice(0, 24)} × ${(b.element.getAttribute('aria-label') ?? b.element.textContent ?? '').trim().slice(0, 24)}`
          )
        }
      }
    }
    // The total figure must sit fully inside the pinned footer.
    const total = document.querySelector('.order-totals__row--total dd')
    const footer = document.querySelector('.pos-cart-footer')
    const totalClipped =
      total && footer
        ? (() => {
            const a = total.getBoundingClientRect()
            const b = footer.getBoundingClientRect()
            return (
              a.left < b.left - 1 ||
              a.right > b.right + 1 ||
              a.top < b.top - 1 ||
              a.bottom > b.bottom + 1 ||
              total.scrollWidth > total.clientWidth + 1
            )
          })()
        : null
    return { offscreen, overlaps: overlaps.slice(0, 20), totalClipped }
  })
  const small = touch ? await smallControls(page) : []
  return {
    touch,
    ...cart,
    ...geometry,
    small,
    footerFullyVisible: cart.footerFullyVisible !== false && geometry.totalClipped !== true
  }
}
