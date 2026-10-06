import { quickAction } from '../support/workspace.mjs'
import { t } from '../support/app.mjs'
import {
  openSandboxAndApp,
  payExactCash,
  refreshWorkstation,
  scan,
  setupPhysicalPresenceTill,
  sizeWindow,
  waitForServerInvoices
} from '../support/journey.mjs'
import { queryLocal } from '../support/localDb.mjs'

/**
 * POS improvements, Stage 4 — mixed tax configurations in one sale, PHYSICAL PRESENCE (upload v5).
 *
 * Precondition (fixture, labelled): categorized taxes and three untracked products — inclusive 15%
 * standard, exclusive zero-rated, inclusive exempt. COLA is the seeded tracked product (exclusive 15%,
 * its tax has NO category: the legacy case).
 *
 *  1. The refreshed register holds a `per_line` contract and the issued categories.
 *  2. COLA + inclusive + 2× zero-rated + exempt are scanned into ONE cart; no tax choice is asked for and
 *     no mixed-mode refusal appears. Exact cash.
 *  3. Local: header `mixed`, each line its own mode and frozen category, the queued payload is v5.
 *  4. Server: the same invoice, header `mixed`, v5 with its authority, every line's mode/category/tax/
 *     total equal to the register's, and the totals equal.
 *  5. Partial refund (1 inclusive + 1 of the 2 zero-rated) through Return / Refund; the server refund
 *     lines keep their own modes and copy the invoice lines' categories; local and server totals agree.
 */

const COLA = '6221000000011'
const INC = '7780000000011'
const ZERO = '7780000000028'
const EXEMPT = '7780000000035'

export function localSale(profileDir) {
  const [invoice] = queryLocal(
    profileDir,
    'SELECT local_uuid, tax_mode, subtotal_amount, discount_total_amount, tax_total_amount, grand_total_amount FROM local_invoices ORDER BY created_at DESC LIMIT 1'
  )
  const items = queryLocal(
    profileDir,
    'SELECT product_uuid, tax_mode, tax_category, tax_amount, total_amount FROM local_invoice_items WHERE invoice_local_uuid = ? ORDER BY line_index',
    [invoice.local_uuid]
  )
  const [queued] = queryLocal(
    profileDir,
    "SELECT payload_json FROM sync_queue WHERE aggregate_type = 'invoice' AND local_aggregate_uuid = ?",
    [invoice.local_uuid]
  )
  return { invoice, items, payload: JSON.parse(queued.payload_json) }
}

/** Every server line equals the register's line (mode, category, tax, total), in order. */
export function compareLines(local, server, label) {
  const pick = (line) => ({
    product_uuid: line.product_uuid,
    tax_mode: line.tax_mode,
    tax_category: line.tax_category ?? null,
    tax_amount: Number(line.tax_amount),
    total_amount: Number(line.total_amount)
  })
  const a = JSON.stringify(local.map(pick))
  const b = JSON.stringify(server.map(pick))
  if (a !== b) throw new Error(`${label}: local and server lines differ\n${a}\n${b}`)
}

