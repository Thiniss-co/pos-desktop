import { deepEqual, equal, ok, throws } from 'node:assert/strict'
import { closeDatabase, type SqliteDatabase } from '../../../src/main/database/connection'
import { databaseMigrations } from '../../../src/main/database/migrations'
import type { CheckoutIntent } from '../../../src/shared/contracts/checkout.contract'
import { AllocationDispatchReconciler } from '../../../src/main/services/allocationDispatchReconciler.service'
import { databaseTest } from '../support/sandbox'
import { readCommitted } from '../support/committedState'
import {
  openExistingTestDatabase,
  openTestDatabase,
  runTestMigrations
} from '../support/openTestDatabase'
import { realRepositories } from '../support/realRepositories'
import {
  claimStuckAttempt,
  companyUuid,
  deviceUuid,
  methodUuid,
  setUpAuthorizedContext,
  trackedProductUuid,
  validIntent
} from '../support/localSaleFixture'
import {
  allocationEnvelope,
  buildTopUpHarness,
  enableAllocationCapability,
  grantedResponse,
  BOOTSTRAP_ALLOCATION_REVISION
} from '../support/allocationTopUp'

/**
 * POS reliability rev 3 / 3.1 — the durable allocation-dispatch lifecycle on real SQLite:
 * request identities recorded before HTTP, re-sent byte for byte across restarts, owned by the
 * reconciler after the sale attempt ends, terminal integrity states retained and never re-sent,
 * and the explicit, append-only legacy uncertainty rule.
 */

const ATTEMPT_KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_COMPANY = '99999999-9999-4999-8999-999999999991'

function trackedIntent(quantity = '1.000'): CheckoutIntent {
  return validIntent({
    items: [
      {
        id: 'item-1',
        productUuid: trackedProductUuid,
        quantity,
        discountType: null,
        discountValue: 0
      }
    ],
    payments: [{ id: 'payment-1', paymentMethodUuid: methodUuid, amount: 500, reference: null }]
  })
}

function transportLoss(): never {
  throw {
    category: 'transport',
    message: 'The desktop service is temporarily unavailable',
    retryable: true
  }
}

function dispatchRows(sandbox: Parameters<typeof readCommitted>[0]): Array<{
  idempotency_key: string
  state: string
  send_count: number
  ambiguous_send_count: number
  request_body_json: string
}> {
  return readCommitted(sandbox, 'SELECT * FROM attempt_allocation_dispatches ORDER BY created_at')
}

function reconcilerFor(
  database: SqliteDatabase,
  acquisition: ReturnType<typeof buildTopUpHarness>['acquisition'],
  owner = { companyUuid, deviceUuid }
): AllocationDispatchReconciler {
  return new AllocationDispatchReconciler({
    dispatches: realRepositories(database).allocationDispatches,
    acquisition,
    connectivity: {
      getSnapshot: () => ({
        status: 'online',
        networkAvailable: true,
        backendReachable: true,
        checkedAt: '2026-01-01T02:00:00Z',
        lastBackendReachableAt: '2026-01-01T02:00:00Z',
        reason: 'probe_succeeded'
      })
    },
    apiClient: { assertRequestPreconditions: () => undefined },
    owner: () => owner,
    allocationCapabilitySupported: () => true,
    schedule: () => ({ clear: () => undefined }),
    log: () => undefined
  })
}

