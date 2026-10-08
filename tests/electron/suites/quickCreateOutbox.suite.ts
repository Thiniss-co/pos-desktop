import { deepEqual, equal, ok, throws } from 'node:assert/strict'
import { closeDatabase, type SqliteDatabase } from '../../../src/main/database/connection'
import type {
  QuickCreateOwner,
  QuickCreateRepository
} from '../../../src/main/repositories/quickCreate.repository'
import { QuickCreateService } from '../../../src/main/services/quickCreate.service'
import { EntityCreateWorker } from '../../../src/main/sync/entityCreateWorker'
import type { QuickCreateDispatchResult } from '../../../src/main/sync/quickCreate.client'
import type { QuickCreateAccess } from '../../../src/shared/contracts/quickCreate.contract'
import { desktopBootstrapFixture } from '../../../src/main/testing/fixtures/desktopBootstrap.fixture'
import { databaseTest, type DatabaseSandbox } from '../support/sandbox'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories, type RealRepositories } from '../support/realRepositories'

/**
 * POS improvements, Stage 2 — the register quick-create outbox against the REAL schema of migration
 * 0021 (CHECKs and triggers), the real repository, service, worker and dependency gate.
 *
 * Fault injection (labelled): a "crash" is a worker whose dispatch never settles followed by a new
 * worker instance on the same database file after the lease expired; transport outcomes are scripted.
 */

const COMPANY = '11111111-1111-4111-8111-111111111111'
const DEVICE = '33333333-3333-4333-8333-333333333333'
const CASHIER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CASHIER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const HASH_64 = 'a'.repeat(64)

interface Harness {
  readonly database: SqliteDatabase
  readonly repositories: RealRepositories
  readonly repository: QuickCreateRepository
  service(user: string, access?: Partial<QuickCreateAccess>): QuickCreateService
  worker(
    user: string,
    dispatch: (requestKey: string, payload: string) => Promise<QuickCreateDispatchResult>,
    access?: Partial<QuickCreateAccess>,
    now?: () => Date
  ): EntityCreateWorker
}

const ALLOW: QuickCreateAccess = { available: true, customer: true, supplier: true, product: true }

function harness(sandbox: DatabaseSandbox, existing?: SqliteDatabase): Harness {
  const database = existing ?? openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  if (!repositories.bootstrapSnapshot.getCompany()) {
    repositories.bootstrapSnapshot.persistSnapshot(
      desktopBootstrapFixture(),
      '2026-01-01T00:01:00+00:00'
    )
  }
  const repository = repositories.quickCreate
  const session = (
    user: string
  ): ConstructorParameters<typeof QuickCreateService>[0]['session'] => ({
    getContext: () => ({
      isAuthenticated: true,
      userUuid: user,
      companyUuid: COMPANY,
      deviceUuid: DEVICE
    })
  })
  const accessFor = (
    access: Partial<QuickCreateAccess> = {}
  ): ConstructorParameters<typeof QuickCreateService>[0]['access'] => {
    const value = { ...ALLOW, ...access }
    return {
      access: () => value,
      assertCanCreate: (type: 'customer' | 'supplier' | 'product') => {
        if (!value[type]) {
          throw Object.assign(new Error('denied'), { backendCode: 'PERMISSION_DENIED' })
        }
      }
    }
  }
  return {
    database,
    repositories,
    repository,
    service: (user, access) =>
      new QuickCreateService({
        database,
        repository,
        access: accessFor(access),
        session: session(user),
        requestSync: () => undefined
      }),
    worker: (user, dispatch, access, now) =>
      new EntityCreateWorker({
        repository,
        access: accessFor(access),
        session: session(user),
        dispatch: (row) => dispatch(row.requestKey, row.canonicalPayloadJson),
        now,
        schedule: () => () => undefined
      })
  }
}