export async function run(ctx) {
  const session = await openSandboxAndApp(ctx, {
    flags: { POS_OFFLINE_PHYSICAL_PRESENCE_ENABLED: 'true' }
  })
  const { sandbox } = session
  try {
    const device = await setupPhysicalPresenceTill(ctx, session)
    const page = session.page
    await sizeWindow(session, 1600, 900)
    ctx.step(
      'precondition: categorized taxes and mixed-mode products (fixture)',
      sandbox.fixture('mixed-tax-catalog')
    )
    await refreshWorkstation(ctx, page)

    // 1. The installed contract and categories.
    const [metadata] = queryLocal(
      session.profileDir,
      'SELECT mixed_tax_mode_policy FROM catalog_metadata'
    )
    const categories = queryLocal(
      session.profileDir,
      "SELECT sku, tax_mode, tax_category FROM catalog_products WHERE sku IN ('COLA-CAN','MIX-INC','MIX-ZERO','MIX-EXEMPT') ORDER BY sku"
    )
    ctx.step('1: installed contract and categories', {
      policy: metadata.mixed_tax_mode_policy,
      categories
    })
    if (metadata.mixed_tax_mode_policy !== 'per_line')
      throw new Error('1: the contract is not per_line')

    // 2. One mixed cart, exact cash.
    for (const code of [COLA, INC, ZERO, ZERO, EXEMPT]) await scan(ctx, page, code)
    await page.waitForTimeout(400)
    const mixedRefusal = await page
      .getByText(await t(page, 'pos.errors.CART_MIXED_TAX_MODE'))
      .count()
    await ctx.shot(page, '02a-mixed-cart')
    ctx.step('2: mixed cart built', { mixedRefusalShown: mixedRefusal > 0 })
    if (mixedRefusal > 0) throw new Error('2: the mixed-mode refusal is still shown')
    await payExactCash(ctx, page)
    await ctx.shot(page, '02b-sale-complete')
    await page
      .getByRole('dialog')
      .getByRole('button', { name: new RegExp(await t(page, 'pos.tender.newSale')) })
      .click()

    // 3. Local evidence.
    const local = localSale(session.profileDir)
    ctx.step('3: local invoice', {
      header: local.invoice.tax_mode,
      version: local.payload.client_contract_version,
      totals: local.invoice,
      lines: local.items
    })
    if (local.invoice.tax_mode !== 'mixed' || local.payload.client_contract_version !== 5)
      throw new Error('3: expected a mixed header uploaded as v5')

    // 4. Server evidence.
    await waitForServerInvoices(sandbox, device, 1, 90_000)
    const report = sandbox.fixture('mixed-tax-report')
    const server = report.invoices.find(
      (invoice) => invoice.idempotency_key === local.invoice.local_uuid
    )
    ctx.step('4: server invoice', { contracts: report.contracts.slice(-2), server })
    if (
      !server ||
      server.tax_mode !== 'mixed' ||
      server.contract_version !== 5 ||
      !server.offline_sale_authority
    )
      throw new Error('4: the server invoice is not a v5 mixed sale with its authority')
    compareLines(local.items, server.items, '4')
    for (const key of ['tax', 'grand']) {
      const localValue =
        key === 'tax' ? local.invoice.tax_total_amount : local.invoice.grand_total_amount
      if (server[key] !== localValue)
        throw new Error(`4: ${key} differs (${localValue} vs ${server[key]})`)
    }
    const serverCategories = server.items.map((item) => item.tax_category ?? null)
    if (
      JSON.stringify(serverCategories) !==
      JSON.stringify([null, 'standard', 'zero_rated', 'exempt'])
    )
      throw new Error(`4: server categories ${JSON.stringify(serverCategories)}`)

    // 5. Partial refund through Return / Refund.
    await (await quickAction(page, 'refund')).click()
    await page.getByTestId('refund-entry-dialog').waitFor()
    await page.getByTestId(`refund-entry-${local.invoice.local_uuid}`).click()
    const refundDialog = page.getByRole('dialog')
    const increase = refundDialog.getByRole('button', {
      name: await t(page, 'refunds.increaseQuantity')
    })
    await increase.nth(1).click() // the inclusive line
    await increase.nth(2).click() // one of the zero-rated
    await ctx.shot(page, '05a-partial-refund')
    await refundDialog.getByRole('button', { name: await t(page, 'refunds.previewAction') }).click()
    const confirmPrefix = (
      await t(page, 'refunds.confirmActionAmount', { amount: '\u0000' })
    ).split('\u0000')[0]
    await refundDialog.getByRole('button', { name: new RegExp(`^${confirmPrefix}`) }).click()
    await refundDialog.getByText(await t(page, 'refunds.success')).waitFor({ timeout: 30_000 })
    await ctx.shot(page, '05b-refund-accepted')
    await refundDialog.getByRole('button', { name: await t(page, 'refunds.close') }).click()

    const [localRefund] = queryLocal(
      session.profileDir,
      'SELECT submission_state, tax_total_amount, grand_total_amount FROM local_refunds WHERE invoice_local_uuid = ?',
      [local.invoice.local_uuid]
    )
    const afterRefund = sandbox
      .fixture('mixed-tax-report')
      .invoices.find((invoice) => invoice.idempotency_key === local.invoice.local_uuid)
    const serverRefund = afterRefund.refunds[0]
    ctx.step('5: partial refund', { localRefund, serverRefund })
    if (localRefund?.submission_state !== 'accepted' || !serverRefund)
      throw new Error('5: the refund was not accepted')
    if (
      serverRefund.tax !== localRefund.tax_total_amount ||
      serverRefund.grand !== localRefund.grand_total_amount
    )
      throw new Error('5: local and server refund totals differ')
    const modes = serverRefund.items.map((item) => `${item.tax_mode}/${item.tax_category}`)
    if (JSON.stringify(modes) !== JSON.stringify(['inclusive/standard', 'exclusive/zero_rated']))
      throw new Error(`5: refund line modes/categories ${modes}`)
  } finally {
    await session.app.close().catch(() => undefined)
    await sandbox.stop()
  }
}
