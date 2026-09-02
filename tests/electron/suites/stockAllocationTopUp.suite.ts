import { equal, match, notEqual, ok } from 'node:assert/strict'
import { closeDatabase, type SqliteDatabase } from '../../../src/main/database/connection'
import { checkoutCompletionOutcomeSchema } from '../../../src/shared/contracts/checkout.contract'
import type { CheckoutIntent } from '../../../src/shared/contracts/checkout.contract'
import { databaseTest, type DatabaseSandbox } from '../support/sandbox'
import { readCommitted } from '../support/committedState'
import { failingDatabase } from '../support/failingDatabase'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories } from '../support/realRepositories'
import {
  methodUuid,
  productUuid,
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
 * Every test in this suite closes through here so a failed assertion surfaces as itself rather than
 * as the sandbox's "leaked an open database handle" teardown error, and so the fault-injection test
 * can close early without double-closing.
 */
const closedDatabases = new WeakSet<object>()

function closeDatabaseOnce(database: SqliteDatabase): void {
  if (closedDatabases.has(database)) {
    return
  }

  closedDatabases.add(database)
  closeDatabase(database)
}

const ATTEMPT_KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SECOND_ATTEMPT_KEY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

/** The tracked fixture product is priced at 500 minor units per whole unit, with no tax. */
function trackedIntent(quantity = '1.000', unitCount = 1): CheckoutIntent {
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
    payments: [
      { id: 'payment-1', paymentMethodUuid: methodUuid, amount: 500 * unitCount, reference: null }
    ]
  })
}

/** Two lines of the *same* tracked product — the aggregation case a per-line request would under-request. */
function duplicateLineIntent(): CheckoutIntent {
  return validIntent({
    items: [
      {
        id: 'item-1',
        productUuid: trackedProductUuid,
        quantity: '1.000',
        discountType: null,
        discountValue: 0
      },
      {
        id: 'item-2',
        productUuid: trackedProductUuid,
        quantity: '2.000',
        discountType: null,
        discountValue: 0
      }
    ],
    payments: [{ id: 'payment-1', paymentMethodUuid: methodUuid, amount: 1500, reference: null }]
  })
}

function assertZeroBusinessWrites(sandbox: DatabaseSandbox): void {
  equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 0)
  equal(readCommitted(sandbox, 'SELECT * FROM local_invoice_items').length, 0)
  equal(readCommitted(sandbox, 'SELECT * FROM local_invoice_payments').length, 0)
  equal(readCommitted(sandbox, 'SELECT * FROM local_stock_movements').length, 0)
  equal(readCommitted(sandbox, 'SELECT * FROM local_stock_allocation_consumptions').length, 0)
  equal(
    readCommitted(sandbox, "SELECT * FROM sync_queue WHERE aggregate_type = 'invoice'").length,
    0
  )
}

databaseTest(
  'zero grants and one tracked line request exactly the required quantity, persist it, and commit once',
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
        transport: () => grantedResponse([allocationEnvelope()])
      })

      const outcome = await harness.saleCompletion.complete(ATTEMPT_KEY, trackedIntent())

      checkoutCompletionOutcomeSchema.parse(outcome)
      equal(outcome.outcome, 'committed')
      equal(harness.calls.length, 1)
      equal(harness.calls[0].path, '/stock-allocations/top-up')
      // Exactly the deficit: never the product's 100.000 physical stock, never a buffer.
      equal(
        JSON.stringify(harness.calls[0].body.items),
        '[{"product_uuid":"' + trackedProductUuid + '","quantity":"1.000"}]'
      )

      equal(readCommitted(sandbox, 'SELECT * FROM stock_allocation_grants').length, 1)
      equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 1)
      equal(readCommitted(sandbox, 'SELECT * FROM local_invoice_items').length, 1)
      equal(readCommitted(sandbox, 'SELECT * FROM local_invoice_payments').length, 1)
      equal(readCommitted(sandbox, 'SELECT * FROM local_stock_movements').length, 1)
      equal(readCommitted(sandbox, 'SELECT * FROM local_stock_allocation_consumptions').length, 1)
      equal(
        readCommitted(sandbox, "SELECT * FROM sync_queue WHERE aggregate_type = 'invoice'").length,
        1
      )
      // The incremental grant joins the current snapshot; it never claims a new one.
      equal(
        readCommitted<{ revision: number }>(
          sandbox,
          'SELECT revision FROM bootstrap_allocation_capability'
        )[0]?.revision,
        BOOTSTRAP_ALLOCATION_REVISION
      )
    } finally {
      closeDatabaseOnce(database)
    }
  }
)

