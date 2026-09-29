import { deepEqual, equal, notEqual, ok } from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { closeDatabase, type SqliteDatabase } from '../../../src/main/database/connection'
import type { LocalSaleOutcome } from '../../../src/main/services/localSale.service'
import { readCommitted } from '../support/committedState'
import {
  liveBackendRows,
  liveBackendScalar,
  liveBackendStock,
  liveOwnerProductBackendAvailable,
  liveUploadFixture,
  type OwnerProductLiveContext
} from '../support/liveUploadBackend'
import { openExistingTestDatabase, openTestDatabase } from '../support/openTestDatabase'
import {
  buildOwnerProductHarness,
  cashIntent,
  fixtureOp,
  observeOpenShift,
  sha256,
  writeScenarioEvidence,
  type OwnerProductHarness
} from '../support/ownerProductLive'
import { realRepositories } from '../support/realRepositories'
import { databaseTest, type DatabaseSandbox } from '../support/sandbox'

/**
 * POS reliability rev 3 — the owner-product live gate: real Electron main-process services against
 * the real Laravel server started by `scripts/cp3g5LiveUpload.mjs` on a disposable SQLite database.
 *
 * Every scenario drives the production sale path (license validation, bootstrap install, local
 * sale, allocation acquisition with durable dispatch evidence, the dispatch reconciler and the
 * invoice upload worker) and proves its effects from BOTH databases: the desktop's own committed
 * rows (`readCommitted`, an independent connection) and the server's rows (read-only). The owner
 * and inventory changes a scenario needs are made on the server through the guarded
 * `guiFixture.php` (the owner FormRequest + `CreateProductAction`, `CreateStockReceivingAction`,
 * and the policy actions), never by raw writes.
 *
 * Guarantees are stated precisely: a request may be SENT more than once (a lost answer is re-sent
 * with the identical key and bytes); idempotency on the server and exactly-once ingest on the
 * desktop are what prevent a duplicate business effect. The assertions below count business
 * effects (requests recorded by the server, grants, invoices, movements), not network sends.
 *
 * Skips entirely unless the harness minted `CP3G5_MINT_OWNER_PRODUCT_CONTEXT=1`, so the ordinary
 * `npm run test:sqlite:electron` gate stays hermetic. Scenarios share one server and run in order.
 */

const OWNER_PRODUCT_PRICE = 1250
/** Per-run SKU suffix: the owner FormRequest rightly refuses a duplicate SKU on a reused server. */
const RUN = randomBytes(3).toString('hex').toUpperCase()
const sku = (base: string): string => `${base}-${RUN}`
/** Products given an allocation exposure policy so far; `mode-allocation` re-applies all of them. */
const exposed: string[] = []

function allocationMode(live: Live, ...bases: readonly string[]): void {
  for (const base of bases) {
    if (!exposed.includes(sku(base))) {
      exposed.push(sku(base))
    }
  }
  fixtureOp(live.context, 'mode-allocation', exposed.join(','))
}
const TOP_UP_PATH = '/api/v1/desktop/stock-allocations/top-up'

interface Live {
  readonly sandbox: DatabaseSandbox
  readonly context: OwnerProductLiveContext
  readonly origin: string
  database: SqliteDatabase
  harness: OwnerProductHarness
}

function liveTest(
  name: string,
  evidenceName: string,
  callback: (live: Live) => Promise<void>
): void {
  databaseTest(
    name,
    async (sandbox) => {
      const fixture = liveUploadFixture()
      ok(fixture !== null && fixture.ownerProductContext !== null)
      const database = openTestDatabase(sandbox)
      const live: Live = {
        sandbox,
        context: fixture.ownerProductContext,
        origin: fixture.origin,
        database,
        harness: buildOwnerProductHarness({
          database,
          repositories: realRepositories(database),
          context: fixture.ownerProductContext,
          origin: fixture.origin,
          startSession: true
        })
      }

      try {
        await callback(live)
      } catch (error) {
        writeScenarioEvidence(`${evidenceName}.failure`, {
          outcome: 'failed',
          // A PublicAppError is a plain object; its category/code/message are what diagnose it.
          message: (error instanceof Error ? error.message : JSON.stringify(error)).slice(0, 2000),
          lastOutcome: lastOutcome ?? null
        })
        throw error
      } finally {
        live.harness.stop()
        closeDatabase(live.database)
      }
    },
    {
      skip: liveOwnerProductBackendAvailable() ? false : 'no live owner-product context provided'
    }
  )
}

