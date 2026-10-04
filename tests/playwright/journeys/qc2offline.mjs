import { t } from '../support/app.mjs'
import {
  CASHIER,
  MANAGER,
  openSandboxAndApp,
  payExactCash,
  refreshWorkstation,
  relaunch,
  scan,
  setupPhysicalPresenceTill,
  signIn,
  sizeWindow,
  signOutViaMenu,
  waitForRoute,
  waitForServerInvoices
} from '../support/journey.mjs'
import { queryLocal } from '../support/localDb.mjs'

/**
 * POS improvements, Stage 2 — durable register quick-create, end to end against the real backend.
 *
 * A. Cashier A (granted the three quick-create permissions; fixture precondition — the owner-SPA
 *    grant itself is proven by qc1permissions) goes OFFLINE and creates a customer, a product and a
 *    supplier through the real dialogs, and sells to the new customer. The app restarts offline:
 *    everything survives. On reconnect the customer POST is HELD by the proxy (fault injection: the
 *    request reaches the server only after the register already saw a dropped connection), so the
 *    register replays the SAME request: one customer. The sale uploads only after the customer.
 *    The product turns Ready to sell only after its server-issued revision is installed, then sells.
 * B. Reassignment: A creates a customer offline and signs out; the manager signs in, sees "Waiting
 *    for its creator" and takes it over (it provably never left the register): one customer, by the
 *    manager.
 * C. Revocation: A creates a customer offline and sells to it; A's permission is revoked (fixture
 *    precondition) before synchronization; after a restart the server refuses it (403): the record
 *    is "Needs permission", the sale waits. The permission is re-granted; Retry replays the SAME
 *    request: one customer, and the sale uploads.
 */

const COLA = '6221000000011'
const JUICE_BARCODE = '7770000002001'

async function quickCreate(ctx, page, kind, fields) {
  // Stage 3: the create actions live in the More sheet of the quick-action row.
  await page.locator('.quick-actions [data-action="more"]').click()
  await page.getByTestId('more-actions-dialog').waitFor()
  await page.getByTestId(`more-actions-${kind}`).click()
  const dialog = page.getByTestId('quick-create-dialog')
  await dialog.waitFor()
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'more') {
      await dialog.getByRole('button', { name: await t(page, 'quickCreate.moreDetails') }).click()
      for (const [moreKey, moreValue] of Object.entries(value)) {
        await dialog
          .getByLabel(await t(page, `quickCreate.field.${moreKey}`))
          .first()
          .fill(moreValue)
      }
      continue
    }
    await dialog
      .getByLabel(await t(page, `quickCreate.field.${key}`))
      .first()
      .fill(value)
  }
  await ctx.shot(page, `${kind}-${fields.name.replace(/\W+/g, '-').toLowerCase()}-dialog`)
  await page.getByTestId('quick-create-save').click()
  await dialog.waitFor({ state: 'detached', timeout: 15_000 })
  ctx.step(`quick-created ${kind} through the dialog`, { name: fields.name })
}

async function records(page) {
  const result = await page.evaluate(() => window.posApi.quickCreate.list())
  if (!result.ok) throw new Error(JSON.stringify(result.error))
  return result.data
}

async function waitRecord(page, name, statuses, label, timeout = 60_000) {
  const deadline = Date.now() + timeout
  let found = null
  while (Date.now() < deadline) {
    found = (await records(page)).find((r) => r.name === name && r.status !== 'superseded')
    if (found && statuses.includes(found.status)) return found
    await page.waitForTimeout(1000)
  }
  throw new Error(`${label}: ${JSON.stringify(found)}`)
}

async function online(session, on) {
  if (on) await session.proxy.online()
  else await session.proxy.offline()
  await session.page.evaluate(async () => await window.posApi.connectivity.checkNow())
}

async function newSale(page) {
  await page
    .getByRole('dialog')
    .getByRole('button', { name: new RegExp(await t(page, 'pos.tender.newSale')) })
    .click()
  await page.waitForTimeout(800)
}