databaseTest(
  'a sufficient persisted grant completes offline with no HTTP call at all',
  async (sandbox) => {
    const database = openTestDatabase(sandbox)
    try {
      const repositories = realRepositories(database)
      const { localSale } = setUpAuthorizedContext(database, repositories)
      enableAllocationCapability(repositories, [allocationEnvelope()])

      const harness = buildTopUpHarness({ database, repositories, localSale, online: false })

      const outcome = await harness.saleCompletion.complete(ATTEMPT_KEY, trackedIntent())

      equal(outcome.outcome, 'committed')
      equal(harness.calls.length, 0)
      equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 1)
    } finally {
      closeDatabaseOnce(database)
    }
  }
)

databaseTest('partial local coverage requests only the exact positive deficit', async (sandbox) => {
  const database = openTestDatabase(sandbox)
  try {
    const repositories = realRepositories(database)
    const { localSale } = setUpAuthorizedContext(database, repositories)
    // 1.000 already held locally against a 3.000 cart: the deficit is exactly 2.000.
    enableAllocationCapability(repositories, [allocationEnvelope()])

    const harness = buildTopUpHarness({
      database,
      repositories,
      localSale,
      transport: () =>
        grantedResponse([
          allocationEnvelope({
            id: '70000000-0000-4000-8000-000000000002',
            server_sequence: 2,
            granted_quantity_milli: 2000,
            remaining_quantity_milli: 2000
          })
        ])
    })

    const outcome = await harness.saleCompletion.complete(ATTEMPT_KEY, duplicateLineIntent())

    equal(outcome.outcome, 'committed')
    equal(harness.calls.length, 1)
    equal((harness.calls[0].body.items[0] as { quantity: string }).quantity, '2.000')
    // Two lines of one product aggregate to 3.000 required; a per-line request would have asked for
    // 1.000 twice and silently under-requested.
    equal(readCommitted(sandbox, 'SELECT * FROM local_stock_allocation_consumptions').length, 2)
  } finally {
    closeDatabaseOnce(database)
  }
})

databaseTest('an untracked product never reaches the allocation endpoint', async (sandbox) => {
  const database = openTestDatabase(sandbox)
  try {
    const repositories = realRepositories(database)
    const { localSale } = setUpAuthorizedContext(database, repositories)
    enableAllocationCapability(repositories)

    const harness = buildTopUpHarness({ database, repositories, localSale })

    const outcome = await harness.saleCompletion.complete(ATTEMPT_KEY, validIntent())

    equal(outcome.outcome, 'committed')
    equal(harness.calls.length, 0)
    equal(readCommitted(sandbox, 'SELECT * FROM stock_allocation_grants').length, 0)
    equal(readCommitted(sandbox, 'SELECT * FROM local_stock_allocation_consumptions').length, 0)
    equal(
      readCommitted<{ product_uuid: string }>(
        sandbox,
        'SELECT product_uuid FROM local_invoice_items'
      )[0]?.product_uuid,
      productUuid
    )
  } finally {
    closeDatabaseOnce(database)
  }
})