/**
 * "Refresh workstation data" after a server-side change. The catalog contract's `generated_at` has
 * one-second resolution, and the desktop (correctly) refuses a snapshot with the SAME timestamp but
 * a different revision (`CATALOG_REVISION_CONFLICT`); a cashier's refresh a moment later succeeds.
 * A scripted gate changes the catalog faster than any person, so it waits past the second boundary.
 */
async function refresh(live: Live): Promise<void> {
  await new Promise((done) => setTimeout(done, 1_100))
  await live.harness.bootstrap.refresh()
}

/** Real license validation + real bootstrap install, then the open server shift is observed. */
async function signIn(live: Live): Promise<void> {
  await live.harness.license.validate()
  await refresh(live)
  observeOpenShift(live.harness.repositories, live.context)
}

/** The most recent sale outcome, recorded so a failed run's evidence says what main answered. */
let lastOutcome: Record<string, unknown> | undefined

function remember(outcome: LocalSaleOutcome): LocalSaleOutcome {
  const { outcome: kind, attemptKey } = outcome
  lastOutcome = {
    outcome: kind,
    attemptKey,
    failureCode: (outcome as { failureCode?: string }).failureCode,
    code: (outcome as { code?: string }).code
  }
  return outcome
}

async function sell(
  live: Live,
  productUuid: string,
  quantity: number,
  attemptKey = randomUUID()
): Promise<LocalSaleOutcome> {
  return remember(
    await live.harness.completion.complete(
      attemptKey,
      cashIntent({
        catalogRevision: live.harness.installedRevision(),
        productUuid,
        quantity,
        unitPriceAmount: OWNER_PRODUCT_PRICE,
        paymentMethodUuid: live.context.payment_method_uuid
      })
    )
  )
}

/** Simulated restart: close every handle, reopen the same file, rebuild the services cold. */
function restart(live: Live): void {
  live.harness.stop()
  closeDatabase(live.database)
  live.database = openExistingTestDatabase(live.sandbox)
  live.harness = buildOwnerProductHarness({
    database: live.database,
    repositories: realRepositories(live.database),
    context: live.context,
    origin: live.origin,
    startSession: false
  })
}

/**
 * Precondition for every allocation-mode refusal: this register holds no physical-presence
 * authority. An authority, once issued, stays valid for its window even if the policy later
 * changes (backend §6.5), so the scenarios never rely on mode alone.
 */
function noPhysicalPresenceAuthority(live: Live): void {
  equal(
    live.harness.repositories.offlineSaleAuthorities.findUsable(
      live.context.company_uuid,
      live.context.device_uuid,
      new Date().toISOString()
    ),
    null,
    'precondition: no physical-presence authority is held'
  )
}

function ownerProduct(live: Live, sku: string): { uuid: string; sku: string } {
  const created = fixtureOp(live.context, 'create-owner-product', sku) as {
    uuid: string
    sku: string
    track_stock: boolean
  }
  equal(created.track_stock, true, 'the owner default must be a tracked product')
  return created
}

function attemptState(live: Live, attemptKey: string): string | undefined {
  return readCommitted<{ state: string }>(
    live.sandbox,
    'SELECT state FROM sale_attempts WHERE attempt_key = ?',
    [attemptKey]
  )[0]?.state
}

interface DispatchRow {
  readonly idempotency_key: string
  readonly state: string
  readonly send_count: number
  readonly ambiguous_send_count: number
  readonly request_body_json: string
}

function dispatchRows(live: Live, attemptKey: string): DispatchRow[] {
  return readCommitted<DispatchRow>(
    live.sandbox,
    'SELECT * FROM attempt_allocation_dispatches WHERE attempt_key = ? ORDER BY created_at',
    [attemptKey]
  )
}

