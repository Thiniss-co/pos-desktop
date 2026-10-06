import { t } from '../support/app.mjs'
import {
  MANAGER,
  CASHIER,
  activate,
  deviceUuid,
  openSandboxAndApp,
  openShift,
  refreshWorkstation,
  relaunch,
  signIn,
  signOutViaMenu,
  waitForRoute
} from '../support/journey.mjs'
import { queryLocal } from '../support/localDb.mjs'
import {
  businessSnapshot,
  diffSnapshots,
  measureCart,
  namedBarcode,
  pinia,
  scanBurst,
  setContentViewport
} from '../support/workspace.mjs'

/**
 * POS workspace — rearranging, persistence, isolation and recovery.
 *
 *  A. Layout editor: the Actions section is DRAGGED below the lines (pointer), the catalog's
 *     Categories section is moved with the keyboard (Move down button), the catalog panel is dragged
 *     across to put the cart on the other side, and the separator is dragged. Apply → one row whose
 *     owner is the signed-in cashier on this device. The cart is untouched throughout.
 *  B. Restart: the same layout comes back (DOM order, side, share).
 *  C. Cancel and Restore → Cancel write nothing (byte-for-byte); Restore → Apply deletes the row and
 *     survives a restart as the Cart-first default.
 *  D. Users: the cashier's layout, the manager's default then own layout, and the cashier's layout
 *     again after switching back (real UI sign-out each time) — two rows, one per user.
 *  E. Shrink to 800×600 (rail, cart still visible, nothing stored changes) and grow back to
 *     1920×1080: the requested share is applied again, the stored JSON unchanged byte for byte.
 *  F. Settings → POS workspace shows the same layout in its preview, changes it, Apply; the POS shows
 *     the new layout.
 */
