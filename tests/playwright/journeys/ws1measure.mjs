import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openSandboxAndApp, refreshWorkstation } from '../support/journey.mjs'
import {
  VIEWPORTS,
  buildNamedCart,
  measureCart,
  pinia,
  plainBarcode,
  quickAction,
  scanInField,
  setContentViewport,
  setTouchMode,
  setupNamedTill,
  t
} from '../support/workspace.mjs'

/**
 * POS workspace — measured cart density for two 25-line carts, before and after.
 *
 * 1. STRESS cart (unchanged fixture and order): WS-01…WS-25, realistic EN/AR names (three very long,
 *    many wrapping in narrow carts), three fractional quantities keyed as `<qty>*<barcode>` and a
 *    live register offer on WS-03. Built through the scan field, never through the store.
 * 2. ORDINARY cart: the stress cart is cleared through the UI (More → Clear cart → confirm), then
 *    PL-01…PL-25 (short single-line EN/AR names; PL-06 and PL-07 fractional) are scanned the same way.
 *
 * Per cart, viewport (1920×1080, 1366×768, 1024×768, 800×600) and density it records the renderer's
 * real viewport, every region's rectangle, each row's height, and the rows FULLY visible through
 * every clipping ancestor at scrollTop 0 (total and "ordinary": one-line name, no offer). A warning
 * state (backend unreachable: two shell banners) is measured on the stress cart.
 *
 * Phase: `before` on the original screen, `after` once the workspace renders `data-preset`.
 * Evidence: `<phase>-<cart>-<mode>-<WxH>.png` and `measure-<phase>.json`.
 *
 * Gates (after only), standard state (no shell notice, no recovery banner, no cart error):
 *  - stress cart, compact, 1920×1080: ≥ 20 fully visible ordinary rows;
 *  - ordinary cart, touch mode, 800×600: ≥ 3 fully visible ordinary rows, the scanner and the whole
 *    checkout band visible, no horizontal or page overflow;
 *  - ordinary cart, compact, 800×600: the same ≥ 3 minimum.
 */