async function openSync(page) {
  await page.getByRole('link', { name: await t(page, 'navigation.sync'), exact: true }).click()
  await page.getByTestId('quick-create-records').waitFor()
}

async function openPos(page) {
  await page.getByRole('link', { name: await t(page, 'navigation.pos'), exact: true }).click()
  await waitForRoute(page, 'pos')
}

export async function run(ctx) {
  const session = await openSandboxAndApp(ctx, {
    flags: { POS_OFFLINE_PHYSICAL_PRESENCE_ENABLED: 'true' },
    proxy: true
  })
  const { sandbox, proxy } = session
  try {
    for (const permission of ['customers.create', 'catalog.products.create', 'suppliers.create']) {
      ctx.step(
        'precondition: grant (fixture)',
        sandbox.fixture('quick-create-grant', `cashier:${permission}:1`)
      )
    }
    const device = await setupPhysicalPresenceTill(ctx, session)
    let page = session.page
    // 1600 px: at 1366 px the top-bar navigation overlaps while the wide offline pills show (a
    // pre-existing layout defect, recorded and handled in Stage 5's responsive work).
    await sizeWindow(session, 1600, 900)

    // --- A. offline creation, restart, reconnect with a lost answer -------------------------------
    await page.locator('.quick-actions [data-action="more"]').click()
    await page.getByTestId('more-actions-dialog').waitFor()
    const items = await page
      .locator('[data-testid^="more-actions-"]:not([data-testid="more-actions-dialog"])')
      .allInnerTexts()
    ctx.step('A: quick-create menu for cashier A', { items })
    await ctx.shot(page, 'A0-menu')
    await page.keyboard.press('Escape')
    if (items.length !== 3) throw new Error(`A: expected 3 quick-create items, got ${items}`)

    await online(session, false)
    await quickCreate(ctx, page, 'customer', { name: 'Qc2 Offline Customer', phone: '0500002001' })
    await quickCreate(ctx, page, 'product', {
      name: 'Qc2 Juice',
      price: '4.25',
      more: { barcode: JUICE_BARCODE }
    })
    await quickCreate(ctx, page, 'supplier', { name: 'Qc2 Supplier Co', phone: '0500002002' })
    const customerName = await page
      .locator('.pos-page__customer, [data-testid="cart-customer"]')
      .first()
      .innerText()
      .catch(() => null)
    ctx.step('A: cart customer after creation', { customerName })
    await scan(ctx, page, COLA)
    await ctx.shot(page, 'A1-offline-cart-new-customer')
    await payExactCash(ctx, page)
    await newSale(page)
    const offlineRecords = await records(page)
    ctx.step(
      'A: records while offline',
      offlineRecords.map((r) => ({ name: r.name, status: r.status }))
    )
    if (offlineRecords.some((r) => r.status !== 'pending_sync'))
      throw new Error('A: expected pending_sync')
    await openSync(page)
    await ctx.shot(page, 'A2-sync-pending-offline')
    await openPos(page)

    const customerUuid = offlineRecords.find((r) => r.name === 'Qc2 Offline Customer').entityUuid
    const productUuid = offlineRecords.find((r) => r.name === 'Qc2 Juice').entityUuid
    const supplierUuid = offlineRecords.find((r) => r.name === 'Qc2 Supplier Co').entityUuid

    // Restart while still offline: rows, frozen payloads and the sale survive.
    await relaunch(ctx, session)
    page = session.page
    await sizeWindow(session, 1600, 900)
    await waitForRoute(page, 'pos')
    const afterRestart = queryLocal(
      session.profileDir,
      'SELECT entity_type, state, dispatch_count FROM entity_create_outbox ORDER BY created_at'
    )
    const heldSale = queryLocal(
      session.profileDir,
      'SELECT i.customer_uuid, q.state FROM local_invoices i JOIN sync_queue q ON q.local_aggregate_uuid = i.local_uuid'
    )
    ctx.step('A: after an offline restart', { outbox: afterRestart, sale: heldSale })
    if (afterRestart.length !== 3 || afterRestart.some((r) => r.state !== 'pending')) {
      throw new Error('A: the outbox did not survive the restart intact')
    }
    if (heldSale[0]?.customer_uuid !== customerUuid) throw new Error('A: sale lost its customer')

    // Reconnect: the customer POST is held (the register sees a dropped connection; fault injection).
    const lost = proxy.hold('lost-customer', /^POST \/api\/v1\/desktop\/quick-create\/customers/)
    await online(session, true)
    await lost.captured
    const committed = await lost.release()
    ctx.step('A: held customer request delivered to the server after the register gave up', {
      status: committed?.status ?? null
    })
    await waitRecord(
      page,
      'Qc2 Offline Customer',
      ['created'],
      'A: customer not accepted after replay',
      90_000
    )
    await waitRecord(page, 'Qc2 Supplier Co', ['created'], 'A: supplier not accepted')
    const productAfter = await waitRecord(
      page,
      'Qc2 Juice',
      ['awaiting_catalog', 'ready_to_sell'],
      'A: product not accepted'
    )
    ctx.step('A: product after acceptance', { status: productAfter.status })
    await waitForServerInvoices(sandbox, device, 1, 90_000)
    const customerOutbox = queryLocal(
      session.profileDir,
      'SELECT state, dispatch_count, updated_at FROM entity_create_outbox WHERE client_entity_uuid = ?',
      [customerUuid]
    )[0]
    const saleQueue = queryLocal(
      session.profileDir,
      "SELECT state, updated_at FROM sync_queue WHERE aggregate_type = 'invoice'"
    )
    ctx.step('A: replay and ordering', { customerOutbox, saleQueue })
    if (customerOutbox.dispatch_count < 2) throw new Error('A: the held request was not replayed')
    if (!(saleQueue[0].updated_at >= customerOutbox.updated_at))
      throw new Error('A: sale uploaded before its customer')

    await refreshWorkstation(ctx, page)
    await waitRecord(page, 'Qc2 Juice', ['ready_to_sell'], 'A: product not ready after refresh')
    await scan(ctx, page, JUICE_BARCODE)
    await ctx.shot(page, 'A3-new-product-in-cart')
    await payExactCash(ctx, page)
    await newSale(page)
    await waitForServerInvoices(sandbox, device, 2, 90_000)
    await openSync(page)
    await ctx.shot(page, 'A4-sync-created-ready')
    await openPos(page)

    const reportA = sandbox.fixture('quick-create-report')
    const by = (list, uuid) => list.filter((row) => row.uuid === uuid)
    ctx.step('A: backend effects', {
      customers: by(reportA.customers, customerUuid),
      products: by(reportA.products, productUuid),
      suppliers: by(reportA.suppliers, supplierUuid),
      requests: reportA.requests.map((r) => `${r.entity_type}:${r.outcome}:${r.user_email}`)
    })
    if (
      by(reportA.customers, customerUuid).length !== 1 ||
      by(reportA.products, productUuid).length !== 1 ||
      by(reportA.suppliers, supplierUuid).length !== 1
    ) {
      throw new Error('A: expected exactly one of each entity with the register ids')
    }
    if (reportA.requests.length !== 3)
      throw new Error(`A: expected 3 request results, got ${reportA.requests.length}`)

    // --- B. reassignment ---------------------------------------------------------------------------
    await online(session, false)
    await quickCreate(ctx, page, 'customer', { name: 'Qc2 Handover' })
    await signOutViaMenu(ctx, page)
    await online(session, true)
    await signIn(ctx, page, MANAGER)
    await waitForRoute(page, 'pos')
    await refreshWorkstation(ctx, page)
    await openSync(page)
    const waiting = await waitRecord(
      page,
      'Qc2 Handover',
      ['waiting_for_creator'],
      'B: not waiting for its creator'
    )
    await ctx.shot(page, 'B1-waiting-for-creator')
    await page
      .getByTestId(`quick-create-record-${waiting.entityUuid}`)
      .getByRole('button', { name: await t(page, 'quickCreate.records.reassign') })
      .click()
    try {
      await waitRecord(page, 'Qc2 Handover', ['created'], 'B: takeover not accepted')
    } catch (error) {
      await ctx.shot(page, 'B-debug-takeover')
      const access = await page.evaluate(async () => await window.posApi.quickCreate.getAccess())
      const alerts = await page
        .locator('[role=alert],[role=status]')
        .allInnerTexts()
        .catch(() => [])
      ctx.step('B: debug after takeover', { access, alerts: alerts.filter(Boolean).slice(0, 6) })
      throw error
    }
    await ctx.shot(page, 'B2-taken-over')
    const reportB = sandbox.fixture('quick-create-report')
    const handover = reportB.requests.filter((r) => r.client_entity_uuid === waiting.entityUuid)
    ctx.step('B: backend effects', {
      requests: handover,
      customers: by(reportB.customers, waiting.entityUuid)
    })
    if (
      handover.length !== 1 ||
      handover[0].user_email !== MANAGER.email ||
      by(reportB.customers, waiting.entityUuid).length !== 1
    ) {
      throw new Error('B: expected one customer, created by the manager')
    }
    await openPos(page)
    await signOutViaMenu(ctx, page)

    // --- C. revocation before synchronization, then recovery ----------------------------------------
    await signIn(ctx, page, CASHIER)
    await waitForRoute(page, 'pos')
    await refreshWorkstation(ctx, page)
    await online(session, false)
    await quickCreate(ctx, page, 'customer', { name: 'Qc2 Revoked Customer' })
    await scan(ctx, page, COLA)
    await payExactCash(ctx, page)
    await newSale(page)
    ctx.step(
      'precondition: revoke before sync (fixture)',
      sandbox.fixture('quick-create-grant', 'cashier:customers.create:0')
    )
    await relaunch(ctx, session)
    page = session.page
    await sizeWindow(session, 1600, 900)
    await waitForRoute(page, 'pos')
    await online(session, true)
    const blocked = await waitRecord(
      page,
      'Qc2 Revoked Customer',
      ['blocked'],
      'C: not blocked after the 403'
    )
    await openSync(page)
    await ctx.shot(page, 'C1-blocked-needs-permission')
    const heldC = queryLocal(
      session.profileDir,
      "SELECT COUNT(*) AS n FROM sync_queue WHERE aggregate_type = 'invoice' AND state <> 'synced'"
    )[0].n
    ctx.step('C: blocked record and held sale', {
      blocked: blocked.status,
      salesNotUploaded: heldC
    })
    if (heldC !== 1) throw new Error('C: the dependent sale must wait')

    ctx.step(
      'precondition: re-grant (fixture)',
      sandbox.fixture('quick-create-grant', 'cashier:customers.create:1')
    )
    await page
      .getByTestId(`quick-create-record-${blocked.entityUuid}`)
      .getByRole('button', { name: await t(page, 'quickCreate.records.retry') })
      .click()
    await waitRecord(
      page,
      'Qc2 Revoked Customer',
      ['created'],
      'C: not accepted after re-grant',
      90_000
    )
    await waitForServerInvoices(sandbox, device, 3, 90_000)
    await ctx.shot(page, 'C2-recovered')
    const recovered = queryLocal(
      session.profileDir,
      'SELECT state, dispatch_count FROM entity_create_outbox WHERE client_entity_uuid = ?',
      [blocked.entityUuid]
    )
    const reportC = sandbox.fixture('quick-create-report')
    ctx.step('C: backend effects', {
      outbox: recovered,
      customers: by(reportC.customers, blocked.entityUuid),
      requests: reportC.requests.filter((r) => r.client_entity_uuid === blocked.entityUuid)
    })
    if (
      recovered.length !== 1 ||
      recovered[0].dispatch_count < 2 ||
      by(reportC.customers, blocked.entityUuid).length !== 1
    ) {
      throw new Error('C: expected the same request replayed into one customer')
    }
  } finally {
    ctx.facts.mainLogTail = session.logs
      .join('')
      .split('\n')
      .filter((l) => l.includes('api') || l.includes('entity-create') || l.includes('POS'))
      .slice(-80)
    await session.app.close().catch(() => undefined)
    await sandbox.stop()
  }
}
