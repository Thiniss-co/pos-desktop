import { t } from '../support/app.mjs'
import {
  activate,
  deviceUuid,
  openSandboxAndApp,
  openShift,
  payExactCash,
  refreshWorkstation,
  signIn,
  waitForRoute,
  waitForServerInvoices
} from '../support/journey.mjs'
import { queryLocal } from '../support/localDb.mjs'
import {
  businessSnapshot,
  cartSignatureOf,
  diffSnapshots,
  namedBarcode,
  pinia,
  quickAction,
  scanBurst,
  scanInField,
  setContentViewport
} from '../support/workspace.mjs'
import { installIpcBarrier } from '../support/ipcBarrier.mjs'

const BARCODE_LOOKUP_CHANNEL = 'catalog:find-by-barcode'

/** Tags the current scan result element; the next result is a NEW element (keyed by sequence). */
async function markScanResult(page) {
  const marker = `pw-${Date.now()}-${Math.random().toString(36).slice(2)}`
  await page.evaluate((value) => {
    for (const element of document.querySelectorAll('.scan-entry__result')) {
      element.dataset.pwSeen = value
    }
  }, marker)
  return marker
}

/** Waits for a scan result rendered after `marker` for `code`, and returns its text. */
async function waitForNewScanResult(page, marker, code) {
  const handle = await page.waitForFunction(
    ([value, scanned]) => {
      const fresh = [...document.querySelectorAll('.scan-entry__result')].find(
        (element) => element.dataset.pwSeen !== value && element.textContent.includes(scanned)
      )
      return fresh?.textContent.replace(/\s+/g, ' ').trim() ?? null
    },
    [marker, code],
    { timeout: 15_000 }
  )
  return await handle.jsonValue()
}

/** A keyboard-wedge burst with no field focused that does not wait for any cart change. */
async function scanUnfocused(page, code) {
  await page.evaluate(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement && active !== document.body) active.blur()
  })
  await page.keyboard.type(code, { delay: 5 })
  await page.keyboard.press('Enter')
}

/**
 * POS workspace — selling through layout changes, and scanner safety while editing.
 *
 *  A. Scanning: unfocused keyboard-wedge bursts ending in Enter, Tab and no suffix, plus a focused
 *     fractional entry (`1.250*<code>`), all reach the cart.
 *  B. A populated sale (lines incl. an offer-free fractional line, a new customer, a 10% invoice
 *     discount, one held draft) survives preset/side/density changes, keyboard and pointer resizing,
 *     Apply and Cancel with every business value identical (live stores, read-only snapshot).
 *  C. While the layout editor is open, with focus on Apply / Restore defaults / Cancel: a scan ending
 *     in Enter, Tab, Space-inside or no suffix, F9, Shift+F9 and a scan racing the editor's opening
 *     never change the cart, never open payment, never activate the focused control and never write
 *     the layout (the stored row is compared byte for byte). The race is ordered by a barrier on the
 *     real lookup channel (support/ipcBarrier.mjs): answer held → editor opens → answer released →
 *     cart unchanged; and the control case, answer released before editing → line added and kept.
 *  D. Payment is unavailable from the layout editor; after Apply, exact cash works from the page
 *     (Shift+F9 with the panel closed) and from the payment dialog (F9 → Shift+F9): two sales upload.
 */