interface LocalInvoiceFacts {
  readonly local_uuid: string
  readonly sync_status: string
  readonly stock_authorization_policy: string | null
  readonly offline_sale_authority_uuid: string | null
}

function localInvoice(live: Live, attemptKey: string): LocalInvoiceFacts[] {
  return readCommitted<LocalInvoiceFacts>(
    live.sandbox,
    'SELECT * FROM local_invoices WHERE attempt_key = ?',
    [attemptKey]
  )
}

/** The frozen evidence of one committed sale: its queue payload bytes and its item rows. */
function frozenFingerprint(live: Live, invoiceLocalUuid: string): string {
  const queue = readCommitted<{ payload_json: string; payload_hash: string }>(
    live.sandbox,
    `SELECT payload_json, payload_hash FROM sync_queue
      WHERE aggregate_type = 'invoice' AND local_aggregate_uuid = ?`,
    [invoiceLocalUuid]
  )
  const items = readCommitted<Record<string, unknown>>(
    live.sandbox,
    'SELECT * FROM local_invoice_items WHERE invoice_local_uuid = ? ORDER BY rowid',
    [invoiceLocalUuid]
  )
  equal(queue.length, 1, 'exactly one immutable upload row per invoice')
  return sha256(JSON.stringify({ queue, items }))
}

function serverRequestsForKey(key: string): number {
  return liveBackendScalar(
    'SELECT COUNT(*) AS total FROM stock_allocation_requests WHERE idempotency_key = ?',
    key
  )
}

function serverGrantsForKey(key: string): Array<{ uuid: string; granted_quantity_milli: number }> {
  return liveBackendRows(
    `SELECT a.uuid, a.granted_quantity_milli FROM stock_allocations a
       JOIN stock_allocation_requests r ON r.id = a.stock_allocation_request_id
      WHERE r.idempotency_key = ? ORDER BY a.id`,
    key
  )
}

function serverInvoiceEffects(invoiceLocalUuid: string): {
  readonly invoices: number
  readonly syncRecords: number
  readonly movements: number
  readonly movedMilli: number
} {
  const invoiceIds = `SELECT pos_invoice_id FROM desktop_invoice_syncs
                       WHERE local_invoice_uuid = ? AND pos_invoice_id IS NOT NULL`
  return {
    invoices: liveBackendScalar(
      `SELECT COUNT(DISTINCT pos_invoice_id) AS total FROM desktop_invoice_syncs
        WHERE local_invoice_uuid = ? AND pos_invoice_id IS NOT NULL`,
      invoiceLocalUuid
    ),
    syncRecords: liveBackendScalar(
      'SELECT COUNT(*) AS total FROM desktop_invoice_syncs WHERE local_invoice_uuid = ?',
      invoiceLocalUuid
    ),
    movements: liveBackendScalar(
      `SELECT COUNT(*) AS total FROM stock_movements WHERE pos_invoice_id IN (${invoiceIds})`,
      invoiceLocalUuid
    ),
    movedMilli: Math.round(
      liveBackendScalar(
        `SELECT COALESCE(SUM(quantity), 0) AS total FROM stock_movements
          WHERE pos_invoice_id IN (${invoiceIds})`,
        invoiceLocalUuid
      ) * 1000
    )
  }
}

function localGrantCount(live: Live, allocationUuid: string): number {
  return readCommitted(
    live.sandbox,
    'SELECT allocation_uuid FROM stock_allocation_grants WHERE allocation_uuid = ?',
    [allocationUuid]
  ).length
}

function topUpBodies(harness: OwnerProductHarness): string[] {
  return harness.spy.requests
    .filter((request) => request.pathname === TOP_UP_PATH)
    .map((request) => request.bodyText)
}

// -------------------------------------------------------------------------------------------------