databaseTest(
  'offline with no grant rejects fail-closed with the affected line and zero business writes',
  async (sandbox) => {
    const database = openTestDatabase(sandbox)
    try {
      const repositories = realRepositories(database)
      const { localSale } = setUpAuthorizedContext(database, repositories)
      enableAllocationCapability(repositories)

      const harness = buildTopUpHarness({ database, repositories, localSale, online: false })

      const outcome = await harness.saleCompletion.complete(ATTEMPT_KEY, trackedIntent())

      checkoutCompletionOutcomeSchema.parse(outcome)
      ok(outcome.outcome === 'rejected')
      if (outcome.outcome === 'rejected') {
        equal(outcome.failureCode, 'stock-allocation-unavailable')
        equal(outcome.affectedLineIds?.[0], 'item-1')
      }
      equal(harness.calls.length, 0)
      equal(readCommitted(sandbox, 'SELECT * FROM stock_allocation_grants').length, 0)
      assertZeroBusinessWrites(sandbox)
    } finally {
      closeDatabaseOnce(database)
    }
  }
)

databaseTest(
  'a definitive backend permission rejection keeps its reason and writes nothing',
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
          throw { category: 'authorization', message: 'Access is not allowed', retryable: false }
        }
      })

      const outcome = await harness.saleCompletion.complete(ATTEMPT_KEY, trackedIntent())

      ok(outcome.outcome === 'failed')
      if (outcome.outcome === 'failed') {
        equal(outcome.code, 'permission-denied')
      }
      equal(readCommitted(sandbox, 'SELECT * FROM stock_allocation_grants').length, 0)
      assertZeroBusinessWrites(sandbox)
    } finally {
      closeDatabaseOnce(database)
    }
  }
)

databaseTest(
  'a missing warehouse assignment reported by the backend stays a workstation problem',
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
            category: 'validation',
            message: 'The request could not be validated',
            retryable: false,
            fieldErrors: { device: ['The current device warehouse assignment is required.'] }
          }
        }
      })

      const outcome = await harness.saleCompletion.complete(ATTEMPT_KEY, trackedIntent())

      ok(outcome.outcome === 'failed')
      if (outcome.outcome === 'failed') {
        equal(outcome.code, 'workstation-unassigned')
      }
      assertZeroBusinessWrites(sandbox)
    } finally {
      closeDatabaseOnce(database)
    }
  }
)

const foreignEnvelopes = [
  ['device', allocationEnvelope({ device_uuid: '99999999-9999-4999-8999-999999999911' })],
  ['warehouse', allocationEnvelope({ warehouse_uuid: '99999999-9999-4999-8999-999999999922' })],
  ['company', allocationEnvelope({ company_uuid: '99999999-9999-4999-8999-999999999933' })],
  ['product', allocationEnvelope({ product_uuid: productUuid })],
  ['contract version', allocationEnvelope({ contract_version: 2 })],
  [
    'quantities',
    allocationEnvelope({ granted_quantity_milli: 1000, remaining_quantity_milli: 900 })
  ]
] as const

for (const [label, envelope] of foreignEnvelopes) {
  databaseTest(`a top-up response with a foreign ${label} authorizes nothing`, async (sandbox) => {
    const database = openTestDatabase(sandbox)
    try {
      const repositories = realRepositories(database)
      const { localSale } = setUpAuthorizedContext(database, repositories)
      enableAllocationCapability(repositories)

      const harness = buildTopUpHarness({
        database,
        repositories,
        localSale,
        transport: () => grantedResponse([envelope])
      })

      const outcome = await harness.saleCompletion.complete(ATTEMPT_KEY, trackedIntent())

      ok(outcome.outcome === 'failed')
      if (outcome.outcome === 'failed') {
        equal(outcome.code, 'allocation-acquisition-unresolved')
      }
      equal(readCommitted(sandbox, 'SELECT * FROM stock_allocation_grants').length, 0)
      assertZeroBusinessWrites(sandbox)
    } finally {
      closeDatabaseOnce(database)
    }
  })
}