export async function run(ctx) {
  const session = await openSandboxAndApp(ctx)
  const { page, sandbox } = session
  const layoutRows = () =>
    queryLocal(
      session.profileDir,
      'SELECT company_uuid, user_uuid, device_uuid, layout_json, schema_version, updated_at FROM user_workspace_layouts'
    )
  try {
    sandbox.fixture('quick-create-grant', 'cashier:customers.create:1')
    await setContentViewport(session, 1366, 768)
    await activate(ctx, page)
    await signIn(ctx, page)
    await waitForRoute(page, 'pos')
    const device = await deviceUuid(sandbox)
    sandbox.fixture('assign-device', device)
    ctx.step('named products', {
      count: sandbox.fixture('create-named-products', '8').products.length
    })
    await refreshWorkstation(ctx, page)
    await openShift(ctx, page)

    // --- A. Scanner input -------------------------------------------------------------------------
    await scanBurst(page, namedBarcode(1), { suffix: 'Enter' })
    await scanBurst(page, namedBarcode(2), { suffix: 'Tab' })
    await scanBurst(page, namedBarcode(3), { suffix: '' })
    await scanInField(page, `1.250*${namedBarcode(4)}`)
    const quantities = await pinia(
      page,
      'cart',
      'JSON.parse(JSON.stringify(s.lines.map((l) => l.quantity)))'
    )
    ctx.step('A: scanned (Enter, Tab, no suffix, focused fractional)', { quantities })
    if (JSON.stringify(quantities) !== JSON.stringify(['1.000', '1.000', '1.000', '1.250']))
      throw new Error(`A: unexpected quantities ${JSON.stringify(quantities)}`)
    await ctx.shot(page, 'A-scanned')

    // --- B. Customer, discount, held draft --------------------------------------------------------
    await (await quickAction(page, 'customer')).click()
    const customerDialog = page.getByRole('dialog')
    await customerDialog.getByLabel(await t(page, 'pos.customerSearchLabel')).fill('Workspace Noor')
    await page.waitForTimeout(400)
    await page.getByTestId('customer-dialog-new').click()
    const create = page.getByTestId('quick-create-dialog')
    await create.waitFor()
    await create
      .getByLabel(await t(page, 'quickCreate.field.phone'))
      .first()
      .fill('0500004001')
    await page.getByTestId('quick-create-save').click()
    await create.waitFor({ state: 'detached' })
    await page.waitForTimeout(500)
    // Held draft: park this sale, start the next one.
    await (await quickAction(page, 'hold')).click()
    await scanBurst(page, namedBarcode(5))
    await scanBurst(page, namedBarcode(6))
    await scanInField(page, `0.750*${namedBarcode(7)}`)
    await (await quickAction(page, 'discount')).click()
    await page.getByRole('radio', { name: await t(page, 'pos.discountPercentage') }).click()
    await page.getByLabel(await t(page, 'pos.discountPercent')).fill('10')
    await page.getByRole('button', { name: await t(page, 'pos.applyDiscount') }).click()
    await page.waitForTimeout(300)
    const before = await businessSnapshot(page)
    ctx.step('B: sale before layout changes', {
      lines: before.lines.length,
      held: before.heldDrafts.length,
      discount: before.invoiceDiscount,
      grand: before.calculation?.grandTotalAmount
    })
    if (
      before.lines.length !== 3 ||
      before.heldDrafts.length !== 1 ||
      before.invoiceDiscount[0] !== 'percentage'
    )
      throw new Error('B: precondition sale not built')
    await ctx.shot(page, 'B0-before')

    await page.getByTestId('workspace-customize').click()
    await page.getByTestId('workspace-edit-bar').waitFor()
    await ctx.shot(page, 'B1-editor-open')
    await page
      .getByTestId('workspace-preset')
      .getByRole('radio', { name: await t(page, 'pos.workspace.presets.balanced') })
      .click()
    await page
      .getByTestId('workspace-side')
      .getByRole('radio', { name: await t(page, 'pos.workspace.edit.sideLeft') })
      .click()
    await page
      .getByTestId('workspace-density')
      .getByRole('radio', { name: await t(page, 'pos.workspace.edit.comfortable') })
      .click()
    const separator = page.getByRole('separator', {
      name: await t(page, 'pos.workspace.resizeCart')
    })
    await separator.focus()
    for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowRight')
    const box = await separator.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 6 })
    await page.mouse.up()
    const draft = await pinia(page, 'posWorkspace', 'JSON.parse(JSON.stringify(s.draft))')
    ctx.step('B: draft after preset/side/density/keyboard+pointer resize', { draft })
    if (draft.cartSide !== 'start' || draft.density !== 'comfortable')
      throw new Error('B: editor did not change the draft')
    const midEdit = await businessSnapshot(page)
    const midDiff = diffSnapshots(before, midEdit)
    if (midDiff)
      throw new Error(`B: business state changed while editing: ${JSON.stringify(midDiff)}`)
    await ctx.shot(page, 'B2-draft-preview')
    await page.getByTestId('workspace-apply').click()
    await page.getByTestId('workspace-edit-bar').waitFor({ state: 'detached' })
    const afterApply = await businessSnapshot(page)
    const applyDiff = diffSnapshots(before, afterApply)
    if (applyDiff)
      throw new Error(`B: business state changed by Apply: ${JSON.stringify(applyDiff)}`)
    const storedAfterApply = layoutRows()
    ctx.step('B: applied; business state identical', {
      stored: storedAfterApply.map((r) => JSON.parse(r.layout_json))
    })
    if (storedAfterApply.length !== 1) throw new Error('B: Apply did not store exactly one row')
    await ctx.shot(page, 'B3-applied-balanced-left-comfortable')

    await page.getByTestId('workspace-customize').click()
    await page
      .getByTestId('workspace-preset')
      .getByRole('radio', { name: await t(page, 'pos.workspace.presets.scanner') })
      .click()
    await page.getByTestId('workspace-cancel').click()
    await page.getByTestId('workspace-edit-bar').waitFor({ state: 'detached' })
    const afterCancel = await businessSnapshot(page)
    if (diffSnapshots(before, afterCancel)) throw new Error('B: business state changed by Cancel')
    if (JSON.stringify(layoutRows()) !== JSON.stringify(storedAfterApply))
      throw new Error('B: Cancel wrote the layout')
    ctx.step('B: cancel kept the business state and the stored layout')

    // --- C. Scanner and keys while editing --------------------------------------------------------
    await page.getByTestId('workspace-customize').click()
    await page.getByTestId('workspace-edit-bar').waitFor()
    const draftAtOpen = await pinia(page, 'posWorkspace', 'JSON.stringify(s.draft)')
    const signature = await cartSignatureOf(page)
    const probes = []
    for (const [target, suffix, code] of [
      ['workspace-apply', 'Enter', namedBarcode(8)],
      ['workspace-apply', 'Tab', namedBarcode(8)],
      ['workspace-restore', 'Enter', namedBarcode(1)],
      ['workspace-restore', '', namedBarcode(2)],
      ['workspace-cancel', 'Enter', '629 1000000003'],
      ['workspace-apply', 'Enter', `2*${namedBarcode(3)}`]
    ]) {
      await page.getByTestId(target).focus()
      const changed = await scanBurst(page, code, { suffix, expectChange: false, blur: false })
      const state = await pinia(
        page,
        'posWorkspace',
        'JSON.parse(JSON.stringify({ editing: s.editing, saving: s.saving, draft: JSON.stringify(s.draft) }))'
      )
      const focused = await page.evaluate(
        () => document.activeElement?.getAttribute('data-testid') ?? null
      )
      probes.push({
        target,
        suffix,
        code,
        changed,
        editing: state.editing,
        draftSame: state.draft === draftAtOpen,
        focused
      })
      if (changed || !state.editing || state.saving || state.draft !== draftAtOpen)
        throw new Error(
          `C: a scan on ${target} (${suffix || 'no suffix'}) had an effect: ${JSON.stringify(probes.at(-1))}`
        )
    }
    await page.keyboard.press('F9')
    await page.keyboard.press('Shift+F9')
    await page.waitForTimeout(500)
    const paymentOpen = (await page.locator('[aria-modal="true"]').count()) > 0
    const notice = await page
      .getByTestId('workspace-edit-notice')
      .innerText()
      .catch(() => null)
    ctx.step('C: scans and payment keys while editing', { probes, paymentOpen, notice })
    if (paymentOpen) throw new Error('C: F9/Shift+F9 opened payment while editing')
    if ((await cartSignatureOf(page)) !== signature)
      throw new Error('C: the cart changed while editing')
    if (JSON.stringify(layoutRows()) !== JSON.stringify(storedAfterApply))
      throw new Error('C: a scan wrote the layout')
    if (!notice) throw new Error('C: no "scanner paused" notice was shown')
    await ctx.shot(page, 'C1-scans-refused-while-editing')

    // Intentional keyboard activation still works: Enter on Restore defaults changes the draft only.
    await page.getByTestId('workspace-restore').focus()
    await page.waitForTimeout(400)
    await page.keyboard.press('Enter')
    const restored = await pinia(
      page,
      'posWorkspace',
      'JSON.parse(JSON.stringify({ d: s.draft, r: s.restorePending }))'
    )
    if (!restored.r || restored.d.preset !== 'cartFirst')
      throw new Error('C: Enter did not activate Restore defaults')
    if (JSON.stringify(layoutRows()) !== JSON.stringify(storedAfterApply))
      throw new Error('C: Restore defaults wrote before Apply')
    await page.keyboard.press('Escape')
    await page.getByTestId('workspace-edit-bar').waitFor({ state: 'detached' })
    ctx.step('C: Enter activated Restore (draft only); Esc cancelled')

    // A scan racing the editor's opening, made deterministic by a barrier on the real lookup
    // channel: the main-process lookup runs, its ANSWER is held, the editor opens, then the answer is
    // released. The late answer must not reach the cart.
    const lookups = await installIpcBarrier(session.app, BARCODE_LOOKUP_CHANNEL)
    try {
      const raceBefore = await cartSignatureOf(page)
      const raceCode = namedBarcode(8)
      const marker = await markScanResult(page)
      await scanUnfocused(page, raceCode)
      await lookups.until((state) => state.held === 1, 'C: the lookup answer was never held')
      const inFlight = {
        cartUnchanged: (await cartSignatureOf(page)) === raceBefore,
        // The page's own Customize control refuses while an add is pending.
        customizeDisabled: await page.evaluate(
          () => document.querySelector('[data-testid="workspace-customize"]')?.disabled ?? null
        )
      }
      if (!inFlight.cartUnchanged || inFlight.customizeDisabled === false)
        throw new Error(`C: the held lookup was not in flight: ${JSON.stringify(inFlight)}`)
      // The race itself: an editor opened anyway while the answer is held.
      await pinia(page, 'posWorkspace', 's.beginEdit()')
      await page.getByTestId('workspace-edit-bar').waitFor()
      await lookups.releaseOne()
      await lookups.until((state) => state.answered === 1, 'C: the held answer was not delivered')
      const lateResult = await waitForNewScanResult(page, marker, raceCode)
      const pausedMessage = await t(page, 'pos.workspace.edit.scannerPaused')
      const raceChanged = (await cartSignatureOf(page)) !== raceBefore
      ctx.step('C: held lookup released after editing began', {
        inFlight,
        lateResult,
        raceChanged
      })
      if (raceChanged)
        throw new Error('C: a lookup that finished after editing began reached the cart')
      if (!lateResult.includes(pausedMessage))
        throw new Error(`C: the late answer was not refused as paused: ${lateResult}`)
      await page.keyboard.press('Escape')
      await page.getByTestId('workspace-edit-bar').waitFor({ state: 'detached' })
      if (diffSnapshots(before, await businessSnapshot(page)))
        throw new Error('C: business state changed')

      // The control case: the same held lookup, answered BEFORE editing begins, is added normally
      // and stays in the cart when the editor then opens.
      const addBefore = await cartSignatureOf(page)
      const addCode = namedBarcode(8)
      const addMarker = await markScanResult(page)
      await scanUnfocused(page, addCode)
      await lookups.until((state) => state.held === 1, 'C: the second lookup answer was not held')
      if ((await cartSignatureOf(page)) !== addBefore)
        throw new Error('C: the cart changed before the held answer was released')
      await lookups.releaseOne()
      await lookups.until((state) => state.answered === 2, 'C: the second answer was not delivered')
      const addResult = await waitForNewScanResult(page, addMarker, addCode)
      const added = (await cartSignatureOf(page)) !== addBefore
      await pinia(page, 'posWorkspace', 's.beginEdit()')
      await page.getByTestId('workspace-edit-bar').waitFor()
      const keptWhileEditing = (await cartSignatureOf(page)) !== addBefore
      ctx.step('C: lookup answered before editing began', { addResult, added, keptWhileEditing })
      if (!added || !keptWhileEditing)
        throw new Error('C: a lookup answered before editing began was not added and kept')
      await page.keyboard.press('Escape')
      await page.getByTestId('workspace-edit-bar').waitFor({ state: 'detached' })
    } finally {
      await lookups.restore()
    }

    // --- D. Exact cash from the page and from the payment dialog -----------------------------------
    await page.evaluate(
      () => document.activeElement instanceof HTMLElement && document.activeElement.blur()
    )
    await page.keyboard.press('Shift+F9')
    const prefix = (
      await t(page, 'pos.payment.completion.committed', { offlineNumber: '\u0000' })
    ).split('\u0000')[0]
    await page.getByText(prefix, { exact: false }).first().waitFor({ timeout: 30_000 })
    ctx.step('D: page Shift+F9 exact cash committed')
    await ctx.shot(page, 'D1-exact-cash-page')
    await page
      .getByRole('dialog')
      .getByRole('button', { name: new RegExp(await t(page, 'pos.tender.newSale')) })
      .click()
    await scanBurst(page, namedBarcode(1))
    await payExactCash(ctx, page)
    await page
      .getByRole('dialog')
      .getByRole('button', { name: new RegExp(await t(page, 'pos.tender.newSale')) })
      .click()
    const report = await waitForServerInvoices(sandbox, device, 2, 90_000)
    ctx.step('D: two sales uploaded', { invoices: report.device_invoice_count })
    await ctx.shot(page, 'D2-after-sales')
  } finally {
    await session.app.close().catch(() => undefined)
    await sandbox.stop()
  }
}