export async function run(ctx) {
  const session = await openSandboxAndApp(ctx, { proxy: true })
  const { page, sandbox, proxy } = session
  const results = []
  try {
    await setupNamedTill(ctx, session, { plainProducts: 25 })
    ctx.step('offer precondition', sandbox.fixture('offer-start', 'WS-03'))
    await refreshWorkstation(ctx, page)
    await buildNamedCart(ctx, page)

    const phase = (await page.locator('[data-preset]').count()) > 0 ? 'after' : 'before'
    ctx.step('phase', { phase })
    const modes =
      phase === 'after'
        ? [
            { mode: 'compact', touch: false, density: 'compact' },
            { mode: 'comfortable', touch: false, density: 'comfortable' },
            { mode: 'touch', touch: true, density: null }
          ]
        : [
            { mode: 'desktop', touch: false, density: null },
            { mode: 'touch', touch: true, density: null }
          ]

    const applyDensity = async (density) => {
      // Through the real store path (draft → Apply), exactly what the layout editor does.
      const saved = await pinia(
        page,
        'posWorkspace',
        `(s.beginEdit(), s.patchDraft({ density: '${density}' }), s.apply())`
      )
      if (saved !== true) throw new Error(`density ${density} was not applied`)
    }

    const measureAll = async (cart) => {
      for (const { mode, touch, density } of modes) {
        await setTouchMode(page, touch)
        if (density) await applyDensity(density)
        for (const [width, height] of VIEWPORTS) {
          const viewport = await setContentViewport(session, width, height)
          const facts = await measureCart(page)
          results.push({
            phase,
            cart,
            mode,
            size: `${width}x${height}`,
            state: 'standard',
            viewport,
            ...facts
          })
          ctx.step('measured', summary(phase, cart, mode, width, height, facts))
          await ctx.shot(page, `${phase}-${cart}-${mode}-${width}x${height}`)

          // The original screen hides the cart below 900px: measure the opened sheet separately.
          const viewCart = page.getByRole('button', { name: await t(page, 'pos.cart.viewCart') })
          if (phase === 'before' && (await viewCart.isVisible().catch(() => false))) {
            await viewCart.click()
            await page.waitForTimeout(300)
            const sheet = await measureCart(page)
            results.push({
              phase,
              cart,
              mode,
              size: `${width}x${height}`,
              state: 'cart-sheet-open',
              viewport,
              ...sheet
            })
            ctx.step('measured (cart sheet open)', summary(phase, cart, mode, width, height, sheet))
            await ctx.shot(page, `${phase}-${cart}-${mode}-${width}x${height}-cart-sheet`)
            await page.getByRole('button', { name: await t(page, 'pos.cart.closeCart') }).click()
            await page.waitForTimeout(200)
          }
        }
      }
      await setTouchMode(page, false)
      if (phase === 'after') await applyDensity('compact')
    }

    // --- 1. Stress cart -------------------------------------------------------------------------
    await measureAll('stress')

    // Warning state: the register goes offline; the connectivity notices take their real height.
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
        { timeout: 90_000 }
      )
      .catch(() => undefined)
    await page.waitForTimeout(1500)
    const connectivityStatus = await pinia(page, 'connectivity', 's.snapshot?.status ?? null')
    ctx.step('connectivity before the warning-state measurement', { connectivityStatus })
    for (const [width, height] of [VIEWPORTS[0], VIEWPORTS[1]]) {
      const viewport = await setContentViewport(session, width, height)
      const facts = await measureCart(page)
      results.push({
        phase,
        cart: 'stress',
        mode: phase === 'after' ? 'compact' : 'desktop',
        size: `${width}x${height}`,
        state: 'offline-notice',
        connectivityStatus,
        viewport,
        ...facts
      })
      ctx.step(
        'measured (offline notice)',
        summary(phase, 'stress', 'offline', width, height, facts)
      )
      await ctx.shot(page, `${phase}-stress-offline-${width}x${height}`)
    }
    await proxy.online()
    await page.evaluate(async () => await window.posApi.connectivity.checkNow())

    // --- 2. Ordinary cart -------------------------------------------------------------------------
    await setContentViewport(session, 1366, 768)
    if (phase === 'after') {
      await (await quickAction(page, 'clear')).click()
    } else {
      await page
        .getByRole('button', { name: await t(page, 'pos.cart.clear') })
        .first()
        .click()
    }
    await page
      .locator('[role=dialog],[role=alertdialog]')
      .getByRole('button', { name: await t(page, 'pos.cart.clear') })
      .click()
    await page.waitForFunction(
      () =>
        document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('cart')
          .lines.length === 0
    )
    const fractions = { 6: '1.250', 7: '0.750' }
    for (let index = 1; index <= 25; index += 1) {
      await scanInField(
        page,
        fractions[index] ? `${fractions[index]}*${plainBarcode(index)}` : plainBarcode(index)
      )
    }
    ctx.step('ordinary cart built through the scan field', {
      lines: await pinia(page, 'cart', 's.lines.length')
    })
    await measureAll('ordinary')

    writeFileSync(join(ctx.evidenceDir, `measure-${phase}.json`), JSON.stringify(results, null, 2))

    if (phase === 'after') {
      const find = (cart, mode, size) =>
        results.find(
          (r) => r.cart === cart && r.mode === mode && r.size === size && r.state === 'standard'
        )
      const gate = find('stress', 'compact', '1920x1080')
      if (!gate || gate.rows.fullyVisibleOrdinary < 20) {
        throw new Error(
          `gate: ${gate?.rows.fullyVisibleOrdinary} fully visible ordinary rows at 1920x1080 compact (need ≥ 20)`
        )
      }
      for (const mode of ['touch', 'compact']) {
        const small = find('ordinary', mode, '800x600')
        if (
          !small ||
          small.rows.fullyVisibleOrdinary < 3 ||
          !small.footerFullyVisible ||
          !small.regions.scan ||
          small.horizontalOverflow ||
          (small.pageOverflowY?.amount ?? 0) > 1
        ) {
          throw new Error(
            `gate: 800x600 ${mode} ordinary cart keeps too little: ${JSON.stringify(small?.rows)}`
          )
        }
      }
    }
  } finally {
    if (results.length > 0) {
      writeFileSync(join(ctx.evidenceDir, 'measure-last.json'), JSON.stringify(results, null, 2))
    }
    await session.app.close().catch(() => undefined)
    await proxy?.stop?.().catch?.(() => undefined)
    await sandbox.stop()
  }
}

function summary(phase, cart, mode, width, height, facts) {
  return {
    phase,
    cart,
    mode,
    size: `${width}x${height}`,
    cartWidth: facts.regions.cart?.width ?? null,
    linesHeight: facts.regions.lines?.height ?? null,
    chrome: facts.cartChromeHeight,
    rows: facts.rows,
    footerFullyVisible: facts.footerFullyVisible,
    horizontalOverflow: facts.horizontalOverflow,
    pageOverflowY: facts.pageOverflowY?.amount ?? null
  }
}