databaseTest('an unknown lifecycle status cannot authorize a sale', async (sandbox) => {
  const database = openTestDatabase(sandbox)
  try {
    const repositories = realRepositories(database)
    const { localSale } = setUpAuthorizedContext(database, repositories)
    enableAllocationCapability(repositories)

    const harness = buildTopUpHarness({
      database,
      repositories,
      localSale,
      transport: () =>
        grantedResponse([{ ...allocationEnvelope(), status: 'quarantined' } as never])
    })

    const outcome = await harness.saleCompletion.complete(ATTEMPT_KEY, trackedIntent())

    ok(outcome.outcome === 'failed')
    equal(readCommitted(sandbox, 'SELECT * FROM stock_allocation_grants').length, 0)
    assertZeroBusinessWrites(sandbox)
  } finally {
    closeDatabaseOnce(database)
  }
})

databaseTest(
  'a terminal server status is persisted verbatim and still cannot authorize a sale',
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
        transport: () => grantedResponse([allocationEnvelope({ status: 'revocation_pending' })])
      })

      const outcome = await harness.saleCompletion.complete(ATTEMPT_KEY, trackedIntent())

      ok(outcome.outcome === 'rejected')
      if (outcome.outcome === 'rejected') {
        equal(outcome.failureCode, 'stock-allocation-unavailable')
      }
      // Preserved exactly — never normalized back to `active` to make the sale work.
      equal(
        readCommitted<{ server_status: string }>(
          sandbox,
          'SELECT server_status FROM stock_allocation_grants'
        )[0]?.server_status,
        'revocation_pending'
      )
      assertZeroBusinessWrites(sandbox)
    } finally {
      closeDatabaseOnce(database)
    }
  }
)

databaseTest('an insufficient granted quantity cannot authorize the sale', async (sandbox) => {
  const database = openTestDatabase(sandbox)
  try {
    const repositories = realRepositories(database)
    const { localSale } = setUpAuthorizedContext(database, repositories)
    enableAllocationCapability(repositories)

    const harness = buildTopUpHarness({
      database,
      repositories,
      localSale,
      // Laravel grants `min(demand, unreserved)`, so a partial grant is a real, valid response.
      transport: () =>
        grantedResponse([
          allocationEnvelope({ granted_quantity_milli: 500, remaining_quantity_milli: 500 })
        ])
    })

    const outcome = await harness.saleCompletion.complete(ATTEMPT_KEY, trackedIntent())

    ok(outcome.outcome === 'rejected')
    if (outcome.outcome === 'rejected') {
      equal(outcome.failureCode, 'stock-allocation-unavailable')
    }
    equal(readCommitted(sandbox, 'SELECT * FROM stock_allocation_grants').length, 1)
    assertZeroBusinessWrites(sandbox)
  } finally {
    closeDatabaseOnce(database)
  }
})

databaseTest('a stale allocation revision cannot authorize a sale', async (sandbox) => {
  const database = openTestDatabase(sandbox)
  try {
    const repositories = realRepositories(database)
    const { localSale } = setUpAuthorizedContext(database, repositories)
    enableAllocationCapability(repositories)

    const harness = buildTopUpHarness({
      database,
      repositories,
      localSale,
      transport: () => grantedResponse([allocationEnvelope()], BOOTSTRAP_ALLOCATION_REVISION - 1)
    })

    const outcome = await harness.saleCompletion.complete(ATTEMPT_KEY, trackedIntent())

    ok(outcome.outcome === 'failed')
    if (outcome.outcome === 'failed') {
      equal(outcome.code, 'allocation-acquisition-unresolved')
    }
    equal(readCommitted(sandbox, 'SELECT * FROM stock_allocation_grants').length, 0)
    assertZeroBusinessWrites(sandbox)
  } finally {
    closeDatabaseOnce(database)
  }
})