const accepted = (uuid: string): QuickCreateDispatchResult => ({
  kind: 'accepted',
  serverEntityUuid: uuid
})
const outcome = (
  kind: 'refused' | 'conflict' | 'blocked_permission' | 'unknown',
  code: string
): QuickCreateDispatchResult => ({
  kind,
  code,
  message: code,
  fields: null,
  traceId: null
})

/** A committed sale for `customerUuid` with its queued upload, as Phase 3F leaves it. */
function seedSale(h: Harness, n: string, customerUuid: string | null): string {
  const id = (s: string): string => `00000000-0000-4000-8000-${s.padStart(12, '0')}`
  const invoiceUuid = id(`1${n}`)
  const attemptKey = id(`3${n}`)
  const at = '2026-01-02T10:00:00.000Z'
  h.repositories.saleAttempts.claim({
    attemptKey,
    companyUuid: COMPANY,
    deviceUuid: DEVICE,
    userUuid: CASHIER_A,
    claimSessionEpoch: 1,
    originShiftUuid: id('9'),
    originShiftObservedAt: at,
    originBranchUuid: id('8'),
    originWarehouseUuid: id('7'),
    originContextFingerprint: HASH_64,
    intentFingerprint: HASH_64,
    intentVersion: 1,
    intentJson: '{"v":1}'
  })
  h.repositories.localSale.insertInvoice({
    localUuid: invoiceUuid,
    attemptKey,
    offlineNumber: `POS-000001-20260102-00000${n}`,
    companyUuid: COMPANY,
    branchUuid: id('8'),
    warehouseUuid: id('7'),
    deviceUuid: DEVICE,
    userUuid: CASHIER_A,
    shiftUuid: id('9'),
    commitSessionEpoch: 1,
    catalogRevision: HASH_64,
    intentFingerprint: HASH_64,
    customerUuid,
    currency: 'USD',
    currencyExponent: 2,
    taxMode: 'none',
    invoiceDiscountType: null,
    invoiceDiscountValue: 0,
    subtotalAmount: 1000,
    discountTotalAmount: 0,
    taxTotalAmount: 0,
    grandTotalAmount: 1000,
    paidTotalAmount: 1000,
    changeDueAmount: 0,
    soldAt: at,
    connectivityStateAtSale: 'offline',
    soldWhileOffline: true,
    notes: null,
    commercialSnapshotJson: '{}',
    createdAt: at
  })
  h.repositories.saleAttempts.markCommitted(attemptKey, invoiceUuid, at)
  h.repositories.syncQueue.enqueue({
    localQueueUuid: id(`2${n}`),
    aggregateType: 'invoice',
    localAggregateUuid: invoiceUuid,
    operation: 'upload',
    payloadJson: `{"idempotency_key":"${invoiceUuid}"}`,
    payloadHash: HASH_64,
    idempotencyKey: invoiceUuid
  })
  return invoiceUuid
}

databaseTest(
  'quick-create writes the entity and its pending request atomically, with frozen bytes',
  (sandbox) => {
    const h = harness(sandbox)
    const record = h
      .service(CASHIER_A)
      .createCustomer({ name: '  Walk-in Ahmed ', phone: '0500000001', email: '' })
    equal(record.status, 'pending_sync')
    const row = h.repository.find(record.requestKey)!
    equal(row.state, 'pending')
    equal(row.dispatchCount, 0)
    deepEqual(JSON.parse(row.canonicalPayloadJson), {
      address: null,
      email: null,
      name: 'Walk-in Ahmed',
      notes: null,
      phone: '0500000001',
      tax_number: null
    })
    // The customer is selectable on this register at once, marked as pending sync.
    const found = h.repositories.catalog.getCustomer(record.entityUuid)
    equal(found?.name, 'Walk-in Ahmed')
    equal(found?.pendingSync, true)
    equal(
      h.repositories.catalog.searchCustomers({ query: 'walk', limit: 10, offset: 0 }).items[0]
        ?.uuid,
      record.entityUuid
    )

    // The frozen payload and identity can never change; rows are never deleted.
    throws(
      () =>
        h.database
          .prepare(
            "UPDATE entity_create_outbox SET canonical_payload_json = '{}' WHERE request_key = ?"
          )
          .run(row.requestKey),
      /immutable/
    )
    throws(
      () =>
        h.database
          .prepare('UPDATE entity_create_outbox SET client_entity_uuid = ? WHERE request_key = ?')
          .run(CASHIER_B, row.requestKey),
      /immutable/
    )
    throws(
      () =>
        h.database
          .prepare('DELETE FROM entity_create_outbox WHERE request_key = ?')
          .run(row.requestKey),
      /never deleted/
    )
    closeDatabase(h.database)
  }
)

