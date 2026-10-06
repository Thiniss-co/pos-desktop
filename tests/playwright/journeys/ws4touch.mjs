import { t } from '../support/app.mjs'
import {
  activate,
  deviceUuid,
  openSandboxAndApp,
  openShift,
  refreshWorkstation,
  signIn,
  waitForRoute,
  waitForServerInvoices
} from '../support/journey.mjs'
import { queryLocal } from '../support/localDb.mjs'
import {
  measureCart,
  pinia,
  setContentViewport,
  setTouchMode,
  smallControls,
  tap,
  touchDrag,
  touchSession
} from '../support/workspace.mjs'

/**
 * POS workspace — touch only (CDP touch events; no keyboard, mouse or F-key after setup).
 *
 *  A. Touch sale at 1366×768: tap product cards, set a FRACTIONAL quantity on the on-screen keypad,
 *     +1 on a line, remove a line from its menu, then the labelled Exact cash button; the sale commits
 *     and uploads.
 *  B. Refund entry by touch from the labelled Return / Refund button: choose the sale, +1, review,
 *     confirm; accepted.
 *  C. 800×600: the products rail opens its browser by touch (the cart stays visible), a product is
 *     added from it, the browser closes by touch.
 *  D. Touch customization: Customize → Balanced → drag the separator with a finger → Cancel; the stored
 *     layout and the sale are unchanged.
 *  E. Every visible enabled control is ≥ 44×44 — in normal selling, with the More menu open, with a
 *     line menu open, with the rail browser open and in the layout editor — and normal selling
 *     exposes no separator or drag handle: a finger dragged across the region boundary and swiped
 *     through the lines moves nothing.
 */