databaseTest('a malformed top-up response cannot authorize a sale', async (sandbox) => {
  const database = openTestDatabase(sandbox)
  try {
    const repositories = realRepositories(database)
    const { localSale } = setUpAuthorizedContext(database, repositories)
    enableAllocationCapability(repositories)

    const harness = buildTopUpHarness({
      database,
      repositories,
      localSale,
      transport: () => ({ data: { allocations: 'yes' }, meta: {} })
    })

    const outcome = await harness.saleCompletion.complete(ATTEMPT_KEY, trackedIntent())

    ok(outcome.outcome === 'failed')
    if (outcome.outcome === 'failed') {
      equal(outcome.code, 'allocation-acquisition-unresolved')
    }
    equal(readCommitted(sandbox, 'SELECT * FROM stock_allocation_grants').length, 0)
    assertZeroBusinessWrites(sandbox)
  } finally {
    closeDatabaseOnce(database)
  }
})

databaseTest(
  'a grant that cannot be persisted atomically cannot authorize a sale',
  async (sandbox) => {
    const database = openTestDatabase(sandbox)
    try {
      const repositories = realRepositories(database)
      const fixture = setUpAuthorizedContext(database, repositories)
      enableAllocationCapability(repositories)

      // Setup committed through the real connection above; only the grant insert made during this
      // completion fails, and `transaction()` stays bound to the actual SQLite connection.
      const writeDatabase = failingDatabase(database, {
        failWhen: (statementSql) => statementSql.includes('INSERT INTO stock_allocation_grants')
      })
      const harness = buildTopUpHarness({
        database: writeDatabase,
        repositories: realRepositories(writeDatabase),
        localSale: fixture.withWriteDatabase(writeDatabase),
        transport: () => grantedResponse([allocationEnvelope()])
      })

      const outcome = await harness.saleCompletion.complete(ATTEMPT_KEY, trackedIntent())

      ok(outcome.outcome === 'failed')
      if (outcome.outcome === 'failed') {
        equal(outcome.code, 'allocation-acquisition-unresolved')
      }
      closeDatabaseOnce(database)

      equal(readCommitted(sandbox, 'SELECT * FROM stock_allocation_grants').length, 0)
      assertZeroBusinessWrites(sandbox)
    } finally {
      closeDatabaseOnce(database)
    }
  }
)

databaseTest(
  'a lost response replays under the identical idempotency key and then commits',
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
        transport: (_call, attempt) => {
          // Attempt 1: Laravel accepted and reserved the stock, but the answer never arrived.
          if (attempt === 1) {
            throw {
              category: 'transport',
              message: 'The desktop service is temporarily unavailable',
              retryable: true
            }
          }
          // Attempt 2: the same key replays and returns the originally stored grant.
          return grantedResponse([allocationEnvelope()])
        }
      })

      const first = await harness.saleCompletion.complete(ATTEMPT_KEY, trackedIntent())
      ok(first.outcome === 'failed')
      if (first.outcome === 'failed') {
        equal(first.code, 'allocation-acquisition-unresolved')
      }
      // The attempt stays claimed and retryable — never rejected into a fresh key.
      equal(
        readCommitted<{ state: string }>(sandbox, 'SELECT state FROM sale_attempts')[0]?.state,
        'claimed'
      )
      assertZeroBusinessWrites(sandbox)

      const second = await harness.saleCompletion.complete(ATTEMPT_KEY, trackedIntent())

      equal(second.outcome, 'committed')
      equal(harness.calls.length, 2)
      equal(harness.calls[0].body.idempotency_key, harness.calls[1].body.idempotency_key)
      match(harness.calls[0].body.idempotency_key, /^[a-f0-9]{64}$/)
      equal(readCommitted(sandbox, 'SELECT * FROM stock_allocation_grants').length, 1)
      equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 1)
    } finally {
      closeDatabaseOnce(database)
    }
  }
)