liveTest(
  'A: an owner-created tracked product with no stock record is refused honestly, releases the attempt, and sells after stock is received and data refreshed',
  'A-allocation-no-stock-record',
  async (live) => {
    const product = ownerProduct(live, sku('OPA-1'))
    allocationMode(live, 'OPA-1')
    await signIn(live)
    equal(live.harness.repositories.stockAllocations.getCapability()?.state, 'supported')
    noPhysicalPresenceAuthority(live)
    equal(liveBackendStock(product.uuid), null, 'precondition: no StockItem on the server')

    const refusedKey = randomUUID()
    const refused = await sell(live, product.uuid, 1, refusedKey)
    equal(refused.outcome, 'rejected')
    equal((refused as { failureCode: string }).failureCode, 'stock-allocation-unavailable')
    equal(attemptState(live, refusedKey), 'rejected', 'terminal: the attempt key is released')
    const refusedDispatch = dispatchRows(live, refusedKey)
    equal(refusedDispatch.length, 1)
    equal(refusedDispatch[0].state, 'granted', 'the server answered with a zero grant')
    equal(serverRequestsForKey(refusedDispatch[0].idempotency_key), 1)
    equal(serverGrantsForKey(refusedDispatch[0].idempotency_key).length, 0)
    equal(liveBackendStock(product.uuid), null, 'the refusal created no inventory')
    equal(localInvoice(live, refusedKey).length, 0)

    fixtureOp(live.context, 'receive-stock', `${sku('OPA-1')}:5`)
    await refresh(live)

    const soldKey = randomUUID()
    const sold = await sell(live, product.uuid, 1, soldKey)
    equal(sold.outcome, 'committed', 'the released attempt does not block the next sale')
    const [invoice] = localInvoice(live, soldKey)
    await live.harness.uploads.run()
    equal(localInvoice(live, soldKey)[0].sync_status, 'synced')
    const effects = serverInvoiceEffects(invoice.local_uuid)
    equal(effects.invoices, 1)
    equal(effects.movements, 1)
    equal(effects.movedMilli, 1000)
    equal(liveBackendStock(product.uuid)?.quantityMilli, 4000)

    writeScenarioEvidence('A-allocation-no-stock-record', {
      outcome: 'passed',
      refused: {
        attemptState: 'rejected',
        failureCode: 'stock-allocation-unavailable',
        dispatchState: refusedDispatch[0].state,
        serverRequests: 1,
        serverGrants: 0,
        serverStockItem: null
      },
      afterReceivingAndRefresh: {
        outcome: 'committed',
        localSyncStatus: 'synced',
        server: effects,
        serverStockQuantityMilli: 4000
      }
    })
  }
)

liveTest(
  'C: a cart frozen under an older catalog is refused by main after the owner changes the catalog, and only a rebuilt cart sells',
  'C-catalog-change-rebuild',
  async (live) => {
    await signIn(live)
    const product = ownerProduct(live, sku('OPC-1'))
    fixtureOp(live.context, 'receive-stock', `${sku('OPC-1')}:5`)
    allocationMode(live, 'OPA-1', 'OPC-1')
    await refresh(live)

    const frozenRevision = live.harness.installedRevision()
    const frozenIntent = cashIntent({
      catalogRevision: frozenRevision,
      productUuid: product.uuid,
      quantity: 1,
      unitPriceAmount: OWNER_PRODUCT_PRICE,
      paymentMethodUuid: live.context.payment_method_uuid
    })

    // The owner changes the catalog while the cart is open; the register refreshes.
    ownerProduct(live, sku('OPC-2'))
    await refresh(live)
    const currentRevision = live.harness.installedRevision()
    notEqual(currentRevision, frozenRevision)

    const staleKey = randomUUID()
    const stale = remember(await live.harness.completion.complete(staleKey, frozenIntent))
    equal(stale.outcome, 'rejected')
    equal((stale as { failureCode: string }).failureCode, 'catalog-superseded')
    equal(attemptState(live, staleKey), 'rejected')
    equal(localInvoice(live, staleKey).length, 0, 'never repriced or sold silently')

    const rebuiltKey = randomUUID()
    const rebuilt = await sell(live, product.uuid, 1, rebuiltKey)
    equal(rebuilt.outcome, 'committed')
    const [invoice] = localInvoice(live, rebuiltKey)
    await live.harness.uploads.run()
    const effects = serverInvoiceEffects(invoice.local_uuid)
    equal(effects.invoices, 1)
    equal(effects.movements, 1)

    writeScenarioEvidence('C-catalog-change-rebuild', {
      outcome: 'passed',
      revisionChanged: true,
      staleCart: { outcome: 'rejected', failureCode: 'catalog-superseded', localInvoices: 0 },
      rebuiltCart: { outcome: 'committed', server: effects }
    })
  }
)