databaseTest(
  'a lease left by a killed process is taken back at the next process start, not when it expires',
  (sandbox) => {
    const h = harness(sandbox)
    const key = h.service(CASHIER_A).createCustomer({ name: 'Interrupted' }).requestKey
    const cashier = { companyUuid: COMPANY, deviceUuid: DEVICE, userUuid: CASHIER_A }
    const claimedAt = '2026-01-02T00:00:00.000Z'
    const claimed = h.repository.claimNext(
      cashier,
      claimedAt,
      'lease-of-dead-process',
      '2026-01-02T00:01:00.000Z',
      []
    )
    equal(claimed?.requestKey, key)
    const frozenBefore = h.database
      .prepare('SELECT canonical_payload_json FROM entity_create_outbox WHERE request_key = ?')
      .get(key) as { canonical_payload_json: string }

    // Ten seconds later the lease has not expired: the expiry sweep leaves it alone...
    const restartedAt = '2026-01-02T00:00:10.000Z'
    equal(h.repository.reclaimExpired(cashier, restartedAt), 0)
    // ...the start-of-process reclaim takes it back at once, to be replayed with the same bytes.
    equal(h.repository.reclaimInterrupted(cashier, restartedAt), 1)
    const row = h.database
      .prepare(
        'SELECT state, result_code, lease_id, dispatch_count, canonical_payload_json FROM entity_create_outbox WHERE request_key = ?'
      )
      .get(key) as Record<string, unknown>
    equal(row.state, 'unknown')
    equal(row.result_code, 'INTERRUPTED')
    equal(row.lease_id, null)
    equal(row.dispatch_count, 1)
    equal(row.canonical_payload_json, frozenBefore.canonical_payload_json)
    equal(h.repository.reclaimInterrupted(cashier, restartedAt), 0, 'idempotent')
    // Another company's rows on this device are never touched.
    equal(h.repository.reclaimInterrupted({ ...cashier, companyUuid: CASHIER_B }, restartedAt), 0)
    closeDatabase(h.database)
  }
)

