import { t } from '../support/app.mjs'
import {
  activate,
  deviceUuid,
  openSandboxAndApp,
  openShift,
  payExactCash,
  refreshWorkstation,
  scan,
  signIn,
  sizeWindow,
  waitForRoute,
  waitForServerInvoices
} from '../support/journey.mjs'
import { queryLocal } from '../support/localDb.mjs'
import { compareLines, localSale } from './qc4mixedtax.mjs'

/**
 * POS improvements, Stage 4 — mixed tax configurations in one sale, ALLOCATION-BACKED (upload v4).
 *
 * The warehouse runs the allocation-exclusive policy (fixture; COLA exposed for allocation), so the
 * register holds no physical-presence authority: a uniform sale would upload as v2, a mixed one as v4.
 *
 *  1. The register installs a `per_line` contract with the issued categories.
 *  2. COLA (tracked, exclusive 15%, legacy uncategorized tax: covered by a real allocation grant) +
 *     the inclusive standard and inclusive exempt products in ONE cart; the summary shows
 *     "Total excl. VAT". Exact cash.
 *  3. Local: header `mixed`, the queued payload is v4 with NO authority, COLA carries its allocation
 *     consumption proof.
 *  4. Server: header `mixed`, v4, no authority; every line equals the register's; totals equal.
 */

const COLA = '6221000000011'
const INC = '7780000000011'
const EXEMPT = '7780000000035'

export async function run(ctx) {
  const session = await openSandboxAndApp(ctx)
  const { sandbox } = session
  try {
    const page = session.page
    await sizeWindow(session, 1600, 900)
    await activate(ctx, page)
    await signIn(ctx, page)
    await waitForRoute(page, 'pos')
    const device = await deviceUuid(sandbox)
    sandbox.fixture('assign-device', device)
    ctx.step(
      'precondition: allocation-mode warehouse (fixture)',
      sandbox.fixture('mode-allocation', 'COLA-CAN')
    )
    ctx.step(
      'precondition: categorized taxes and mixed-mode products (fixture)',
      sandbox.fixture('mixed-tax-catalog')
    )
    await refreshWorkstation(ctx, page)
    await openShift(ctx, page)

    // 1. Contract.
    const [metadata] = queryLocal(
      session.profileDir,
      'SELECT mixed_tax_mode_policy FROM catalog_metadata'
    )
    const authorities = queryLocal(
      session.profileDir,
      "SELECT mode FROM offline_sale_authorities WHERE mode = 'physical_presence'"
    )
    ctx.step('1: installed contract', {
      policy: metadata.mixed_tax_mode_policy,
      physicalPresenceAuthorities: authorities.length
    })
    if (metadata.mixed_tax_mode_policy !== 'per_line')
      throw new Error('1: the contract is not per_line')

    // 2. One mixed cart.
    for (const code of [COLA, INC, EXEMPT]) await scan(ctx, page, code)
    await page.waitForTimeout(400)
    const summaryLabel = await t(page, 'pos.totalExclVat')
    const showsNet = await page.getByText(summaryLabel, { exact: true }).count()
    await ctx.shot(page, '02a-mixed-cart-allocation')
    ctx.step('2: mixed cart summary', { showsTotalExclVat: showsNet > 0 })
    if (showsNet === 0) throw new Error('2: the mixed cart summary does not show Total excl. VAT')
    await payExactCash(ctx, page)
    await ctx.shot(page, '02b-sale-complete')
    await page
      .getByRole('dialog')
      .getByRole('button', { name: new RegExp(await t(page, 'pos.tender.newSale')) })
      .click()

    // 3. Local evidence.
    const local = localSale(session.profileDir)
    const consumptions = queryLocal(
      session.profileDir,
      'SELECT COUNT(*) AS n FROM local_stock_allocation_consumptions WHERE invoice_local_uuid = ?',
      [local.invoice.local_uuid]
    )[0].n
    ctx.step('3: local invoice', {
      header: local.invoice.tax_mode,
      version: local.payload.client_contract_version,
      authority: local.payload.offline_sale_authority_uuid ?? null,
      allocationConsumptions: consumptions,
      totals: local.invoice,
      lines: local.items
    })
    if (local.invoice.tax_mode !== 'mixed' || local.payload.client_contract_version !== 4)
      throw new Error('3: expected a mixed header uploaded as v4')
    if ('offline_sale_authority_uuid' in local.payload)
      throw new Error('3: a v4 payload carries no authority')
    if (consumptions < 1) throw new Error('3: the tracked line carries no allocation proof')

    // 4. Server evidence.
    await waitForServerInvoices(sandbox, device, 1, 90_000)
    const server = sandbox
      .fixture('mixed-tax-report')
      .invoices.find((invoice) => invoice.idempotency_key === local.invoice.local_uuid)
    ctx.step('4: server invoice', { server })
    if (
      !server ||
      server.tax_mode !== 'mixed' ||
      server.contract_version !== 4 ||
      server.offline_sale_authority
    )
      throw new Error('4: the server invoice is not a v4 mixed sale without an authority')
    compareLines(local.items, server.items, '4')
    if (
      server.tax !== local.invoice.tax_total_amount ||
      server.grand !== local.invoice.grand_total_amount
    )
      throw new Error('4: local and server totals differ')
    const categories = server.items.map((item) => item.tax_category ?? null)
    if (JSON.stringify(categories) !== JSON.stringify([null, 'standard', 'exempt']))
      throw new Error(`4: server categories ${JSON.stringify(categories)}`)
  } finally {
    await session.app.close().catch(() => undefined)
    await sandbox.stop()
  }
}