liveTest(
  'D: the server commits a stock reservation but its answer is lost; after a restart the original key and bytes are replayed and the grant is ingested once',
  'D-lost-allocation-response',
  async (live) => {
    await signIn(live)
    const product = ownerProduct(live, sku('OPD-1'))
    fixtureOp(live.context, 'receive-stock', `${sku('OPD-1')}:5`)
    allocationMode(live, 'OPA-1', 'OPC-1', 'OPD-1')
    await refresh(live)

    const attemptKey = randomUUID()
    live.harness.spy.reset()
    // The request reaches the real server, the server commits, and only then is the answer lost.
    live.harness.spy.program({ kind: 'lose-acknowledgment' })
    const lost = await sell(live, product.uuid, 1, attemptKey)
    equal(lost.outcome, 'failed')
    equal((lost as { code: string }).code, 'allocation-acquisition-unresolved')
    equal(attemptState(live, attemptKey), 'claimed', 'fail-closed: no sale, key kept')

    const [recorded] = dispatchRows(live, attemptKey)
    equal(recorded.state, 'dispatched')
    equal(recorded.ambiguous_send_count, 1)
    const [firstBody] = topUpBodies(live.harness)
    deepEqual(JSON.parse(firstBody), JSON.parse(recorded.request_body_json))
    equal(serverRequestsForKey(recorded.idempotency_key), 1, 'the server really committed')
    const serverGrants = serverGrantsForKey(recorded.idempotency_key)
    equal(serverGrants.length, 1)
    equal(localGrantCount(live, serverGrants[0].uuid), 0, 'not ingested: the answer was lost')

    restart(live)

    live.harness.reconciler.requestRun()
    await live.harness.reconciler.whenIdle()
    const replayed = topUpBodies(live.harness)
    equal(replayed.length, 1, 'one replay after the restart')
    equal(replayed[0], firstBody, 'the original key and body, byte for byte')
    equal(dispatchRows(live, attemptKey)[0].state, 'granted')
    equal(serverRequestsForKey(recorded.idempotency_key), 1, 'server idempotency: no new request')
    deepEqual(serverGrantsForKey(recorded.idempotency_key), serverGrants, 'no duplicate grant')
    equal(localGrantCount(live, serverGrants[0].uuid), 1, 'ingested exactly once')

    // A second reconciler pass has nothing outstanding to send.
    live.harness.reconciler.requestRun()
    await live.harness.reconciler.whenIdle()
    equal(topUpBodies(live.harness).length, 1)

    const retried = remember(await live.harness.completion.retry(attemptKey))
    equal(retried.outcome, 'committed')
    equal(topUpBodies(live.harness).length, 1, 'the ingested grant covers the sale')
    const [invoice] = localInvoice(live, attemptKey)
    await live.harness.uploads.run()
    const effects = serverInvoiceEffects(invoice.local_uuid)
    equal(effects.invoices, 1)
    equal(effects.movements, 1)
    equal(
      liveBackendScalar(
        `SELECT COUNT(*) AS total FROM stock_allocation_consumptions c
           JOIN stock_allocations a ON a.id = c.stock_allocation_id WHERE a.uuid = ?`,
        serverGrants[0].uuid
      ),
      1,
      'the sale consumed the replayed grant once'
    )

    writeScenarioEvidence('D-lost-allocation-response', {
      outcome: 'passed',
      injection: 'lose-acknowledgment after the real server committed the top-up',
      beforeRestart: {
        outcome: 'failed',
        code: 'allocation-acquisition-unresolved',
        attemptState: 'claimed',
        dispatchState: 'dispatched',
        ambiguousSendCount: 1,
        serverRequests: 1,
        serverGrants: 1,
        localGrants: 0
      },
      afterRestart: {
        replaySends: 1,
        replayBodyIdenticalToOriginal: true,
        dispatchState: 'granted',
        serverRequests: 1,
        serverGrantsUnchanged: true,
        localGrants: 1
      },
      retry: { outcome: 'committed', additionalTopUps: 0, server: effects, serverConsumptions: 1 },
      totalTopUpSendsForKey: 2
    })
  }
)