databaseTest(
  'the triggers and CHECKs enforce the state machine and the dispatch evidence',
  (sandbox) => {
    const h = harness(sandbox)
    const key = h.service(CASHIER_A).createCustomer({ name: 'Rules' }).requestKey
    const run = (sql: string) => () => h.database.prepare(sql).run(key)
    // pending -> accepted skips dispatch: illegal.
    throws(
      run(
        "UPDATE entity_create_outbox SET state = 'accepted', server_entity_uuid = client_entity_uuid WHERE request_key = ?"
      ),
      /illegal|CHECK/
    )
    // A claim without dispatch evidence is refused; pending with evidence violates the CHECK.
    throws(
      run(
        "UPDATE entity_create_outbox SET state = 'dispatching', lease_id = 'l', lease_expires_at = 'x' WHERE request_key = ?"
      ),
      /dispatch evidence|CHECK/
    )
    throws(
      run(
        "UPDATE entity_create_outbox SET dispatch_count = 1, first_dispatched_at = 'x' WHERE request_key = ?"
      ),
      /CHECK/
    )
    // A proper claim, then an accepted row must carry the client identity as the server identity.
    const now = '2026-01-02T00:00:00.000Z'
    const claimed = h.repository.claimNext(
      { companyUuid: COMPANY, deviceUuid: DEVICE, userUuid: CASHIER_A },
      now,
      'lease-1',
      '2026-01-02T00:01:00.000Z',
      []
    )
    equal(claimed?.dispatchCount, 1)
    throws(
      run(
        `UPDATE entity_create_outbox SET state = 'accepted', lease_id = NULL, lease_expires_at = NULL, server_entity_uuid = '${CASHIER_B}' WHERE request_key = ?`
      ),
      /CHECK/
    )
    ok(
      h.repository.settle(
        key,
        'lease-1',
        { state: 'accepted', serverEntityUuid: claimed!.clientEntityUuid },
        now
      )
    )
    // Terminal rows never move again, not even back to dispatching.
    throws(
      run(
        "UPDATE entity_create_outbox SET state = 'dispatching', lease_id = 'l', lease_expires_at = 'x', dispatch_count = 2 WHERE request_key = ?"
      ),
      /illegal|immutable/
    )
    // A settle under a foreign lease changes nothing.
    equal(
      h.repository.settle(
        key,
        'other-lease',
        { state: 'refused', code: 'X', message: null, fields: null, traceId: null },
        now
      ),
      false
    )
    deepEqual(
      h.repository.auditTrail(key).map((step) => `${step.from}>${step.to}`),
      ['null>pending', 'pending>dispatching', 'dispatching>accepted']
    )
    closeDatabase(h.database)
  }
)

databaseTest(
  'a lost response after commit is replayed with the same key and bytes after restart (fault injection)',
  async (sandbox) => {
    const h = harness(sandbox)
    const record = h.service(CASHIER_A).createCustomer({ name: 'Lost answer' })
    const sent: string[] = []
    let t = Date.parse('2026-01-02T10:00:00.000Z')
    const clock = (): Date => new Date(t)

    // First run: the request goes out, the answer never comes back (the process is "killed").
    const first = h.worker(
      CASHIER_A,
      (key, payload) => {
        sent.push(`${key}|${payload}`)
        return new Promise<QuickCreateDispatchResult>(() => undefined)
      },
      undefined,
      clock
    )
    void first.run()
    await new Promise((resolve) => setTimeout(resolve, 20))
    equal(h.repository.find(record.requestKey)?.state, 'dispatching')

    // "Restart": a new connection and a new worker after the lease expired.
    first.shutdown()
    const reopened = harness(sandbox, openTestDatabase(sandbox))
    t += 61_000
    const second = reopened.worker(
      CASHIER_A,
      async (key, payload) => {
        sent.push(`${key}|${payload}`)
        return accepted(record.entityUuid)
      },
      undefined,
      clock
    )
    await second.run()

    const row = reopened.repository.find(record.requestKey)!
    equal(row.state, 'accepted')
    equal(row.dispatchCount, 2)
    equal(sent.length, 2)
    equal(sent[0], sent[1], 'the replay sends exactly the original key and bytes')
    deepEqual(
      reopened.repository.auditTrail(record.requestKey).map((step) => step.to),
      ['pending', 'dispatching', 'unknown', 'dispatching', 'accepted']
    )
    closeDatabase(reopened.database)
    closeDatabase(h.database)
  }
)