databaseTest(
  'a recorded request survives a restart and is re-sent byte for byte under its original key',
  async (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const { localSale } = setUpAuthorizedContext(database, repositories)
    enableAllocationCapability(repositories)
    const lost = buildTopUpHarness({ database, repositories, localSale, transport: transportLoss })

    const first = await lost.saleCompletion.complete(ATTEMPT_KEY, trackedIntent())
    equal(first.outcome, 'failed')
    const [recorded] = dispatchRows(sandbox)
    equal(recorded.state, 'dispatched')
    equal(recorded.send_count, 1)
    equal(recorded.ambiguous_send_count, 1)
    closeDatabase(database)

    const reopened = openExistingTestDatabase(sandbox)
    const reopenedRepositories = realRepositories(reopened)
    const restarted = setUpAuthorizedContext(
      reopened,
      reopenedRepositories,
      undefined,
      'online',
      false
    )
    const answered = buildTopUpHarness({
      database: reopened,
      repositories: reopenedRepositories,
      localSale: restarted.localSale,
      transport: () => grantedResponse([allocationEnvelope()])
    })

    const retried = await answered.saleCompletion.retry(ATTEMPT_KEY)

    equal(retried.outcome, 'committed')
    equal(answered.calls.length, 1)
    deepEqual(answered.calls[0].body, JSON.parse(recorded.request_body_json))
    equal(dispatchRows(sandbox)[0].state, 'granted')
    equal(dispatchRows(sandbox).length, 1)
    equal(readCommitted(sandbox, 'SELECT * FROM stock_allocation_grants').length, 1)
    closeDatabase(reopened)
  }
)

databaseTest(
  'an attempt that ends offline hands its outstanding request to the reconciler, which resolves it exactly once and never touches invoices',
  async (sandbox) => {
    const database = openTestDatabase(sandbox)
    try {
      const repositories = realRepositories(database)
      const { localSale } = setUpAuthorizedContext(database, repositories)
      enableAllocationCapability(repositories)

      const lost = buildTopUpHarness({
        database,
        repositories,
        localSale,
        transport: transportLoss
      })
      await lost.saleCompletion.complete(ATTEMPT_KEY, trackedIntent())

      const offline = buildTopUpHarness({ database, repositories, localSale, online: false })
      const offlineRetry = await offline.saleCompletion.retry(ATTEMPT_KEY)
      // Allocation mode with no usable grant: the existing terminal refusal. The request is not.
      equal(offlineRetry.outcome, 'rejected')
      equal(offline.calls.length, 0)
      equal(dispatchRows(sandbox)[0].state, 'dispatched')

      const online = buildTopUpHarness({
        database,
        repositories,
        localSale,
        transport: () => grantedResponse([allocationEnvelope()])
      })
      const reconciler = reconcilerFor(database, online.acquisition)
      reconciler.requestRun()
      await reconciler.whenIdle()
      reconciler.requestRun()
      await reconciler.whenIdle()

      equal(online.calls.length, 1)
      equal(dispatchRows(sandbox)[0].state, 'granted')
      equal(readCommitted(sandbox, 'SELECT * FROM stock_allocation_grants').length, 1)
      equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 0)
      equal(
        readCommitted(sandbox, "SELECT * FROM sync_queue WHERE aggregate_type = 'invoice'").length,
        0
      )
      equal(
        readCommitted<{ state: string }>(sandbox, 'SELECT state FROM sale_attempts')[0]?.state,
        'rejected'
      )
    } finally {
      closeDatabase(database)
    }
  }
)

databaseTest(
  'a post-lookup demand refusal keeps the attempt recoverable and the same key succeeds later',
  async (sandbox) => {
    const database = openTestDatabase(sandbox)
    try {
      const repositories = realRepositories(database)
      const { localSale } = setUpAuthorizedContext(database, repositories)
      enableAllocationCapability(repositories)
      let refuse = true
      const harness = buildTopUpHarness({
        database,
        repositories,
        localSale,
        transport: () => {
          if (refuse) {
            throw {
              category: 'rejected',
              backendCode: 'STOCK_ALLOCATION_DEMAND_REFUSED',
              message: 'Every allocation demand must reference a tracked company product.',
              retryable: false
            }
          }
          return grantedResponse([allocationEnvelope()])
        }
      })

      const refused = await harness.saleCompletion.complete(ATTEMPT_KEY, trackedIntent())
      equal(refused.outcome, 'failed')
      equal((refused as { code: string }).code, 'allocation-refused')
      equal(dispatchRows(sandbox)[0].state, 'refused')
      equal(
        readCommitted<{ state: string }>(sandbox, 'SELECT state FROM sale_attempts')[0]?.state,
        'claimed'
      )

      refuse = false
      const retried = await harness.saleCompletion.retry(ATTEMPT_KEY)

      equal(retried.outcome, 'committed')
      equal(harness.calls.length, 2)
      equal(harness.calls[0].body.idempotency_key, harness.calls[1].body.idempotency_key)
      equal(dispatchRows(sandbox).length, 1)
      equal(dispatchRows(sandbox)[0].state, 'granted')
    } finally {
      closeDatabase(database)
    }
  }
)