liveTest(
  'B: physical-presence mode with no stock record sells and uploads only under a valid server-issued authority',
  'B-physical-presence-no-stock-record',
  async (live) => {
    const product = ownerProduct(live, sku('OPB-1'))
    // Allocation mode first: no physical-presence authority exists, so the offline sale is refused.
    allocationMode(live, 'OPA-1', 'OPC-1', 'OPD-1')
    await signIn(live)
    const owner = [live.context.company_uuid, live.context.device_uuid] as const
    noPhysicalPresenceAuthority(live)
    live.harness.setOnline(false)
    const refusedKey = randomUUID()
    const refused = await sell(live, product.uuid, 1, refusedKey)
    equal(refused.outcome, 'rejected')
    equal((refused as { failureCode: string }).failureCode, 'stock-allocation-unavailable')
    equal(localInvoice(live, refusedKey).length, 0)

    // Physical presence: a real license validation mints the authority, a real bootstrap installs it.
    live.harness.setOnline(true)
    fixtureOp(live.context, 'mode-physical-presence')
    await live.harness.license.validate()
    await refresh(live)
    const authority = live.harness.repositories.offlineSaleAuthorities.findUsable(
      ...owner,
      new Date().toISOString()
    )
    ok(authority !== null, 'the server issued a physical-presence authority')
    equal(liveBackendStock(product.uuid), null, 'precondition: still no StockItem')

    live.harness.setOnline(false)
    const soldKey = randomUUID()
    const sold = await sell(live, product.uuid, 1, soldKey)
    equal(sold.outcome, 'committed')
    const [invoice] = localInvoice(live, soldKey)
    equal(invoice.stock_authorization_policy, 'physical_presence')
    equal(invoice.offline_sale_authority_uuid, authority.authorityUuid)

    live.harness.setOnline(true)
    await live.harness.uploads.run()
    equal(localInvoice(live, soldKey)[0].sync_status, 'synced')
    const effects = serverInvoiceEffects(invoice.local_uuid)
    equal(effects.invoices, 1)
    const stockAfter = liveBackendStock(product.uuid)

    writeScenarioEvidence('B-physical-presence-no-stock-record', {
      outcome: 'passed',
      withoutAuthority: { outcome: 'rejected', failureCode: 'stock-allocation-unavailable' },
      withAuthority: {
        outcome: 'committed',
        stockAuthorizationPolicy: 'physical_presence',
        localSyncStatus: 'synced',
        server: effects,
        serverStockItemAfterUpload: stockAfter
      }
    })
  }
)

