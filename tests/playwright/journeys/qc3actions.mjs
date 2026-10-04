import { t } from '../support/app.mjs'
import {
  openSandboxAndApp,
  payExactCash,
  scan,
  setupPhysicalPresenceTill,
  sizeWindow,
  waitForServerInvoices
} from '../support/journey.mjs'
import { queryLocal } from '../support/localDb.mjs'

/**
 * POS improvements, Stage 3 — quick actions and the Return / Refund entry, through the real UI.
 *
 *  1. Scanner selling stays fast: one scan → exact cash, timed (absolute; the code path is unchanged).
 *  2. With a populated cart, "Choose customer" → "New customer" (search text prefilled) creates and
 *     selects the customer; the cart lines and totals are unchanged.
 *  3. More → Add product: an empty save shows field errors (nothing is created); Cancel. More → Add
 *     supplier: Cancel. Cart, totals, payment state and scan focus are unchanged afterwards.
 *  4. F10 (Return / Refund) opens the sale picker over the POS; backing out preserves everything.
 *  5. The tile opens it again; the synced first sale is chosen and refunded through the existing refund
 *     flow; the cart is still there afterwards.
 *  6. Correct and send again: a supplier name already on the server is refused; the cashier corrects
 *     it from Sync and the corrected request (same entity id) is accepted.
 */

const COLA = '6221000000011'
const CHIPS = '6221000000035'

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

async function cartSnapshot(page) {
  return {
    lines: await pinia(
      page,
      'cart',
      'JSON.parse(JSON.stringify(s.lines.map((l) => [l.product.uuid, l.quantity])))'
    ),
    customer: await pinia(page, 'catalog', 's.selectedCustomerUuid'),
    payment: await pinia(
      page,
      'payment',
      'JSON.parse(JSON.stringify({ rows: s.rows ?? null, attempt: s.attemptKey ?? null }))'
    )
  }
}

async function tile(page, id) {
  return page.locator(`.quick-actions [data-action="${id}"]`)
}