databaseTest(
  'an identity conflict is integrity-blocked, never re-sent, cancellable, and its evidence is immutable',
  async (sandbox) => {
    const database = openTestDatabase(sandbox)
    try {
      const repositories = realRepositories(database)
      const { localSale } = setUpAuthorizedContext(database, repositories)
      enableAllocationCapability(repositories)
      const harness = buildTopUpHarness({
        database,
        repositories,
        localSale,
        transport: () => {
          throw {
            category: 'conflict',
            backendCode: 'IDEMPOTENCY_CONFLICT',
            message: 'conflict',
            retryable: false,
            traceId: 'trace-conflict-1'
          }
        }
      })

      const first = await harness.saleCompletion.complete(ATTEMPT_KEY, trackedIntent())
      equal((first as { code: string }).code, 'allocation-integrity-blocked')
      const retried = await harness.saleCompletion.retry(ATTEMPT_KEY)
      equal((retried as { code: string }).code, 'allocation-integrity-blocked')
      equal(harness.calls.length, 1)

      const blocking = localSale.pendingAttempts().blockingAttempt
      ok(blocking)
      deepEqual(localSale.recoverySummary(blocking), {
        legacyDispatchUnknown: false,
        outstandingRequests: 0,
        needsSupport: true,
        supportReference: 'trace-conflict-1'
      })

      equal(localSale.abandon(ATTEMPT_KEY).outcome, 'abandoned')
      equal(dispatchRows(sandbox)[0].state, 'conflict')
      throws(() =>
        database.prepare("UPDATE attempt_allocation_dispatches SET request_body_json = '{}'").run()
      )
      throws(() =>
        database.prepare("UPDATE attempt_allocation_dispatches SET state = 'dispatched'").run()
      )
      throws(() => database.prepare('DELETE FROM attempt_allocation_dispatches').run())
    } finally {
      closeDatabase(database)
    }
  }
)