databaseTest(
  'blocked_permission survives a restart and replays the same request once the permission is restored',
  async (sandbox) => {
    const h = harness(sandbox)
    const record = h.service(CASHIER_A).createCustomer({ name: 'Needs permission' })
    const sent: string[] = []
    // 1. The server refuses: 403. Preserved, dispatch evidence kept, lease cleared.
    await h
      .worker(CASHIER_A, async (key, payload) => {
        sent.push(`${key}|${payload}`)
        return outcome('blocked_permission', 'PERMISSION_DENIED')
      })
      .run()
    let row = h.repository.find(record.requestKey)!
    equal(row.state, 'blocked_permission')
    equal(row.dispatchCount, 1)
    equal(row.leaseId, null)
    equal(h.service(CASHIER_A).list()[0]?.status, 'blocked')

    // 2. Restart (new connection): reclaim does not touch it, and without the permission it is not sent.
    const reopened = harness(sandbox, openTestDatabase(sandbox))
    await reopened
      .worker(
        CASHIER_A,
        async () => {
          throw new Error('must not be sent while the permission is missing')
        },
        { customer: false }
      )
      .run()
    equal(reopened.repository.find(record.requestKey)?.state, 'blocked_permission')

    // 2b. A stale cache that still says "allowed" (no bootstrap since the refusal) must not loop.
    await reopened
      .worker(CASHIER_A, async () => {
        throw new Error('must not be re-sent before a newer bootstrap')
      })
      .run()
    equal(reopened.repository.find(record.requestKey)?.state, 'blocked_permission')

    // 3. The owner re-grants; a NEWER bootstrap shows it: the SAME request is replayed and accepted.
    reopened.repositories.bootstrapSnapshot.persistSnapshot(
      desktopBootstrapFixture(),
      new Date(Date.now() + 1_000).toISOString(),
      { permissionsOwnerUserUuid: CASHIER_A }
    )
    await reopened
      .worker(CASHIER_A, async (key, payload) => {
        sent.push(`${key}|${payload}`)
        return accepted(record.entityUuid)
      })
      .run()
    row = reopened.repository.find(record.requestKey)!
    equal(row.state, 'accepted')
    equal(row.dispatchCount, 2)
    equal(sent[0], sent[1])
    closeDatabase(reopened.database)
    closeDatabase(h.database)
  }
)

databaseTest(
  'a dependent sale waits for its register-created customer and follows the corrected resubmission',
  async (sandbox) => {
    const h = harness(sandbox)
    const dependencies = h.repositories.uploadDependencies
    const record = h
      .service(CASHIER_A)
      .createCustomer({ name: 'Bad email customer', email: 'bad@example.test' })
    const invoice = seedSale(h, '1', record.entityUuid)
    const frozenBefore = h.database
      .prepare('SELECT * FROM local_invoices WHERE local_uuid = ?')
      .get(invoice)

    deepEqual(dependencies.evaluate(invoice), {
      eligible: false,
      block: 'entity-pending',
      predecessor: null,
      entity: {
        type: 'customer',
        uuid: record.entityUuid,
        requestKey: record.requestKey,
        state: 'pending'
      }
    })

    // The server refuses it durably: the sale stays held (needs correction), never dropped.
    await h
      .worker(CASHIER_A, async () => ({
        ...outcome('refused', 'VALIDATION_ERROR'),
        fields: { email: ['The email is invalid.'] }
      }))
      .run()
    const held = dependencies.evaluate(invoice)
    equal(held.eligible, false)
    equal(!held.eligible && held.block, 'entity-terminal')
    equal(
      dependencies.listHeld({ companyUuid: COMPANY, deviceUuid: DEVICE }, 10)[0]?.invoiceLocalUuid,
      invoice
    )
    // A refused customer is no longer offered for new sales.
    equal(h.repositories.catalog.getCustomer(record.entityUuid), null)

    // Edit and resubmit: a NEW request key for the SAME entity id.
    const fixed = h.service(CASHIER_A).resubmit({
      entityType: 'customer',
      requestKey: record.requestKey,
      fields: { name: 'Bad email customer', email: 'fixed@example.test' }
    })
    ok(fixed.requestKey !== record.requestKey)
    equal(fixed.entityUuid, record.entityUuid)
    equal(h.repository.find(record.requestKey)?.resubmittedAsRequestKey, fixed.requestKey)
    const followed = dependencies.evaluate(invoice)
    equal(!followed.eligible && followed.block, 'entity-pending')
    equal(!followed.eligible && followed.entity?.requestKey, fixed.requestKey)
    throws(() =>
      h.service(CASHIER_A).resubmit({
        entityType: 'customer',
        requestKey: record.requestKey,
        fields: { name: 'Again' }
      })
    )

    // Accepted: the sale becomes eligible; its frozen row is byte-identical.
    await h.worker(CASHIER_A, async () => accepted(record.entityUuid)).run()
    deepEqual(dependencies.evaluate(invoice), { eligible: true })
    deepEqual(
      h.database.prepare('SELECT * FROM local_invoices WHERE local_uuid = ?').get(invoice),
      frozenBefore
    )
    equal(h.repositories.catalog.getCustomer(record.entityUuid)?.pendingSync, undefined)
    closeDatabase(h.database)
  }
)