export async function run(ctx) {
  const session = await openSandboxAndApp(ctx, {
    flags: { POS_OFFLINE_PHYSICAL_PRESENCE_ENABLED: 'true' }
  })
  const { sandbox } = session
  try {
    for (const permission of ['customers.create', 'catalog.products.create', 'suppliers.create']) {
      sandbox.fixture('quick-create-grant', `cashier:${permission}:1`)
    }
    ctx.step('precondition: quick-create grants for the cashier (fixture)')
    const device = await setupPhysicalPresenceTill(ctx, session)
    const page = session.page
    await sizeWindow(session, 1600, 900)

    // 1. Scanner selling, timed.
    const started = Date.now()
    await scan(ctx, page, COLA)
    await payExactCash(ctx, page)
    const elapsedMs = Date.now() - started
    ctx.step('1: scan → exact cash committed', { elapsedMs })
    await page
      .getByRole('dialog')
      .getByRole('button', { name: new RegExp(await t(page, 'pos.tender.newSale')) })
      .click()
    await waitForServerInvoices(sandbox, device, 1, 90_000)
    const tiles = await page
      .locator('.quick-actions [data-action]')
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-action')))
    ctx.step('1: quick-action tiles', { tiles })
    if (!tiles.includes('refund') || !tiles.includes('more'))
      throw new Error(`1: missing tiles ${tiles}`)
    await ctx.shot(page, '01-tiles')

    // 2. Populated cart → New customer from the customer dialog.
    await scan(ctx, page, COLA)
    await scan(ctx, page, CHIPS)
    const before = await cartSnapshot(page)
    await page.keyboard.press('F7')
    const customerDialog = page.getByRole('dialog')
    await customerDialog.getByLabel(await t(page, 'pos.customerSearchLabel')).fill('Qc3 Layla')
    await page.waitForTimeout(400)
    await ctx.shot(page, '02a-customer-dialog-new')
    await page.getByTestId('customer-dialog-new').click()
    const create = page.getByTestId('quick-create-dialog')
    await create.waitFor()
    const prefilled = await create
      .getByLabel(await t(page, 'quickCreate.field.name'))
      .first()
      .inputValue()
    await create
      .getByLabel(await t(page, 'quickCreate.field.phone'))
      .first()
      .fill('0500003001')
    await ctx.shot(page, '02b-new-customer-prefilled')
    await page.getByTestId('quick-create-save').click()
    await create.waitFor({ state: 'detached' })
    await page.waitForTimeout(600)
    const afterCustomer = await cartSnapshot(page)
    const customerName = await page.getByText('Qc3 Layla').first().isVisible()
    ctx.step('2: new customer from the selector', {
      prefilled,
      selected: afterCustomer.customer,
      visible: customerName
    })
    if (prefilled !== 'Qc3 Layla' || !afterCustomer.customer || !customerName)
      throw new Error('2: customer not created/selected')
    if (JSON.stringify(afterCustomer.lines) !== JSON.stringify(before.lines))
      throw new Error('2: cart lines changed')
    await ctx.shot(page, '02c-customer-selected-cart-kept')

    // 3. Validation and cancel.
    await (await tile(page, 'more')).click()
    await page.getByTestId('more-actions-dialog').waitFor()
    await ctx.shot(page, '03a-more-actions')
    await page.getByTestId('more-actions-product').click()
    await create.waitFor()
    await page.getByTestId('quick-create-save').click()
    await page.waitForTimeout(300)
    const errors = await create.locator('.app-field__control--error').count()
    await ctx.shot(page, '03b-product-validation')
    await create.getByRole('button', { name: await t(page, 'common.cancel') }).click()
    await create.waitFor({ state: 'detached' })
    await (await tile(page, 'more')).click()
    await page.getByTestId('more-actions-supplier').click()
    await create.waitFor()
    await create.getByRole('button', { name: await t(page, 'common.cancel') }).click()
    await create.waitFor({ state: 'detached' })
    const afterCancel = await cartSnapshot(page)
    const productsCreated = (
      await page.evaluate(() => window.posApi.quickCreate.list())
    ).data.filter((r) => r.entityType !== 'customer').length
    ctx.step('3: validation and cancel', {
      fieldErrors: errors,
      productsOrSuppliersCreated: productsCreated,
      cartKept: JSON.stringify(afterCancel) === JSON.stringify(afterCustomer)
    })
    if (errors < 2 || productsCreated !== 0) throw new Error('3: validation did not hold')
    if (JSON.stringify(afterCancel) !== JSON.stringify(afterCustomer))
      throw new Error('3: cart/payment changed')

    // 4. F10 opens the refund picker; Escape backs out; nothing changed.
    await page.keyboard.press('F10')
    await page.getByTestId('refund-entry-dialog').waitFor()
    await ctx.shot(page, '04a-refund-entry')
    await page.keyboard.press('Escape')
    await page.getByTestId('refund-entry-dialog').waitFor({ state: 'detached' })
    await page.waitForTimeout(300)
    const afterEscape = await cartSnapshot(page)
    const focus = await page.evaluate(() => ({
      tag: document.activeElement?.tagName ?? null,
      placeholder: document.activeElement?.getAttribute('placeholder') ?? null
    }))
    const scanPlaceholder = await t(page, 'pos.quickSale.scanPlaceholder')
    ctx.step('4: refund entry backed out', {
      cartKept: JSON.stringify(afterEscape) === JSON.stringify(afterCustomer),
      focus
    })
    if (JSON.stringify(afterEscape) !== JSON.stringify(afterCustomer))
      throw new Error('4: cart/payment changed')
    if (focus.tag !== 'INPUT' || focus.placeholder !== scanPlaceholder)
      throw new Error(`4: scan focus lost: ${JSON.stringify(focus)}`)

    // 5. The tile, the synced first sale, the existing refund flow.
    await (await tile(page, 'refund')).click()
    await page.getByTestId('refund-entry-dialog').waitFor()
    const synced = queryLocal(
      session.profileDir,
      "SELECT local_uuid FROM local_invoices WHERE sync_status = 'synced' ORDER BY created_at LIMIT 1"
    )[0].local_uuid
    await page.getByTestId(`refund-entry-${synced}`).click()
    const refundDialog = page.getByRole('dialog')
    await refundDialog
      .getByRole('button', { name: await t(page, 'refunds.increaseQuantity') })
      .first()
      .click()
    await ctx.shot(page, '05a-refund-dialog-from-pos')
    await refundDialog.getByRole('button', { name: await t(page, 'refunds.previewAction') }).click()
    const confirmPrefix = (
      await t(page, 'refunds.confirmActionAmount', { amount: '\u0000' })
    ).split('\u0000')[0]
    await refundDialog.getByRole('button', { name: new RegExp(`^${confirmPrefix}`) }).click()
    await refundDialog.getByText(await t(page, 'refunds.success')).waitFor({ timeout: 30_000 })
    await ctx.shot(page, '05b-refund-accepted')
    await refundDialog
      .getByRole('button', { name: await t(page, 'refunds.close') })
      .first()
      .click()
    await page.waitForTimeout(600)
    const afterRefund = await cartSnapshot(page)
    const refunds = queryLocal(
      session.profileDir,
      'SELECT invoice_local_uuid, submission_state FROM local_refunds'
    )
    ctx.step('5: refund through the POS entry', {
      refunds,
      cartKept: JSON.stringify(afterRefund.lines) === JSON.stringify(afterCustomer.lines)
    })
    if (
      refunds.length !== 1 ||
      refunds[0].submission_state !== 'accepted' ||
      refunds[0].invoice_local_uuid !== synced
    )
      throw new Error('5: refund not accepted')
    if (JSON.stringify(afterRefund.lines) !== JSON.stringify(afterCustomer.lines))
      throw new Error('5: cart changed')
    await ctx.shot(page, '05c-cart-after-refund')

    // 6. Correct and send again (live): a supplier name the server already holds.
    await (await tile(page, 'more')).click()
    await page.getByTestId('more-actions-supplier').click()
    await create
      .getByLabel(await t(page, 'quickCreate.field.name'))
      .first()
      .fill('Qc3 Duplicate Supplier')
    await page.getByTestId('quick-create-save').click()
    await create.waitFor({ state: 'detached' })
    await page.waitForFunction(
      async () =>
        (await window.posApi.quickCreate.list()).data.some(
          (r) => r.name === 'Qc3 Duplicate Supplier' && r.status === 'created'
        ),
      null,
      { timeout: 60_000 }
    )
    await (await tile(page, 'more')).click()
    await page.getByTestId('more-actions-supplier').click()
    await create
      .getByLabel(await t(page, 'quickCreate.field.name'))
      .first()
      .fill('qc3 duplicate supplier')
    await page.getByTestId('quick-create-save').click()
    await create.waitFor({ state: 'detached' })
    await page.waitForFunction(
      async () =>
        (await window.posApi.quickCreate.list()).data.some(
          (r) => r.name === 'qc3 duplicate supplier' && r.status === 'refused'
        ),
      null,
      { timeout: 60_000 }
    )
    await page.getByRole('link', { name: await t(page, 'navigation.sync'), exact: true }).click()
    const refused = (await page.evaluate(() => window.posApi.quickCreate.list())).data.find(
      (r) => r.name === 'qc3 duplicate supplier'
    )
    const row = page.getByTestId(`quick-create-record-${refused.entityUuid}`)
    await row.waitFor()
    await ctx.shot(page, '06a-refused-supplier')
    await row.getByRole('button', { name: await t(page, 'quickCreate.records.resubmit') }).click()
    const correction = page.getByTestId('quick-create-dialog')
    await correction
      .getByLabel(await t(page, 'quickCreate.field.name'))
      .first()
      .fill('Qc3 Second Supplier')
    await page.getByTestId('quick-create-save').click()
    await correction.waitFor({ state: 'detached' })
    await page.waitForFunction(
      async () =>
        (await window.posApi.quickCreate.list()).data.some(
          (r) => r.name === 'Qc3 Second Supplier' && r.status === 'created'
        ),
      null,
      { timeout: 60_000 }
    )
    await ctx.shot(page, '06b-corrected-accepted')
    const report = sandbox.fixture('quick-create-report')
    const sameId = report.suppliers.filter((s) => s.uuid === refused.entityUuid)
    const results = report.requests
      .filter((r) => r.client_entity_uuid === refused.entityUuid)
      .map((r) => `${r.outcome}:${r.code}`)
    ctx.step('6: correct and send again', { sameIdSuppliers: sameId, results })
    if (
      sameId.length !== 1 ||
      sameId[0].name !== 'Qc3 Second Supplier' ||
      results.join() !== 'refused:DESKTOP_SUPPLIER_NAME_TAKEN,accepted:DESKTOP_ENTITY_CREATED'
    ) {
      throw new Error('6: the corrected request did not reuse the entity id')
    }
  } finally {
    ctx.facts.mainLogTail = session.logs
      .join('')
      .split('\n')
      .filter((l) => l.includes('api') || l.includes('entity-create'))
      .slice(-60)
    await session.app.close().catch(() => undefined)
    await sandbox.stop()
  }
}