databaseTest(
  'a crash after the grant but before local persistence recovers without a duplicate grant',
  async (sandbox) => {
    const database = openTestDatabase(sandbox)
    try {
      const repositories = realRepositories(database)
      const { localSale } = setUpAuthorizedContext(database, repositories)
      enableAllocationCapability(repositories)

      // The durable claim already exists; the process died between Laravel's grant and the SQLite
      // write, so `stock_allocation_grants` is empty and the derived key must reproduce exactly.
      const first = buildTopUpHarness({
        database,
        repositories,
        localSale,
        transport: () => {
          throw { category: 'transport', message: 'lost', retryable: true }
        }
      })
      await first.saleCompletion.complete(ATTEMPT_KEY, trackedIntent())
      equal(readCommitted(sandbox, 'SELECT * FROM stock_allocation_grants').length, 0)

      // A fresh service graph, as after a relaunch: the key is recomputed, not remembered.
      const recovered = buildTopUpHarness({
        database,
        repositories,
        localSale,
        transport: () => grantedResponse([allocationEnvelope()])
      })
      const outcome = await recovered.saleCompletion.retry(ATTEMPT_KEY)

      equal(outcome.outcome, 'committed')
      equal(first.calls[0].body.idempotency_key, recovered.calls[0].body.idempotency_key)
      equal(readCommitted(sandbox, 'SELECT * FROM stock_allocation_grants').length, 1)
      equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 1)
    } finally {
      closeDatabaseOnce(database)
    }
  }
)

databaseTest(
  'a crash after persistence but before commit reuses the persisted grant and requests nothing',
  async (sandbox) => {
    const database = openTestDatabase(sandbox)
    try {
      const repositories = realRepositories(database)
      const { localSale } = setUpAuthorizedContext(database, repositories)
      enableAllocationCapability(repositories)

      // Persist through the same production ingestion path the acquisition uses, then relaunch.
      database.transaction(() =>
        repositories.stockAllocations.ingestTopUpGrants(
          [
            {
              allocationUuid: allocationEnvelope().id,
              contractVersion: 1,
              companyUuid: allocationEnvelope().company_uuid,
              deviceUuid: allocationEnvelope().device_uuid,
              warehouseUuid: allocationEnvelope().warehouse_uuid,
              productUuid: trackedProductUuid,
              serverSequence: 1,
              rightsGeneration: 1,
              lifecycleGeneration: 1,
              grantedQuantityMilli: 1000,
              consumedQuantityMilli: 0,
              remainingQuantityMilli: 1000,
              consumeUntil: '2026-01-03T00:00:00+00:00',
              status: 'active',
              envelopeHash: 'd'.repeat(64),
              sealNonce: null,
              finalConsumptionSequence: null,
              finalConsumptionHash: null,
              receivedAt: '2026-01-01T02:00:00.000Z',
              sealedAt: null,
              acknowledgedAt: null,
              releasedAt: null
            }
          ],
          '2026-01-01T02:00:00.000Z'
        )
      )()

      const harness = buildTopUpHarness({ database, repositories, localSale })
      const outcome = await harness.saleCompletion.complete(ATTEMPT_KEY, trackedIntent())

      equal(outcome.outcome, 'committed')
      equal(harness.calls.length, 0)
      equal(readCommitted(sandbox, 'SELECT * FROM stock_allocation_grants').length, 1)
      equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 1)
    } finally {
      closeDatabaseOnce(database)
    }
  }
)

databaseTest(
  'a replayed identical grant is reconciled idempotently rather than duplicated',
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
        transport: () =>
          grantedResponse([
            allocationEnvelope({ granted_quantity_milli: 3000, remaining_quantity_milli: 3000 })
          ])
      })

      // Two independent sale attempts for the same tracked product. The second still holds usable
      // remainder from the first grant, so it must not request or duplicate anything.
      equal(
        (await harness.saleCompletion.complete(ATTEMPT_KEY, trackedIntent())).outcome,
        'committed'
      )
      equal(
        (await harness.saleCompletion.complete(SECOND_ATTEMPT_KEY, trackedIntent())).outcome,
        'committed'
      )

      equal(harness.calls.length, 1)
      equal(readCommitted(sandbox, 'SELECT * FROM stock_allocation_grants').length, 1)
      equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 2)
      equal(readCommitted(sandbox, 'SELECT * FROM local_stock_allocation_consumptions').length, 2)
    } finally {
      closeDatabaseOnce(database)
    }
  }
)