databaseTest(
  'collisions and conflicts are terminal and preserved; the worker only sends its own user’s requests',
  async (sandbox) => {
    const h = harness(sandbox)
    const sku = h.service(CASHIER_A).createSupplier({ name: 'Taken Name' })
    const mineB = h.service(CASHIER_B).createCustomer({ name: 'Belongs to B' })
    const seen: string[] = []
    await h
      .worker(CASHIER_A, async (key) => {
        seen.push(key)
        return outcome('refused', 'DESKTOP_SUPPLIER_NAME_TAKEN')
      })
      .run()
    deepEqual(seen, [sku.requestKey], 'cashier A never sends cashier B’s request')
    equal(h.repository.find(sku.requestKey)?.state, 'refused')
    equal(h.repository.find(mineB.requestKey)?.state, 'pending')
    equal(
      h
        .service(CASHIER_A)
        .list()
        .find((r) => r.requestKey === mineB.requestKey)?.status,
      'waiting_for_creator'
    )
    equal(
      h
        .service(CASHIER_A)
        .list()
        .find((r) => r.requestKey === mineB.requestKey)?.actions.reassign,
      true
    )
    closeDatabase(h.database)
  }
)

databaseTest(
  'reassignment needs positive proof of never-dispatched, and races a dispatch on two real connections',
  (sandbox) => {
    const a = harness(sandbox)
    const b = harness(sandbox, openTestDatabase(sandbox))
    const owner = (user: string): QuickCreateOwner => ({
      companyUuid: COMPANY,
      deviceUuid: DEVICE,
      userUuid: user
    })
    const now = '2026-01-02T00:00:00.000Z'

    // (a) Claim (dispatch evidence) commits first on connection A: reassignment on B is refused.
    const first = a.service(CASHIER_A).createCustomer({ name: 'Claimed first' })
    ok(a.repository.claimNext(owner(CASHIER_A), now, 'lease-a', '2026-01-02T00:01:00.000Z', []))
    throws(
      () => b.service(CASHIER_B).reassign(first.requestKey),
      (error: { backendCode?: string }) => error.backendCode === 'QUICK_CREATE_NOT_REASSIGNABLE'
    )
    equal(a.repository.find(first.requestKey)?.state, 'dispatching')

    // (b) Reassignment commits first on B: a claim by the original creator on A finds nothing to send.
    const second = a.service(CASHIER_A).createCustomer({ name: 'Reassigned first' })
    const moved = b.service(CASHIER_B).reassign(second.requestKey)
    equal(moved.entityUuid, second.entityUuid)
    equal(a.repository.find(second.requestKey)?.state, 'superseded')
    equal(
      a.repository.claimNext(owner(CASHIER_A), now, 'lease-a2', '2026-01-02T00:01:00.000Z', []),
      null
    )
    throws(() =>
      a.database
        .prepare(
          "UPDATE entity_create_outbox SET state = 'dispatching', lease_id = 'x', lease_expires_at = 'y', dispatch_count = 1, first_dispatched_at = 'z' WHERE request_key = ?"
        )
        .run(second.requestKey)
    )

    // (c) A holds the write lock (BEGIN IMMEDIATE) while it claims; B's reassignment cannot interleave.
    const third = a.service(CASHIER_A).createCustomer({ name: 'Interleaved' })
    b.database.pragma('busy_timeout = 25')
    a.database.exec('BEGIN IMMEDIATE')
    a.database
      .prepare(
        `UPDATE entity_create_outbox SET state = 'dispatching', lease_id = 'lease-c', lease_expires_at = '2026-01-02T00:01:00.000Z',
         dispatch_count = dispatch_count + 1, first_dispatched_at = ?, last_dispatched_at = ?, updated_at = ?
       WHERE request_key = ? AND state = 'pending'`
      )
      .run(now, now, now, third.requestKey)
    throws(() => b.service(CASHIER_B).reassign(third.requestKey), /busy|locked/i)
    a.database.exec('COMMIT')
    throws(
      () => b.service(CASHIER_B).reassign(third.requestKey),
      (error: { backendCode?: string }) => error.backendCode === 'QUICK_CREATE_NOT_REASSIGNABLE'
    )
    equal(a.repository.find(third.requestKey)?.state, 'dispatching')
    equal(
      a.database
        .prepare(
          "SELECT COUNT(*) FROM entity_create_outbox WHERE client_entity_uuid = ? AND state <> 'superseded'"
        )
        .pluck()
        .get(third.entityUuid),
      1
    )
    b.database.pragma('busy_timeout = 5000')
    closeDatabase(b.database)
    closeDatabase(a.database)
  }
)