export async function run(ctx) {
  const session = await openSandboxAndApp(ctx)
  const { page, sandbox } = session
  const small = {}
  try {
    await setContentViewport(session, 1366, 768)
    await activate(ctx, page)
    await signIn(ctx, page)
    await waitForRoute(page, 'pos')
    const device = await deviceUuid(sandbox)
    sandbox.fixture('assign-device', device)
    const products = sandbox.fixture('create-named-products', '8').products
    await refreshWorkstation(ctx, page)
    await openShift(ctx, page)
    await setTouchMode(page, true)
    const cdp = await touchSession(page)
    const name = (index) => products[index - 1].name
    const card = (index) =>
      page
        .locator('button.product-card', {
          has: page.locator('.product-card__name', { hasText: name(index) })
        })
        .first()

    // --- A. Touch sale ----------------------------------------------------------------------------
    for (const index of [1, 2, 3]) await tap(cdp, card(index))
    await tap(
      cdp,
      page.getByRole('button', { name: await t(page, 'touch.quantity.editOf', { name: name(1) }) })
    )
    const keypad = page.getByTestId('quantity-keypad-dialog')
    for (const key of ['1', 'decimal', '5']) {
      await tap(
        cdp,
        key === 'decimal'
          ? keypad.getByRole('button', { name: await t(page, 'touch.keypad.decimal') })
          : keypad.locator(`[data-key="${key}"]`)
      )
    }
    await ctx.shot(page, 'A1-fractional-keypad')
    await tap(cdp, page.getByTestId('quantity-keypad-apply'))
    await tap(
      cdp,
      page.getByRole('button', { name: await t(page, 'pos.cart.increaseOf', { name: name(2) }) })
    )
    await tap(
      cdp,
      page.getByRole('button', {
        name: await t(page, 'pos.workspace.lineActions', { name: name(3) })
      })
    )
    small.lineMenu = await smallControls(page)
    await ctx.shot(page, 'A2-line-menu')
    await tap(
      cdp,
      page.getByRole('menuitem', { name: await t(page, 'pos.cart.removeOf', { name: name(3) }) })
    )
    const lines = await pinia(
      page,
      'cart',
      'JSON.parse(JSON.stringify(s.lines.map((l) => [l.product.name, l.quantity])))'
    )
    ctx.step('A: cart after touch edits', { lines })
    if (
      JSON.stringify(lines) !==
      JSON.stringify([
        [name(1), '1.500'],
        [name(2), '2.000']
      ])
    )
      throw new Error(`A: unexpected cart ${JSON.stringify(lines)}`)
    small.selling1366 = await smallControls(page)
    await tap(cdp, page.locator('.quick-actions [data-action="more"]').first())
    small.moreMenu = await smallControls(page)
    await ctx.shot(page, 'A3-more-menu-touch')
    await tap(cdp, page.locator('.quick-actions [data-action="more"]').first())
    await tap(cdp, page.getByTestId('exact-cash'))
    const newSale = page
      .getByRole('dialog')
      .getByRole('button', { name: new RegExp(await t(page, 'pos.tender.newSale')) })
    await newSale.waitFor({ timeout: 30_000 })
    await ctx.shot(page, 'A4-sale-complete')
    await tap(cdp, newSale)
    await waitForServerInvoices(sandbox, device, 1, 90_000)
    const [sale] = queryLocal(
      session.profileDir,
      'SELECT local_uuid FROM local_invoices ORDER BY created_at DESC LIMIT 1'
    )
    ctx.step('A: touch sale committed and uploaded', { sale })

    // --- B. Refund entry by touch -------------------------------------------------------------------
    await tap(cdp, page.locator('.quick-actions button[data-action="refund"]').first())
    await tap(cdp, page.getByTestId(`refund-entry-${sale.local_uuid}`))
    const refund = page.getByRole('dialog')
    await tap(
      cdp,
      refund.getByRole('button', { name: await t(page, 'refunds.increaseQuantity') }).first()
    )
    await tap(cdp, refund.getByRole('button', { name: await t(page, 'refunds.previewAction') }))
    const confirmPrefix = (
      await t(page, 'refunds.confirmActionAmount', { amount: '\u0000' })
    ).split('\u0000')[0]
    await tap(cdp, refund.getByRole('button', { name: new RegExp(`^${confirmPrefix}`) }))
    await refund.getByText(await t(page, 'refunds.success')).waitFor({ timeout: 30_000 })
    await ctx.shot(page, 'B1-refund-accepted')
    await tap(cdp, refund.getByRole('button', { name: await t(page, 'refunds.close') }))
    const refunds = queryLocal(session.profileDir, 'SELECT submission_state FROM local_refunds')
    ctx.step('B: refund by touch', { refunds })
    if (refunds[0]?.submission_state !== 'accepted') throw new Error('B: refund not accepted')

    // --- C. Rail browser at 800×600 -----------------------------------------------------------------
    await setContentViewport(session, 800, 600)
    const railToggle = page.locator('.pos-workspace-shell__rail-toggle')
    await tap(cdp, railToggle)
    await page.locator('.pos-workspace-shell__browser').waitFor()
    const railFacts = await measureCart(page)
    small.railOpen800 = await smallControls(page)
    await ctx.shot(page, 'C1-rail-browser-800x600')
    await tap(cdp, card(4))
    await tap(
      cdp,
      page.getByRole('button', { name: await t(page, 'pos.workspace.closeProducts') }).first()
    )
    const afterRail = await pinia(page, 'cart', 's.lines.length')
    ctx.step('C: rail browser', {
      cartVisible: Boolean(railFacts.regions.cart),
      cartWidth: railFacts.regions.cart?.width,
      footer: railFacts.footerFullyVisible,
      lines: afterRail
    })
    if (!railFacts.regions.cart || !railFacts.footerFullyVisible || afterRail !== 1)
      throw new Error('C: the rail browser hid the cart or did not add the product')
    small.selling800 = await smallControls(page)
    await setContentViewport(session, 1366, 768)

    // --- E (normal selling): no handles; a finger across the boundary or through the lines moves nothing.
    const widthBefore = (await measureCart(page)).regions.cart.width
    const handles = await page.locator('[role="separator"], .pos-workspace-section__handle').count()
    const catalogBox = await page.locator('.pos-workspace-shell__catalog').boundingBox()
    await touchDrag(
      cdp,
      page.locator('.pos-workspace-shell__catalog'),
      catalogBox.width / 2 + 20,
      0
    )
    await touchDrag(cdp, page.locator('.cart-panel__lines'), 0, -120)
    const widthAfter = (await measureCart(page)).regions.cart.width
    const editing = await pinia(page, 'posWorkspace', 's.editing')
    ctx.step('E: no accidental drag in normal selling', {
      handles,
      widthBefore,
      widthAfter,
      editing
    })
    if (handles !== 0 || widthBefore !== widthAfter || editing)
      throw new Error('E: normal selling exposed or moved layout')

    // --- D. Touch customization, cancelled ---------------------------------------------------------
    const storedBefore = JSON.stringify(
      queryLocal(session.profileDir, 'SELECT * FROM user_workspace_layouts')
    )
    const saleBefore = await pinia(
      page,
      'cart',
      'JSON.stringify(s.lines.map((l) => [l.id, l.quantity]))'
    )
    await tap(cdp, page.getByTestId('workspace-customize'))
    await tap(
      cdp,
      page
        .getByTestId('workspace-preset')
        .getByRole('radio', { name: await t(page, 'pos.workspace.presets.balanced') })
    )
    const separator = page.getByRole('separator', {
      name: await t(page, 'pos.workspace.resizeCart')
    })
    const shareBefore = await pinia(page, 'posWorkspace', 's.draft.cartShare')
    await touchDrag(cdp, separator, 120, 0)
    const shareAfter = await pinia(page, 'posWorkspace', 's.draft.cartShare')
    small.editor = await smallControls(page)
    await ctx.shot(page, 'D1-touch-editor')
    await tap(cdp, page.getByTestId('workspace-cancel'))
    const storedAfter = JSON.stringify(
      queryLocal(session.profileDir, 'SELECT * FROM user_workspace_layouts')
    )
    const saleAfter = await pinia(
      page,
      'cart',
      'JSON.stringify(s.lines.map((l) => [l.id, l.quantity]))'
    )
    ctx.step('D: touch customization cancelled', {
      shareBefore,
      shareAfter,
      storedSame: storedBefore === storedAfter,
      saleSame: saleBefore === saleAfter
    })
    if (shareAfter === shareBefore)
      throw new Error('D: a finger drag on the separator did not resize the draft')
    if (storedBefore !== storedAfter || saleBefore !== saleAfter)
      throw new Error('D: cancel changed the stored layout or the sale')

    // --- E (targets) ----------------------------------------------------------------------------------
    const failures = Object.entries(small).filter(([, list]) => list.length > 0)
    ctx.step(
      'E: controls under 44×44 by state',
      Object.fromEntries(Object.entries(small).map(([k, v]) => [k, v.slice(0, 6)]))
    )
    if (failures.length > 0)
      throw new Error(`E: small touch targets in ${failures.map(([k]) => k).join(', ')}`)
  } finally {
    await session.app.close().catch(() => undefined)
    await sandbox.stop()
  }
}
