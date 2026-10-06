import { t } from '../support/app.mjs'
import {
  openSandboxAndApp,
  setupPhysicalPresenceTill,
  signIn,
  signOutViaMenu,
  sizeWindow,
  waitForRoute,
  waitForServerInvoices
} from '../support/journey.mjs'
import { queryLocal } from '../support/localDb.mjs'

/**
 * POS improvements, Stage 5 — touch mode, through real touch input only.
 *
 * Every interaction in parts A–C is a CDP touch gesture (`Input.dispatchTouchEvent`); no keyboard,
 * no mouse, no F-key helper. The register is set up (activation, sign-in, shift) before touch starts.
 *
 *  A. The user menu → Touch mode switch turns it on for THIS user (persisted in `user_preferences`);
 *     `data-touch="on"` drives the layout. Sign out → off; sign in again → on again.
 *  B. Touch-only sale: tap two product cards, set a quantity with the on-screen keypad, then the touch
 *     bar's Exact cash; the sale commits and uploads.
 *  C. Touch-only refund: Return / Refund tile → choose the sale → + → Review → Confirm → accepted.
 *  D. Layout matrix (16): EN/AR × light/dark × 1920×1080, 1366×768, 1024×768, 800×600, touch ON with a
 *     cart line. Per combination: no horizontal page overflow, every visible control ≥ 44×44, the
 *     top-bar navigation does not overlap the status area, and the quantity keypad dialog fits in the
 *     viewport. A screenshot per combination.
 */

const CONTROL_SELECTOR =
  "button, [role='button'], [role='switch'], [role='menuitem'], a[href], select, input:not([type='hidden'])"

async function touchSession(page) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  return cdp
}

/** One real touch tap at the centre of the element (fails if it is not visible). */
async function tap(cdp, locator) {
  await locator.waitFor({ state: 'visible' })
  await locator.scrollIntoViewIfNeeded()
  // Wait for a settled layout (a resize or theme change can still be moving things).
  let box = await locator.boundingBox()
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await locator.page().waitForTimeout(100)
    const next = await locator.boundingBox()
    if (box && next && Math.abs(next.x - box.x) < 0.5 && Math.abs(next.y - box.y) < 0.5) break
    box = next
  }
  if (!box) throw new Error('tap: element has no box')
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  // The tap must land on the target itself: report what is really under the point otherwise.
  const hit = await locator.evaluate(
    (element, [x, y]) => {
      const under = document.elementFromPoint(x, y)
      return under === element || element.contains(under)
        ? null
        : { under: under?.outerHTML.slice(0, 160) ?? null, target: element.outerHTML.slice(0, 160) }
    },
    [point.x, point.y]
  )
  if (hit) throw new Error(`tap: the point is covered: ${JSON.stringify(hit)}`)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await locator.page().waitForTimeout(150)
}

async function pinia(page, id, expression) {
  return await page.evaluate(
    ([storeId, body]) => {
      const store = document
        .querySelector('#app')
        .__vue_app__.config.globalProperties.$pinia._s.get(storeId)
      return new Function('s', `return (${body})`)(store)
    },
    [id, expression]
  )
}

async function setViewport(session, width, height) {
  await session.app.evaluate(
    ({ BrowserWindow }, [w, h]) => {
      const win = BrowserWindow.getAllWindows().find((x) => x.isVisible())
      win?.setContentSize(w, h)
    },
    [width, height]
  )
  await session.page.waitForTimeout(500)
}

/** Layout facts measured in the renderer. */
async function measure(page) {
  return await page.evaluate((selector) => {
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
    const small = [...document.querySelectorAll(selector)]
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect()
        return {
          text: (element.getAttribute('aria-label') ?? element.textContent ?? '')
            .trim()
            .slice(0, 40),
          tag: element.tagName,
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      })
      .filter((entry) => entry.width < 44 || entry.height < 44)
    // Labels that do not fit their own tile (clipped or spilling into a neighbour).
    const overflowingLabels = [...document.querySelectorAll('.quick-actions__tile')]
      .filter(visible)
      .filter((tile) => tile.scrollWidth > tile.clientWidth + 1)
      .map((tile) => (tile.textContent ?? '').trim().slice(0, 30))
    const nav = document.querySelector('header nav')
    const status = document.querySelector('header [role="group"]')
    const navBox =
      nav && getComputedStyle(nav).display !== 'none' ? nav.getBoundingClientRect() : null
    const statusBox = status?.getBoundingClientRect() ?? null
    const rtl = document.documentElement.dir === 'rtl'
    const overlap =
      navBox && statusBox && navBox.width > 0
        ? rtl
          ? navBox.left < statusBox.right - 0.5
          : navBox.right > statusBox.left + 0.5
        : false
    const scroller = document.scrollingElement
    return {
      dir: document.documentElement.dir,
      touch: document.documentElement.dataset.touch ?? null,
      horizontalOverflow: scroller.scrollWidth > window.innerWidth + 1,
      navOverlapsStatus: overlap,
      overflowingLabels,
      smallControls: small
    }
  }, CONTROL_SELECTOR)
}