liveTest(
  'E: a sale committed offline under physical presence while its reservation answer was lost reconciles in either order with one invoice and no duplicate grant',
  'E-offline-before-reconciliation',
  async (live) => {
    // One fresh product per order: a late grant from the first order legitimately stays spendable
    // on this till, and would cover a second sale of the same product with no request at all.
    const products = {
      'upload-then-reconcile': ownerProduct(live, sku('OPE-1')),
      'reconcile-then-upload': ownerProduct(live, sku('OPE-2'))
    }
    fixtureOp(live.context, 'receive-stock', `${sku('OPE-1')}:10`)
    fixtureOp(live.context, 'receive-stock', `${sku('OPE-2')}:10`)
    // Exposure (so a reservation is requested), then physical presence for the warehouse.
    allocationMode(live, 'OPA-1', 'OPC-1', 'OPD-1', 'OPE-1', 'OPE-2')
    fixtureOp(live.context, 'mode-physical-presence')
    await signIn(live)
    ok(
      live.harness.repositories.offlineSaleAuthorities.findUsable(
        live.context.company_uuid,
        live.context.device_uuid,
        new Date().toISOString()
      ) !== null
    )

    const results: Record<string, unknown> = {}
    for (const order of ['upload-then-reconcile', 'reconcile-then-upload'] as const) {
      const product = products[order]
      const stockBefore = liveBackendStock(product.uuid)?.quantityMilli ?? 0
      const attemptKey = randomUUID()
      live.harness.spy.reset()
      live.harness.spy.program({ kind: 'lose-acknowledgment' })
      equal(
        live.harness.repositories.stockAllocations.getCapability()?.state,
        'supported',
        'precondition: the register can request reservations in physical-presence mode'
      )
      const lost = await sell(live, product.uuid, 1, attemptKey)
      equal(
        topUpBodies(live.harness).length,
        1,
        'a reservation request was sent and its answer lost'
      )
      equal(lost.outcome, 'failed')
      equal((lost as { code: string }).code, 'allocation-acquisition-unresolved')
      const [recorded] = dispatchRows(live, attemptKey)
      equal(recorded.state, 'dispatched')
      const serverGrants = serverGrantsForKey(recorded.idempotency_key)
      equal(serverGrants.length, 1, 'the server committed the reservation')

      // Connectivity drops; the cashier retries. Existing authority permits the offline commit.
      live.harness.setOnline(false)
      const committed = remember(await live.harness.completion.retry(attemptKey))
      equal(committed.outcome, 'committed')
      const [invoice] = localInvoice(live, attemptKey)
      equal(invoice.stock_authorization_policy, 'physical_presence')
      equal(dispatchRows(live, attemptKey)[0].state, 'dispatched', 'still owned by the reconciler')
      const frozen = frozenFingerprint(live, invoice.local_uuid)

      live.harness.setOnline(true)
      const runReconcile = async (): Promise<void> => {
        live.harness.reconciler.requestRun()
        await live.harness.reconciler.whenIdle()
      }
      if (order === 'upload-then-reconcile') {
        await live.harness.uploads.run()
        await runReconcile()
      } else {
        await runReconcile()
        await live.harness.uploads.run()
      }

      equal(localInvoice(live, attemptKey)[0].sync_status, 'synced')
      equal(dispatchRows(live, attemptKey)[0].state, 'granted')
      const effects = serverInvoiceEffects(invoice.local_uuid)
      equal(effects.invoices, 1, 'one server invoice')
      equal(effects.movements, 1, 'one stock movement')
      equal(effects.movedMilli, 1000)
      equal(liveBackendStock(product.uuid)?.quantityMilli, stockBefore - 1000)
      equal(serverRequestsForKey(recorded.idempotency_key), 1)
      deepEqual(serverGrantsForKey(recorded.idempotency_key), serverGrants, 'no duplicate grant')
      equal(localGrantCount(live, serverGrants[0].uuid), 1, 'ingested exactly once')
      equal(frozenFingerprint(live, invoice.local_uuid), frozen, 'frozen payload unchanged')
      const sends = topUpBodies(live.harness)
      equal(sends.length, 2, 'the original send and one replay')
      equal(sends[1], sends[0])
      // The sale committed uncovered under physical presence before the grant arrived, so the late
      // grant is an unconsumed reservation on this till, released later by the normal lifecycle.
      const lateGrantSpendableMilli = live.harness.repositories.stockAllocations.spendableMilli(
        serverGrants[0].uuid
      )
      equal(lateGrantSpendableMilli, serverGrants[0].granted_quantity_milli)

      results[order] = {
        lostAnswer: { outcome: 'failed', code: 'allocation-acquisition-unresolved' },
        offlineRetry: { outcome: 'committed', stockAuthorizationPolicy: 'physical_presence' },
        after: {
          localSyncStatus: 'synced',
          dispatchState: 'granted',
          server: effects,
          serverStockDeltaMilli: -1000,
          serverRequests: 1,
          serverGrants: 1,
          localGrants: 1,
          frozenPayloadUnchanged: true,
          topUpSends: sends.length,
          replayBodyIdentical: true,
          lateGrantSpendableMilli
        }
      }
    }

    writeScenarioEvidence('E-offline-before-reconciliation', { outcome: 'passed', ...results })
  }
)