databaseTest(
  'two concurrent completions of one intent create one top-up, one attempt, and one invoice',
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
        transport: () => grantedResponse([allocationEnvelope()])
      })

      const [first, second] = await Promise.all([
        harness.saleCompletion.complete(ATTEMPT_KEY, trackedIntent()),
        harness.saleCompletion.complete(ATTEMPT_KEY, trackedIntent())
      ])

      // One is the fresh commit, the other an exact replay of the same immutable result.
      ok(first.outcome === 'committed' || second.outcome === 'committed')
      equal(readCommitted(sandbox, 'SELECT * FROM sale_attempts').length, 1)
      equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 1)
      equal(
        readCommitted(sandbox, "SELECT * FROM sync_queue WHERE aggregate_type = 'invoice'").length,
        1
      )
      equal(readCommitted(sandbox, 'SELECT * FROM stock_allocation_grants').length, 1)
      equal(harness.calls.length, 1)
    } finally {
      closeDatabaseOnce(database)
    }
  }
)

databaseTest(
  'a successful top-up followed by a local business rejection commits nothing and releases nothing',
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
        transport: () => grantedResponse([allocationEnvelope()])
      })

      // The tender is short of the total: a definite content rejection *after* the grant is in hand.
      const outcome = await harness.saleCompletion.complete(
        ATTEMPT_KEY,
        validIntent({
          items: [
            {
              id: 'item-1',
              productUuid: trackedProductUuid,
              quantity: '1.000',
              discountType: null,
              discountValue: 0
            }
          ],
          payments: [
            { id: 'payment-1', paymentMethodUuid: methodUuid, amount: 100, reference: null }
          ]
        })
      )

      ok(outcome.outcome === 'rejected')
      if (outcome.outcome === 'rejected') {
        equal(outcome.failureCode, 'invalid-request')
      }
      // The reservation stays held under its existing lifecycle — there is no automatic release.
      const grants = readCommitted<{ server_status: string; granted_quantity_milli: number }>(
        sandbox,
        'SELECT server_status, granted_quantity_milli FROM stock_allocation_grants'
      )
      equal(grants.length, 1)
      equal(grants[0]?.server_status, 'active')
      equal(grants[0]?.granted_quantity_milli, 1000)
      assertZeroBusinessWrites(sandbox)
    } finally {
      closeDatabaseOnce(database)
    }
  }
)

databaseTest('allocation diagnostics report the real persisted grant state', async (sandbox) => {
  const database = openTestDatabase(sandbox)
  try {
    const repositories = realRepositories(database)
    setUpAuthorizedContext(database, repositories)

    // A capable backend that has issued nothing yet: present, with zero grants of any kind. That is
    // deliberately distinguishable from a backend predating the contract, which is reported absent.
    const empty = repositories.stockAllocations.diagnostics('2026-01-01T02:00:00.000Z')
    equal(empty.present, true)
    equal(empty.total, 0)
    equal(empty.usable, 0)

    repositories.stockAllocations.markCapabilityUnavailable('2026-01-01T02:00:00.000Z')
    const absent = repositories.stockAllocations.diagnostics('2026-01-01T02:00:00.000Z')
    equal(absent.present, false)
    equal(absent.usable, 0)

    enableAllocationCapability(repositories, [
      allocationEnvelope(),
      allocationEnvelope({
        id: '70000000-0000-4000-8000-000000000002',
        server_sequence: 2,
        status: 'released'
      })
    ])

    const present = repositories.stockAllocations.diagnostics('2026-01-01T02:00:00.000Z')
    equal(present.present, true)
    equal(present.revision, BOOTSTRAP_ALLOCATION_REVISION)
    equal(present.total, 2)
    // The released grant is retained as evidence but is not usable authority.
    equal(present.usable, 1)
    notEqual(present.total, present.usable)
  } finally {
    closeDatabaseOnce(database)
  }
})