databaseTest(
  'a legacy attempt needs an explicit acknowledgement to cancel; the uncertainty stays open, append-only, and a delayed old grant is ingested once',
  async (sandbox) => {
    const database = openTestDatabase(sandbox)
    try {
      const repositories = realRepositories(database)
      const { localSale, authority } = setUpAuthorizedContext(database, repositories)
      enableAllocationCapability(repositories)
      const intent = trackedIntent()
      claimStuckAttempt(repositories, authority, ATTEMPT_KEY, intent)
      // Exactly what migration 0016 does to an attempt claimed by an earlier build.
      database
        .prepare("UPDATE sale_attempts SET dispatch_evidence = 'unknown' WHERE attempt_key = ?")
        .run(ATTEMPT_KEY)
      const intentJson = readCommitted<{ intent_json: string }>(
        sandbox,
        'SELECT intent_json FROM sale_attempts'
      )[0].intent_json

      const refused = localSale.abandon(ATTEMPT_KEY)
      equal((refused as { code: string }).code, 'legacy-uncertainty-acknowledgement-required')
      equal(
        readCommitted<{ state: string }>(sandbox, 'SELECT state FROM sale_attempts')[0]?.state,
        'claimed'
      )

      equal(
        localSale.abandon(ATTEMPT_KEY, { acknowledgeLegacyUncertainty: true }).outcome,
        'abandoned'
      )
      const [uncertainty] = readCommitted<{ status: string; intent_json: string }>(
        sandbox,
        'SELECT status, intent_json FROM legacy_dispatch_uncertainties'
      )
      equal(uncertainty.status, 'open')
      equal(uncertainty.intent_json, intentJson)

      // A request from the earlier build commits on the server only AFTER this bootstrap, and the
      // next snapshot delivers its grant: ingested once, handled only by the grant lifecycle.
      const late = allocationEnvelope({
        id: '70000000-0000-4000-8000-0000000000aa',
        server_sequence: 2
      })
      enableAllocationCapability(repositories, [late], BOOTSTRAP_ALLOCATION_REVISION + 1)
      enableAllocationCapability(repositories, [late], BOOTSTRAP_ALLOCATION_REVISION + 1)
      equal(readCommitted(sandbox, 'SELECT * FROM stock_allocation_grants').length, 1)
      equal(
        readCommitted<{ status: string }>(
          sandbox,
          'SELECT status FROM legacy_dispatch_uncertainties'
        )[0].status,
        'open'
      )
      equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 0)
      throws(() =>
        database.prepare("UPDATE legacy_dispatch_uncertainties SET status = 'open'").run()
      )
      throws(() => database.prepare('DELETE FROM legacy_dispatch_uncertainties').run())
    } finally {
      closeDatabase(database)
    }
  }
)

databaseTest('the reconciler never sends a request owned by another company', async (sandbox) => {
  const database = openTestDatabase(sandbox)
  try {
    const repositories = realRepositories(database)
    const { localSale } = setUpAuthorizedContext(database, repositories)
    enableAllocationCapability(repositories)
    database
      .prepare(
        `INSERT INTO attempt_allocation_dispatches (
           idempotency_key, attempt_key, company_uuid, device_uuid, warehouse_uuid, actor_user_uuid,
           request_hash, request_body_json, state, created_at
         ) VALUES (?, 'foreign-attempt', ?, ?, 'w', 'u', ?, ?, 'dispatched', '2026-01-01T00:00:00Z')`
      )
      .run(
        'f'.repeat(64),
        OTHER_COMPANY,
        deviceUuid,
        'e'.repeat(64),
        JSON.stringify({
          idempotency_key: 'f'.repeat(64),
          allocation_payload_version: 2,
          items: []
        })
      )
    const harness = buildTopUpHarness({
      database,
      repositories,
      localSale,
      transport: () => grantedResponse([allocationEnvelope()])
    })
    const reconciler = reconcilerFor(database, harness.acquisition)

    reconciler.requestRun()
    await reconciler.whenIdle()

    equal(harness.calls.length, 0)
    equal(dispatchRows(sandbox)[0].state, 'dispatched')
  } finally {
    closeDatabase(database)
  }
})

databaseTest(
  'migration 0016 marks attempts that were claimed before it as having unknown dispatch history',
  (sandbox) => {
    const before = openExistingTestDatabase(sandbox)
    runTestMigrations(
      before,
      databaseMigrations.filter((migration) => migration.version < 16)
    )
    const repositories = realRepositories(before)
    const { authority } = setUpAuthorizedContext(before, repositories)
    claimStuckAttempt(repositories, authority, ATTEMPT_KEY, trackedIntent())
    closeDatabase(before)

    const after = openExistingTestDatabase(sandbox)
    runTestMigrations(after, databaseMigrations)
    equal(
      (
        after
          .prepare('SELECT dispatch_evidence FROM sale_attempts WHERE attempt_key = ?')
          .get(ATTEMPT_KEY) as { dispatch_evidence: string }
      ).dispatch_evidence,
      'unknown'
    )
    closeDatabase(after)
  }
)