export async function run(ctx) {
  const session = await openSandboxAndApp(ctx, {
    flags: { POS_OFFLINE_PHYSICAL_PRESENCE_ENABLED: 'true' }
  })
  const { sandbox } = session
  try {
    const device = await setupPhysicalPresenceTill(ctx, session)
    let page = session.page
    await sizeWindow(session, 1366, 850)
    let cdp = await touchSession(page)

    // A. Touch mode on, per user.
    await tap(cdp, page.getByRole('button', { name: await t(page, 'shell.user.menuLabel') }))
    await tap(cdp, page.getByTestId('touch-mode-switch'))
    await page.waitForFunction(() => document.documentElement.dataset.touch === 'on')
    const stored = queryLocal(session.profileDir, 'SELECT key, value FROM user_preferences')
    ctx.step('A: touch mode switched on by touch', { stored })
    if (!stored.some((row) => row.key === 'ui.touchMode' && row.value === 'true'))
      throw new Error('A: touch mode was not persisted for the user')
    await ctx.shot(page, 'A1-touch-mode-on')
    await tap(cdp, page.getByRole('button', { name: await t(page, 'shell.user.menuLabel') }))

    // B. Touch-only sale.
    await tap(cdp, page.locator('.product-card', { hasText: 'Cola Can' }))
    await tap(cdp, page.locator('.product-card', { hasText: 'Chips Small' }))
    const colaName = await pinia(
      page,
      'cart',
      "s.lines.find((l) => l.product.name === 'Cola Can')?.product.name ?? null"
    )
    if (colaName === null) throw new Error('B: the tapped product did not reach the cart')
    await tap(
      cdp,
      page.getByRole('button', {
        name: await t(page, 'touch.quantity.editOf', { name: 'Cola Can' })
      })
    )
    const keypadDialog = page.getByTestId('quantity-keypad-dialog')
    await tap(cdp, keypadDialog.locator('[data-key="3"]'))
    await ctx.shot(page, 'B1-quantity-keypad')
    await tap(cdp, page.getByTestId('quantity-keypad-apply'))
    const quantities = await pinia(
      page,
      'cart',
      'JSON.parse(JSON.stringify(s.lines.map((l) => [l.product.name, l.quantity])))'
    )
    ctx.step('B: quantities after the keypad', { quantities })
    if (!quantities.some(([name, quantity]) => name === 'Cola Can' && quantity === '3.000'))
      throw new Error('B: the keypad did not set the quantity')
    const focusAfterKeypad = await page.evaluate(() => document.activeElement?.tagName ?? null)
    await ctx.shot(page, 'B2-touch-bar')
    // POS workspace: Exact cash is a labelled button in the pinned checkout band (no touch bar).
    await tap(cdp, page.getByTestId('exact-cash'))
    await page
      .getByRole('dialog')
      .getByRole('button', { name: new RegExp(await t(page, 'pos.tender.newSale')) })
      .waitFor({ timeout: 30_000 })
    await ctx.shot(page, 'B3-sale-complete')
    await tap(
      cdp,
      page
        .getByRole('dialog')
        .getByRole('button', { name: new RegExp(await t(page, 'pos.tender.newSale')) })
    )
    await waitForServerInvoices(sandbox, device, 1, 90_000)
    const [sale] = queryLocal(
      session.profileDir,
      'SELECT local_uuid, sync_status FROM local_invoices ORDER BY created_at DESC LIMIT 1'
    )
    ctx.step('B: touch-only sale committed and uploaded', { sale, focusAfterKeypad })

    // C. Touch-only refund.
    // POS workspace: Return / Refund is on the toolbar, or in the labelled More menu when the cart
    // is too narrow for it — both by touch.
    const refundButton = page.locator('.quick-actions button[data-action="refund"]').first()
    if (!(await refundButton.isVisible().catch(() => false))) {
      await tap(cdp, page.locator('.quick-actions [data-action="more"]').first())
    }
    await tap(cdp, page.locator('[data-action="refund"]:visible').first())
    await tap(cdp, page.getByTestId(`refund-entry-${sale.local_uuid}`))
    const refundDialog = page.getByRole('dialog')
    await tap(
      cdp,
      refundDialog.getByRole('button', { name: await t(page, 'refunds.increaseQuantity') }).first()
    )
    await tap(
      cdp,
      refundDialog.getByRole('button', { name: await t(page, 'refunds.previewAction') })
    )
    const confirmPrefix = (
      await t(page, 'refunds.confirmActionAmount', { amount: '\u0000' })
    ).split('\u0000')[0]
    await tap(cdp, refundDialog.getByRole('button', { name: new RegExp(`^${confirmPrefix}`) }))
    await refundDialog.getByText(await t(page, 'refunds.success')).waitFor({ timeout: 30_000 })
    await ctx.shot(page, 'C1-refund-accepted-by-touch')
    await tap(cdp, refundDialog.getByRole('button', { name: await t(page, 'refunds.close') }))
    const refunds = queryLocal(session.profileDir, 'SELECT submission_state FROM local_refunds')
    ctx.step('C: touch-only refund', { refunds })
    if (refunds[0]?.submission_state !== 'accepted')
      throw new Error('C: the refund was not accepted')

    // A (continued). Per user: sign out → off; sign in again → on.
    await signOutViaMenu(ctx, page)
    await page.waitForFunction(() => document.documentElement.dataset.touch === undefined)
    await signIn(ctx, page)
    await waitForRoute(page, 'pos')
    await page.waitForFunction(() => document.documentElement.dataset.touch === 'on', null, {
      timeout: 15_000
    })
    ctx.step('A: per-user persistence', { afterSignOut: 'off', afterSignIn: 'on' })
    cdp = await touchSession(page)

    // D. The matrix (touch ON, one cart line).
    await tap(cdp, page.locator('.product-card', { hasText: 'Cola Can' }))
    const results = []
    for (const locale of ['en', 'ar']) {
      for (const theme of ['light', 'dark']) {
        await pinia(page, 'locale', `s.setLocale('${locale}')`)
        await pinia(page, 'theme', `s.setTheme('${theme}')`)
        for (const [width, height] of [
          [1920, 1080],
          [1366, 768],
          [1024, 768],
          [800, 600]
        ]) {
          await setViewport(session, width, height)
          const facts = await measure(page)
          let dialogFits = null
          // POS workspace: below 900px the cart stays visible and products collapse to a rail; open
          // the rail's browser by touch so its controls are measured too.
          const railToggle = page.locator('.pos-workspace-shell__rail-toggle')
          let sheetOpened = false
          if (await railToggle.isVisible().catch(() => false)) {
            await tap(cdp, railToggle)
            sheetOpened = true
          }
          const sheetFacts = sheetOpened ? await measure(page) : null
          const edit = page.getByRole('button', {
            name: await t(page, 'touch.quantity.editOf', { name: 'Cola Can' })
          })
          if (await edit.isVisible().catch(() => false)) {
            await tap(cdp, edit)
            dialogFits = await page.evaluate(() => {
              const box =
                document
                  .querySelector('[data-testid="quantity-keypad-dialog"]')
                  ?.closest('[role="dialog"]')
                  ?.getBoundingClientRect() ??
                document
                  .querySelector('[data-testid="quantity-keypad-dialog"]')
                  ?.getBoundingClientRect()
              return box
                ? box.top >= 0 &&
                    box.left >= 0 &&
                    box.bottom <= window.innerHeight + 1 &&
                    box.right <= window.innerWidth + 1
                : null
            })
            await ctx.shot(page, `D-${locale}-${theme}-${width}x${height}-keypad`)
            await tap(
              cdp,
              page
                .getByTestId('quantity-keypad-dialog')
                .getByRole('button', { name: await t(page, 'common.close') })
            )
          }
          const quantity = await pinia(
            page,
            'cart',
            "s.lines.find((l) => l.product.name === 'Cola Can')?.quantity ?? null"
          )
          if (quantity !== '1.000') throw new Error(`D: a tap changed the cart (${quantity})`)
          await ctx.shot(page, `D-${locale}-${theme}-${width}x${height}`)
          if (sheetOpened) {
            await ctx.shot(page, `D-${locale}-${theme}-${width}x${height}-products-rail`)
            await tap(
              cdp,
              page.getByRole('button', { name: await t(page, 'pos.workspace.closeProducts') })
            )
          }
          const merged = sheetFacts
            ? {
                ...facts,
                horizontalOverflow: facts.horizontalOverflow || sheetFacts.horizontalOverflow,
                overflowingLabels: [...facts.overflowingLabels, ...sheetFacts.overflowingLabels],
                smallControls: [...facts.smallControls, ...sheetFacts.smallControls]
              }
            : facts
          const result = {
            locale,
            theme,
            size: `${width}x${height}`,
            ...merged,
            sheetOpened,
            dialogFits
          }
          results.push(result)
          ctx.step('D: combination', {
            ...result,
            smallControls: merged.smallControls.length,
            smallSample: merged.smallControls.slice(0, 4)
          })
        }
      }
    }
    const failures = results.filter(
      (r) =>
        r.horizontalOverflow ||
        r.navOverlapsStatus ||
        r.smallControls.length > 0 ||
        r.overflowingLabels.length > 0 ||
        r.dialogFits === false ||
        r.touch !== 'on'
    )
    ctx.step('D: matrix summary', {
      combinations: results.length,
      failures: failures.map((r) => ({
        combination: `${r.locale}/${r.theme}/${r.size}`,
        overflow: r.horizontalOverflow,
        navOverlap: r.navOverlapsStatus,
        overflowingLabels: r.overflowingLabels,
        small: r.smallControls,
        dialogFits: r.dialogFits
      }))
    })
    if (failures.length > 0)
      throw new Error(`D: ${failures.length} of ${results.length} combinations failed`)
  } finally {
    await session.app.close().catch(() => undefined)
    await sandbox.stop()
  }
}