export async function run(ctx) {
  const session = await openSandboxAndApp(ctx)
  const { sandbox } = session
  let page = session.page
  const rows = () =>
    queryLocal(
      session.profileDir,
      'SELECT company_uuid, user_uuid, device_uuid, layout_json, schema_version, updated_at FROM user_workspace_layouts ORDER BY user_uuid'
    )
  const shellFacts = async () =>
    await page.evaluate(() => {
      const shell = document.querySelector('.pos-workspace-shell')
      const body = document.querySelector('.pos-workspace-shell__body')
      return {
        preset: shell?.getAttribute('data-preset'),
        side: shell?.getAttribute('data-cart-side'),
        density: shell?.getAttribute('data-density'),
        catalogMode: shell?.getAttribute('data-catalog-mode'),
        firstRegion: body?.firstElementChild?.classList.contains('pos-workspace-shell__cart')
          ? 'cart'
          : 'catalog',
        cartOrder: [...document.querySelectorAll('.pos-workspace-shell__cart [data-section]')].map(
          (e) => e.getAttribute('data-section')
        ),
        catalogOrder: [
          ...document.querySelectorAll('.pos-workspace-shell__catalog [data-section]')
        ].map((e) => e.getAttribute('data-section')),
        cartWidth: Math.round(
          document.querySelector('.pos-workspace-shell__cart')?.getBoundingClientRect().width ?? 0
        )
      }
    })
  const editBar = () => page.getByTestId('workspace-edit-bar')
  try {
    await setContentViewport(session, 1366, 768)
    await activate(ctx, page)
    await signIn(ctx, page)
    await waitForRoute(page, 'pos')
    const device = await deviceUuid(sandbox)
    sandbox.fixture('assign-device', device)
    sandbox.fixture('create-named-products', '6')
    await refreshWorkstation(ctx, page)
    await openShift(ctx, page)
    for (let i = 1; i <= 5; i += 1) await scanBurst(page, namedBarcode(i))
    const sale = await businessSnapshot(page)

    // --- A. Rearrange with pointer and keyboard --------------------------------------------------
    await page.getByTestId('workspace-customize').click()
    await editBar().waitFor()
    // Drag the Actions handle to below the lines.
    const actionsHandle = page.locator(
      '.pos-workspace-shell__cart [data-section="actions"] .pos-workspace-section__handle [role="img"]'
    )
    const linesBox = await page
      .locator('.pos-workspace-shell__cart [data-section="lines"]')
      .boundingBox()
    const handleBox = await actionsHandle.boundingBox()
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(handleBox.x + 10, linesBox.y + linesBox.height - 4, { steps: 10 })
    await page.mouse.up()
    // Categories down, by keyboard (focus the Move down button and press Enter).
    const moveDown = page.getByRole('button', {
      name: await t(page, 'pos.workspace.moveDown', {
        section: await t(page, 'pos.workspace.sections.categories')
      })
    })
    await moveDown.focus()
    await page.keyboard.press('Enter')
    // Drag the catalog panel across to the far side.
    const swap = page.locator('.pos-workspace-shell__swap-handle')
    const swapBox = await swap.boundingBox()
    await page.mouse.move(swapBox.x + swapBox.width / 2, swapBox.y + swapBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(swapBox.x + 900, swapBox.y + 20, { steps: 12 })
    await page.mouse.up()
    // Drag the separator a little.
    const separator = page.getByRole('separator', {
      name: await t(page, 'pos.workspace.resizeCart')
    })
    const sepBox = await separator.boundingBox()
    await page.mouse.move(sepBox.x + sepBox.width / 2, sepBox.y + sepBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(sepBox.x + sepBox.width / 2 + 40, sepBox.y + sepBox.height / 2, {
      steps: 5
    })
    await page.mouse.up()
    const draft = await pinia(page, 'posWorkspace', 'JSON.parse(JSON.stringify(s.draft))')
    ctx.step('A: draft after pointer + keyboard rearrangement', { draft })
    if (
      JSON.stringify(draft.sections.cart) !== JSON.stringify(['scan', 'lines', 'actions', 'totals'])
    )
      throw new Error(`A: drag did not move Actions below the lines: ${draft.sections.cart}`)
    if (
      JSON.stringify(draft.sections.catalog) !==
      JSON.stringify(['search', 'categories', 'products'])
    )
      throw new Error(`A: keyboard move did not reorder the catalog: ${draft.sections.catalog}`)
    if (draft.cartSide !== 'start')
      throw new Error('A: dragging the catalog across did not swap the sides')
    if (diffSnapshots(sale, await businessSnapshot(page)))
      throw new Error('A: the sale changed while editing')
    await ctx.shot(page, 'A1-rearranged-draft')
    await page.getByTestId('workspace-apply').click()
    await editBar().waitFor({ state: 'detached' })
    const stored = rows()
    ctx.step('A: applied', {
      stored: stored.map((r) => ({ ...r, layout_json: JSON.parse(r.layout_json) }))
    })
    if (stored.length !== 1 || stored[0].device_uuid !== device)
      throw new Error('A: expected one row owned by this device')
    const appliedFacts = await shellFacts()
    await ctx.shot(page, 'A2-applied')

    // --- B. Restart -------------------------------------------------------------------------------
    await relaunch(ctx, session)
    page = session.page
    await waitForRoute(page, 'pos')
    await setContentViewport(session, 1366, 768)
    await page.locator('.pos-workspace-shell[data-preset]').waitFor()
    await page.waitForTimeout(800)
    const restarted = await shellFacts()
    ctx.step('B: after restart', { appliedFacts, restarted })
    for (const key of ['preset', 'side', 'firstRegion', 'cartOrder', 'catalogOrder'])
      if (JSON.stringify(restarted[key]) !== JSON.stringify(appliedFacts[key]))
        throw new Error(`B: ${key} not restored after restart`)
    await ctx.shot(page, 'B1-restored-after-restart')

    // --- C. Cancel, Restore → Cancel, Restore → Apply ----------------------------------------------
    const snapshotRows = JSON.stringify(rows())
    await page.getByTestId('workspace-customize').click()
    await page
      .getByTestId('workspace-preset')
      .getByRole('radio', { name: await t(page, 'pos.workspace.presets.scanner') })
      .click()
    await page.getByTestId('workspace-cancel').click()
    await page.getByTestId('workspace-customize').click()
    await page.getByTestId('workspace-restore').click()
    if ((await shellFacts()).preset !== 'cartFirst')
      throw new Error('C: Restore did not preview the default')
    await page.getByTestId('workspace-cancel').click()
    if (JSON.stringify(rows()) !== snapshotRows)
      throw new Error('C: Cancel or Restore→Cancel wrote the layout')
    if ((await shellFacts()).side !== 'start')
      throw new Error('C: Cancel did not bring the saved layout back')
    await page.getByTestId('workspace-customize').click()
    await page.getByTestId('workspace-restore').click()
    await page.getByTestId('workspace-apply').click()
    await editBar().waitFor({ state: 'detached' })
    if (rows().length !== 0) throw new Error('C: Restore→Apply did not delete the stored row')
    await relaunch(ctx, session)
    page = session.page
    await waitForRoute(page, 'pos')
    await setContentViewport(session, 1366, 768)
    await page.waitForTimeout(800)
    const afterRestore = await shellFacts()
    ctx.step('C: restore defaults survives a restart', { afterRestore })
    if (afterRestore.preset !== 'cartFirst' || afterRestore.side !== 'end')
      throw new Error('C: default not restored')

    // --- D. Per-user isolation ---------------------------------------------------------------------
    const applyPreset = async (preset) => {
      await page.getByTestId('workspace-customize').click()
      await page
        .getByTestId('workspace-preset')
        .getByRole('radio', { name: await t(page, `pos.workspace.presets.${preset}`) })
        .click()
      await page.getByTestId('workspace-apply').click()
      await editBar().waitFor({ state: 'detached' })
    }
    await applyPreset('scanner')
    const cashierFacts = await shellFacts()
    await signOutViaMenu(ctx, page)
    await signIn(ctx, page, MANAGER)
    await waitForRoute(page, 'pos')
    await page.waitForTimeout(800)
    const managerDefault = await shellFacts()
    await ctx.shot(page, 'D1-manager-default')
    if (managerDefault.preset !== 'cartFirst')
      throw new Error(`D: manager saw ${managerDefault.preset}, not the default`)
    await applyPreset('balanced')
    const managerFacts = await shellFacts()
    await signOutViaMenu(ctx, page)
    await signIn(ctx, page, CASHIER)
    await waitForRoute(page, 'pos')
    await page.waitForTimeout(800)
    const cashierAgain = await shellFacts()
    const twoRows = rows()
    ctx.step('D: per-user layouts', {
      cashier: cashierFacts.preset,
      managerDefault: managerDefault.preset,
      manager: managerFacts.preset,
      cashierAgain: cashierAgain.preset,
      rows: twoRows.map((r) => ({
        user: r.user_uuid,
        device: r.device_uuid,
        preset: JSON.parse(r.layout_json).preset
      }))
    })
    if (
      cashierFacts.preset !== 'scanner' ||
      managerFacts.preset !== 'balanced' ||
      cashierAgain.preset !== 'scanner'
    )
      throw new Error('D: layouts leaked between users')
    if (twoRows.length !== 2 || twoRows[0].user_uuid === twoRows[1].user_uuid)
      throw new Error('D: expected one row per user')
    await ctx.shot(page, 'D2-cashier-layout-back')

    // --- E. Shrink and grow ------------------------------------------------------------------------
    await page.getByTestId('workspace-customize').click()
    await page
      .getByTestId('workspace-preset')
      .getByRole('radio', { name: await t(page, 'pos.workspace.presets.balanced') })
      .click()
    for (let i = 0; i < 5; i += 1) await page.getByTestId('workspace-wider').click()
    await page.getByTestId('workspace-apply').click()
    await editBar().waitFor({ state: 'detached' })
    const beforeShrink = JSON.stringify(rows())
    const requested = await pinia(page, 'posWorkspace', 's.saved.cartShare')
    await setContentViewport(session, 800, 600)
    const small = await measureCart(page)
    await ctx.shot(page, 'E1-shrunk-800x600')
    await setContentViewport(session, 1920, 1080)
    const large = await shellFacts()
    const largeMeasure = await measureCart(page)
    await ctx.shot(page, 'E2-grown-1920x1080')
    const share = Math.round(
      (largeMeasure.regions.cart.width / largeMeasure.regions.workspace.width) * 100
    )
    ctx.step('E: shrink and grow', {
      requested,
      small: {
        catalogMode: small.regions.rail ? 'rail' : 'panel',
        cart: small.regions.cart,
        footer: small.footerFullyVisible,
        overflow: small.horizontalOverflow
      },
      large: { catalogMode: large.catalogMode, cartWidth: large.cartWidth, shareOfBody: share }
    })
    if (
      !small.regions.rail ||
      !small.regions.cart ||
      !small.footerFullyVisible ||
      small.horizontalOverflow
    )
      throw new Error('E: the small window lost the cart, footer or fit')
    if (JSON.stringify(rows()) !== beforeShrink)
      throw new Error('E: a resize rewrote the stored layout')
    if (large.catalogMode !== 'panel' || Math.abs(share - requested) > 2)
      throw new Error(`E: requested ${requested}% not recovered (got ${share}%)`)

    // --- F. Settings → POS workspace ----------------------------------------------------------------
    await setContentViewport(session, 1366, 768)
    await page
      .getByRole('link', { name: await t(page, 'navigation.settings') })
      .first()
      .click()
    await waitForRoute(page, 'settings')
    await page.getByRole('tab', { name: await t(page, 'settings.tabPosWorkspace') }).click()
    await page.getByTestId('workspace-preview').waitFor()
    const previewLabel = await page
      .getByTestId('workspace-preview')
      .getByRole('img')
      .getAttribute('aria-label')
    await ctx.shot(page, 'F1-settings-preview')
    if (
      !previewLabel.includes(await t(page, 'pos.workspace.presets.custom')) &&
      !previewLabel.includes(await t(page, 'pos.workspace.presets.balanced'))
    )
      throw new Error(`F: preview does not describe the saved layout: ${previewLabel}`)
    await page.getByTestId('settings-workspace-customize').click()
    await page
      .getByTestId('workspace-preset')
      .getByRole('radio', { name: await t(page, 'pos.workspace.presets.scanner') })
      .click()
    const radios = await page.evaluate(() =>
      Object.fromEntries(
        ['workspace-preset', 'workspace-collapse', 'workspace-view', 'workspace-side'].map((id) => [
          id,
          document
            .querySelector(`[data-testid="${id}"] [role="radio"][aria-checked="true"]`)
            ?.textContent?.trim() ?? null
        ])
      )
    )
    ctx.step('F: controls after choosing Scanner focused', { radios })
    if (
      radios['workspace-collapse'] !== (await t(page, 'pos.workspace.edit.productsCollapsed')) ||
      radios['workspace-view'] !== (await t(page, 'pos.workspace.edit.viewCompact'))
    )
      throw new Error(`F: controls do not show the chosen preset: ${JSON.stringify(radios)}`)
    await ctx.shot(page, 'F2-settings-editing')
    await page.getByTestId('workspace-apply').click()
    await page.getByTestId('settings-workspace-customize').waitFor()
    await page
      .getByRole('link', { name: await t(page, 'navigation.pos') })
      .first()
      .click()
    await waitForRoute(page, 'pos')
    await page.waitForTimeout(600)
    const fromSettings = await shellFacts()
    ctx.step('F: settings applied', { previewLabel, fromSettings })
    if (fromSettings.preset !== 'scanner')
      throw new Error('F: the POS did not show the layout applied in Settings')
    await ctx.shot(page, 'F3-pos-after-settings')
  } finally {
    await session.app.close().catch(() => undefined)
    await sandbox.stop()
  }
}