databaseTest(
  'a product stays a draft until the installed catalog carries its issued revision',
  async (sandbox) => {
    const h = harness(sandbox)
    const resource = desktopBootstrapFixture()
    const category = resource.categories![0]!.id
    const record = h.service(CASHIER_A).createProduct({
      name: 'Quick Juice',
      sku: 'QJ-1',
      barcode: '7770000000001',
      price: '3.5',
      categoryUuid: category,
      taxUuid: null,
      taxMode: 'none'
    })
    equal(record.status, 'pending_sync')
    equal(JSON.parse(h.repository.find(record.requestKey)!.canonicalPayloadJson).price, 350)
    equal(
      h.repositories.catalog.getProduct(record.entityUuid),
      null,
      'a draft is never in the sellable catalog'
    )

    await h.worker(CASHIER_A, async () => accepted(record.entityUuid)).run()
    equal(h.service(CASHIER_A).list()[0]?.status, 'awaiting_catalog')

    // The server-issued revision arrives with a later bootstrap through the normal install path.
    const base = resource.products![0]!
    const validUntil = '2026-01-06T00:00:00+00:00'
    const issued = (product: typeof base, revision: string): typeof base => ({
      ...product,
      resolved_price: product.resolved_price
        ? { ...product.resolved_price, revision, valid_until: validUntil }
        : null
    })
    h.repositories.bootstrapSnapshot.persistSnapshot(
      desktopBootstrapFixture({
        catalog_contract: {
          ...resource.catalog_contract,
          revision: 'b'.repeat(64),
          generated_at: '2026-01-02T00:00:00+00:00',
          valid_until: validUntil
        },
        products: [
          ...resource.products!.map((product) =>
            issued(product, product.resolved_price?.revision ?? 'c'.repeat(64))
          ),
          issued(
            {
              ...base,
              uuid: record.entityUuid,
              name: 'Quick Juice',
              sku: 'QJ-1',
              barcode: '7770000000001'
            },
            'd'.repeat(64)
          )
        ]
      }),
      '2026-01-02T00:00:05+00:00'
    )
    equal(h.service(CASHIER_A).list()[0]?.status, 'ready_to_sell')
    closeDatabase(h.database)
  }
)
