import { deepEqual, equal, ok } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import {
  checkoutCompletionOutcomeSchema,
  type CheckoutIntent
} from '../../../src/shared/contracts/checkout.contract'
import { databaseTest, type DatabaseSandbox } from '../support/sandbox'
import { readCommitted, tableDigest } from '../support/committedState'
import { failingDatabase } from '../support/failingDatabase'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories, type RealRepositories } from '../support/realRepositories'
import {
  branchUuid,
  claimStuckAttempt,
  companyUuid,
  deviceUuid,
  methodUuid,
  productUuid,
  setUpAuthorizedContext,
  shiftUuid,
  trackedProductUuid,
  userUuid,
  validIntent,
  warehouseUuid
} from '../support/localSaleFixture'

function assertRejectedAttemptHasNoBusinessWrites(sandbox: DatabaseSandbox): void {
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

function setProductTaxMode(
  database: ReturnType<typeof openTestDatabase>,
  product: string,
  mode: 'none' | 'inclusive' | 'exclusive',
  rateBasisPoints: number
): void {
  database
    .prepare(
      `UPDATE catalog_products
          SET tax_uuid = ?, tax_mode = ?, tax_rate_basis_points = ?
        WHERE uuid = ?`
    )
    .run(
      mode === 'none' ? null : 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      mode,
      rateBasisPoints,
      product
    )
}

databaseTest(
  'a genuinely new sale commits atomically with one invoice, item, payment, and queue row',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const { localSale } = setUpAuthorizedContext(database, repositories)
    const attemptKey = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

    const outcome = localSale.complete(attemptKey, validIntent())

    ok(outcome.outcome === 'committed')
    checkoutCompletionOutcomeSchema.parse(outcome)
    if (outcome.outcome === 'committed') {
      equal(outcome.items.length, 1)
      equal(outcome.items[0]?.productUuid, productUuid)
      equal(outcome.payments.length, 1)
      equal(outcome.payments[0]?.paymentMethodUuid, methodUuid)
    }
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 1)
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoice_items').length, 1)
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoice_payments').length, 1)
    equal(
      readCommitted(sandbox, "SELECT * FROM sync_queue WHERE aggregate_type = 'invoice'").length,
      1
    )
    equal(
      readCommitted<{ state: string }>(sandbox, 'SELECT state FROM sale_attempts')[0]?.state,
      'committed'
    )
    const epochs = readCommitted<{ claim_session_epoch: number; commit_session_epoch: number }>(
      sandbox,
      `SELECT a.claim_session_epoch, i.commit_session_epoch
         FROM sale_attempts a JOIN local_invoices i ON i.attempt_key = a.attempt_key`
    )[0]
    equal(epochs?.claim_session_epoch, epochs?.commit_session_epoch)
    closeDatabase(database)
  }
)

databaseTest(
  'an open main-owned shift with no workstation assignment reports workstation-unassigned',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const { localSale, authority } = setUpAuthorizedContext(database, repositories)

    // This reproduces a real operational configuration defect: the authoritative shift remains
    // open, but the desktop device is no longer assigned to a branch/warehouse by bootstrap.
    database.prepare('DELETE FROM bootstrap_branch').run()
    database.prepare('DELETE FROM bootstrap_warehouse').run()

    equal(authority.resolveForSell().kind, 'open')
    const outcome = localSale.complete('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', validIntent())

    deepEqual(outcome, {
      outcome: 'failed',
      code: 'workstation-unassigned',
      attemptKey: null
    })
    checkoutCompletionOutcomeSchema.parse(outcome)
    equal(readCommitted(sandbox, 'SELECT * FROM sale_attempts').length, 0)
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 0)
    closeDatabase(database)
  }
)

databaseTest(
  'an exact replay of checkout:complete returns the same committed invoice',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const { localSale } = setUpAuthorizedContext(database, repositories)
    const attemptKey = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const intent = validIntent()

    const first = localSale.complete(attemptKey, intent)
    const second = localSale.complete(attemptKey, intent)

    ok(first.outcome === 'committed' && second.outcome === 'committed')
    if (first.outcome === 'committed' && second.outcome === 'committed') {
      equal(second.replay, true)
      equal(second.invoice.localUuid, first.invoice.localUuid)
    }
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 1)
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoice_items').length, 1)
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoice_payments').length, 1)
    equal(
      readCommitted(sandbox, "SELECT * FROM sync_queue WHERE aggregate_type = 'invoice'").length,
      1
    )
    closeDatabase(database)
  }
)

databaseTest(
  'changed content under the same attempt key is an attempt-conflict, never a silent replay',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const { localSale } = setUpAuthorizedContext(database, repositories)
    const attemptKey = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

    localSale.complete(attemptKey, validIntent())
    const changed = localSale.complete(
      attemptKey,
      validIntent({
        payments: [
          { id: 'payment-1', paymentMethodUuid: methodUuid, amount: 2000, reference: null }
        ]
      })
    )

    deepEqual(changed, { outcome: 'failed', code: 'attempt-conflict', attemptKey })
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 1)
    closeDatabase(database)
  }
)

databaseTest('a claimed attempt blocks a genuinely new key for the same owner', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  const { localSale, authority } = setUpAuthorizedContext(database, repositories)

  const stuckKey = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  claimStuckAttempt(repositories, authority, stuckKey, validIntent())
  equal(
    readCommitted<{ state: string }>(sandbox, 'SELECT state FROM sale_attempts')[0]?.state,
    'claimed'
  )

  const freshKey = 'cccccccc-cccc-4ccc-8ccc-cccccccccccd'
  const blocked = localSale.complete(freshKey, validIntent())

  deepEqual(blocked, {
    outcome: 'failed',
    code: 'attempt-blocked',
    attemptKey: null,
    blockingAttemptKey: stuckKey
  })
  closeDatabase(database)
})

databaseTest(
  'a real fault injected mid-transaction rolls back to zero business rows and records a definite rejection',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const fixture = setUpAuthorizedContext(database, repositories)

    const attemptKey = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    let observedWrites = 0
    // Setup already committed through the real connection above; the injected-failure counter is
    // created fresh here, so it only ever counts writes made during this complete() call.
    const failingLocalSale = fixture.withWriteDatabase(
      failingDatabase(database, {
        failOnWriteNumber: 3,
        onWrite: (count) => (observedWrites = count)
      })
    )

    const outcome = failingLocalSale.complete(attemptKey, validIntent())

    ok(observedWrites >= 3, 'the injected failure boundary must actually have been reached')
    deepEqual(outcome, { outcome: 'rejected', attemptKey, failureCode: 'invariant' })
    checkoutCompletionOutcomeSchema.parse(outcome)
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 0)
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoice_items').length, 0)
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoice_payments').length, 0)
    equal(
      readCommitted(sandbox, "SELECT * FROM sync_queue WHERE aggregate_type = 'invoice'").length,
      0
    )
    const attemptRow = readCommitted<{
      state: string
      intent_json: string | null
      failure_code: string | null
    }>(sandbox, 'SELECT state, intent_json, failure_code FROM sale_attempts')[0]
    equal(attemptRow?.state, 'rejected')
    equal(attemptRow?.intent_json, null)
    equal(attemptRow?.failure_code, 'invariant')
    closeDatabase(database)
  }
)

databaseTest(
  'retry after the shift closes on another terminal returns context-changed, never a silent re-attribution',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const { localSale, authority } = setUpAuthorizedContext(database, repositories)

    const attemptKey = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    claimStuckAttempt(repositories, authority, attemptKey, validIntent())

    const context = authority.captureContext()
    repositories.shiftObservations.write({
      kind: 'shift',
      ...context,
      shiftUuid,
      status: 'closed',
      openedAt: '2026-01-01T00:00:00.000Z',
      observedAt: '2026-01-01T03:00:00.000Z',
      source: 'close'
    })
    // S2 opens on the same terminal after S1 closed — a currently open shift exists, but its
    // identity differs from the one captured at claim time, so this must never be silently
    // re-attributed to S2 (plan §1.8/§2.4: "S1 closed and S2 opened" is `context-changed`, distinct
    // from `shift-unavailable`, which covers no currently open shift at all).
    const secondShiftUuid = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    repositories.shiftObservations.write({
      kind: 'shift',
      ...context,
      shiftUuid: secondShiftUuid,
      status: 'open',
      openedAt: '2026-01-01T03:00:00.000Z',
      observedAt: '2026-01-01T03:00:00.000Z',
      source: 'current'
    })

    const retried = localSale.retry(attemptKey)
    deepEqual(retried, { outcome: 'failed', code: 'context-changed', attemptKey })
    checkoutCompletionOutcomeSchema.parse(retried)
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 0)
    equal(
      readCommitted<{ state: string }>(sandbox, 'SELECT state FROM sale_attempts')[0]?.state,
      'claimed'
    )
    closeDatabase(database)
  }
)

databaseTest(
  'abandon purges intent_json and unblocks the till when no sale committed',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const { localSale, authority } = setUpAuthorizedContext(database, repositories)

    const stuckKey = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    claimStuckAttempt(repositories, authority, stuckKey, validIntent())

    const abandoned = localSale.abandon(stuckKey)
    deepEqual(abandoned, { outcome: 'abandoned', attemptKey: stuckKey })
    checkoutCompletionOutcomeSchema.parse(abandoned)
    equal(
      readCommitted<{ intent_json: string | null }>(
        sandbox,
        'SELECT intent_json FROM sale_attempts'
      )[0]?.intent_json,
      null
    )

    const freshKey = 'cccccccc-cccc-4ccc-8ccc-cccccccccccd'
    const outcome = localSale.complete(freshKey, validIntent())
    ok(outcome.outcome === 'committed')
    closeDatabase(database)
  }
)

databaseTest(
  'acknowledge purges intent_json but never touches the immutable invoice/payment rows',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const { localSale } = setUpAuthorizedContext(database, repositories)
    const attemptKey = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

    localSale.complete(attemptKey, validIntent())
    const before = tableDigest(sandbox, 'local_invoices')
    const acknowledged = localSale.acknowledge(attemptKey)

    ok(acknowledged.outcome === 'acknowledged')
    checkoutCompletionOutcomeSchema.parse(acknowledged)
    if (acknowledged.outcome === 'acknowledged') {
      equal(acknowledged.items.length, 1)
      equal(acknowledged.payments.length, 1)
    }
    equal(tableDigest(sandbox, 'local_invoices'), before)
    equal(
      readCommitted<{ intent_json: string | null }>(
        sandbox,
        'SELECT intent_json FROM sale_attempts'
      )[0]?.intent_json,
      null
    )

    const secondAck = localSale.acknowledge(attemptKey)
    ok(secondAck.outcome === 'acknowledged')
    closeDatabase(database)
  }
)

databaseTest(
  'a tracked line with a sufficient real allocation grant consumes it exactly once',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const { localSale } = setUpAuthorizedContext(database, repositories)

    repositories.stockAllocations.upsertGrant({
      allocationUuid: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      contractVersion: 1,
      companyUuid,
      deviceUuid,
      warehouseUuid,
      productUuid: trackedProductUuid,
      serverSequence: 1,
      lifecycleGeneration: 1,
      grantedQuantityMilli: 3000,
      consumeUntil: '2027-01-01T00:00:00.000Z',
      envelopeHash: 'a'.repeat(64),
      receivedAt: '2026-01-01T00:00:00.000Z'
    })

    const attemptKey = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const outcome = localSale.complete(
      attemptKey,
      validIntent({
        items: [
          {
            id: 'item-1',
            productUuid: trackedProductUuid,
            quantity: '2.000',
            discountType: null,
            discountValue: 0
          }
        ],
        payments: [
          { id: 'payment-1', paymentMethodUuid: methodUuid, amount: 1000, reference: null }
        ]
      })
    )

    ok(outcome.outcome === 'committed')
    equal(readCommitted(sandbox, 'SELECT * FROM local_stock_movements').length, 1)
    equal(
      readCommitted<{ quantity_milli: number }>(
        sandbox,
        'SELECT quantity_milli FROM local_stock_allocation_consumptions'
      )[0]?.quantity_milli,
      2000
    )
    closeDatabase(database)
  }
)

databaseTest(
  'an insufficient allocation for a tracked line rejects and writes nothing',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const { localSale } = setUpAuthorizedContext(database, repositories)

    repositories.stockAllocations.upsertGrant({
      allocationUuid: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      contractVersion: 1,
      companyUuid,
      deviceUuid,
      warehouseUuid,
      productUuid: trackedProductUuid,
      serverSequence: 1,
      lifecycleGeneration: 1,
      grantedQuantityMilli: 500,
      consumeUntil: '2027-01-01T00:00:00.000Z',
      envelopeHash: 'a'.repeat(64),
      receivedAt: '2026-01-01T00:00:00.000Z'
    })

    const attemptKey = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const outcome = localSale.complete(
      attemptKey,
      validIntent({
        items: [
          {
            id: 'item-1',
            productUuid: trackedProductUuid,
            quantity: '2.000',
            discountType: null,
            discountValue: 0
          }
        ],
        payments: [
          { id: 'payment-1', paymentMethodUuid: methodUuid, amount: 1000, reference: null }
        ]
      })
    )

    deepEqual(outcome, {
      outcome: 'rejected',
      attemptKey,
      failureCode: 'stock-allocation-unavailable',
      affectedLineIds: ['item-1']
    })
    checkoutCompletionOutcomeSchema.parse(outcome)
    assertRejectedAttemptHasNoBusinessWrites(sandbox)
    deepEqual(
      readCommitted<{ state: string; failure_code: string }>(
        sandbox,
        'SELECT state, failure_code FROM sale_attempts'
      ),
      [{ state: 'rejected', failure_code: 'stock-allocation-unavailable' }]
    )
    closeDatabase(database)
  }
)

databaseTest(
  'a tracked line with no allocation at all is rejected in every connectivity state (D2-B, no cached fallback)',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const { localSale } = setUpAuthorizedContext(database, repositories)

    const attemptKey = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const outcome = localSale.complete(
      attemptKey,
      validIntent({
        items: [
          {
            id: 'item-1',
            productUuid: trackedProductUuid,
            quantity: '0.500',
            discountType: null,
            discountValue: 0
          },
          {
            id: 'item-2',
            productUuid: trackedProductUuid,
            quantity: '0.500',
            discountType: null,
            discountValue: 0
          }
        ],
        payments: [{ id: 'payment-1', paymentMethodUuid: methodUuid, amount: 500, reference: null }]
      })
    )

    deepEqual(outcome, {
      outcome: 'rejected',
      attemptKey,
      failureCode: 'stock-allocation-unavailable',
      affectedLineIds: ['item-1', 'item-2']
    })
    checkoutCompletionOutcomeSchema.parse(outcome)
    assertRejectedAttemptHasNoBusinessWrites(sandbox)
    closeDatabase(database)
  }
)

/**
 * A globally-claimed row for a *different* owner, inserted directly through the repository —
 * exercises T10 (foreign collision) and T1's opaque `attempt-key-unavailable` guard without
 * needing a second full session/authority setup. Field values beyond the owner tuple are
 * arbitrary: these tests only exercise lookup opacity and the primary-key guard, never a business
 * commit on this row.
 */
function claimForeignAttempt(repositories: RealRepositories, attemptKey: string): void {
  repositories.saleAttempts.claim({
    attemptKey,
    companyUuid,
    deviceUuid,
    userUuid: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    claimSessionEpoch: 1,
    originShiftUuid: 'foreign-shift',
    originShiftObservedAt: '2026-01-01T00:00:00.000Z',
    originBranchUuid: branchUuid,
    originWarehouseUuid: warehouseUuid,
    originContextFingerprint: 'f'.repeat(64),
    intentFingerprint: 'e'.repeat(64),
    intentVersion: 1,
    intentJson: JSON.stringify(validIntent())
  })
}

databaseTest(
  'T4: retry commits the exact retained intent once the till is free again',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const { localSale, authority } = setUpAuthorizedContext(database, repositories)

    const attemptKey = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    claimStuckAttempt(repositories, authority, attemptKey, validIntent())

    const retried = localSale.retry(attemptKey)

    ok(retried.outcome === 'committed')
    if (retried.outcome === 'committed') {
      equal(retried.replay, false)
    }
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 1)
    equal(
      readCommitted<{ state: string }>(sandbox, 'SELECT state FROM sale_attempts')[0]?.state,
      'committed'
    )
    const epochs = readCommitted<{ claim_session_epoch: number; commit_session_epoch: number }>(
      sandbox,
      `SELECT a.claim_session_epoch, i.commit_session_epoch
         FROM sale_attempts a JOIN local_invoices i ON i.attempt_key = a.attempt_key`
    )[0]
    equal(epochs?.claim_session_epoch, epochs?.commit_session_epoch)
    closeDatabase(database)
  }
)

databaseTest(
  'uniform none, inclusive, exclusive, and same-mode multi-line carts persist one proven tax mode',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    try {
      const repositories = realRepositories(database)
      const { localSale } = setUpAuthorizedContext(database, repositories)

      const scenarios = [
        { key: 'c0000000-0000-4000-8000-000000000001', mode: 'none', rate: 0, total: 1000 },
        {
          key: 'c0000000-0000-4000-8000-000000000002',
          mode: 'inclusive',
          rate: 1500,
          total: 1000
        },
        {
          key: 'c0000000-0000-4000-8000-000000000003',
          mode: 'exclusive',
          rate: 1000,
          total: 1100
        }
      ] as const

      for (const scenario of scenarios) {
        setProductTaxMode(database, productUuid, scenario.mode, scenario.rate)
        const outcome = localSale.complete(
          scenario.key,
          validIntent({
            payments: [
              {
                id: 'payment-1',
                paymentMethodUuid: methodUuid,
                amount: scenario.total,
                reference: null
              }
            ]
          })
        )
        ok(outcome.outcome === 'committed')
        if (outcome.outcome === 'committed') {
          equal(outcome.invoice.taxMode, scenario.mode)
          ok(outcome.items.every((item) => item.taxMode === scenario.mode))
        }
      }

      database.prepare('UPDATE catalog_products SET track_stock = 0').run()
      setProductTaxMode(database, trackedProductUuid, 'exclusive', 1000)
      const line = (id: string, product: string): CheckoutIntent['items'][number] => ({
        id,
        productUuid: product,
        quantity: '1.000',
        discountType: null,
        discountValue: 0
      })
      const permutations = [
        [line('line-a', productUuid), line('line-b', trackedProductUuid)],
        [line('line-b', trackedProductUuid), line('line-a', productUuid)]
      ]
      for (const [index, items] of permutations.entries()) {
        const multi = localSale.complete(
          `c0000000-0000-4000-8000-00000000000${index + 4}`,
          validIntent({
            items,
            payments: [
              { id: 'payment-1', paymentMethodUuid: methodUuid, amount: 1650, reference: null }
            ]
          })
        )
        ok(multi.outcome === 'committed')
        if (multi.outcome === 'committed') {
          equal(multi.invoice.taxMode, 'exclusive')
          ok(multi.items.every((item) => item.taxMode === 'exclusive'))
        }
      }
    } finally {
      closeDatabase(database)
    }
  }
)

databaseTest('mixed tax modes reject before writes regardless of line order', (sandbox) => {
  const database = openTestDatabase(sandbox)
  try {
    const repositories = realRepositories(database)
    const { localSale } = setUpAuthorizedContext(database, repositories)
    database.prepare('UPDATE catalog_products SET track_stock = 0').run()
    setProductTaxMode(database, productUuid, 'none', 0)
    setProductTaxMode(database, trackedProductUuid, 'inclusive', 1500)

    const line = (id: string, product: string): CheckoutIntent['items'][number] => ({
      id,
      productUuid: product,
      quantity: '1.000',
      discountType: null,
      discountValue: 0
    })
    const noneInclusive = localSale.complete(
      'd0000000-0000-4000-8000-000000000001',
      validIntent({
        items: [line('none', productUuid), line('inclusive', trackedProductUuid)],
        payments: [
          { id: 'payment-1', paymentMethodUuid: methodUuid, amount: 1500, reference: null }
        ]
      })
    )
    deepEqual(noneInclusive, {
      outcome: 'rejected',
      attemptKey: 'd0000000-0000-4000-8000-000000000001',
      failureCode: 'invalid-request'
    })
    assertRejectedAttemptHasNoBusinessWrites(sandbox)

    setProductTaxMode(database, productUuid, 'inclusive', 1500)
    setProductTaxMode(database, trackedProductUuid, 'exclusive', 1000)
    const inclusiveExclusive = localSale.complete(
      'd0000000-0000-4000-8000-000000000002',
      validIntent({
        items: [line('exclusive', trackedProductUuid), line('inclusive', productUuid)],
        payments: [
          { id: 'payment-1', paymentMethodUuid: methodUuid, amount: 1550, reference: null }
        ]
      })
    )
    deepEqual(inclusiveExclusive, {
      outcome: 'rejected',
      attemptKey: 'd0000000-0000-4000-8000-000000000002',
      failureCode: 'invalid-request'
    })
    assertRejectedAttemptHasNoBusinessWrites(sandbox)
  } finally {
    closeDatabase(database)
  }
})

databaseTest(
  'the post-write invariant rolls back a deliberately corrupted item tax mode',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const fixture = setUpAuthorizedContext(database, repositories)
    let corrupted = false
    const corrupting = fixture.withWriteDatabase(
      failingDatabase(database, {
        afterWrite: (statementSql) => {
          if (!corrupted && statementSql.includes('INSERT INTO local_invoice_items')) {
            corrupted = true
            database.prepare("UPDATE local_invoice_items SET tax_mode = 'inclusive'").run()
          }
        }
      })
    )

    const outcome = corrupting.complete('e0000000-0000-4000-8000-000000000001', validIntent())
    equal(corrupted, true)
    deepEqual(outcome, {
      outcome: 'rejected',
      attemptKey: 'e0000000-0000-4000-8000-000000000001',
      failureCode: 'invariant'
    })
    assertRejectedAttemptHasNoBusinessWrites(sandbox)
    closeDatabase(database)
  }
)

databaseTest(
  'T6: retry on an already-committed attempt replays the exact result, never a selling gate',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const { localSale } = setUpAuthorizedContext(database, repositories)
    const attemptKey = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

    const first = localSale.complete(attemptKey, validIntent())
    ok(first.outcome === 'committed')

    const retried = localSale.retry(attemptKey)
    ok(retried.outcome === 'committed')
    if (retried.outcome === 'committed' && first.outcome === 'committed') {
      equal(retried.replay, true)
      equal(retried.invoice.localUuid, first.invoice.localUuid)
    }
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 1)
    closeDatabase(database)
  }
)

databaseTest('T8: retry on an already-acknowledged attempt replays the exact result', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  const { localSale } = setUpAuthorizedContext(database, repositories)
  const attemptKey = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

  const committed = localSale.complete(attemptKey, validIntent())
  ok(committed.outcome === 'committed')
  localSale.acknowledge(attemptKey)

  const retried = localSale.retry(attemptKey)
  ok(retried.outcome === 'acknowledged')
  if (retried.outcome === 'acknowledged' && committed.outcome === 'committed') {
    equal(retried.replay, true)
    equal(retried.invoice.localUuid, committed.invoice.localUuid)
  }
  closeDatabase(database)
})

databaseTest(
  'T10: retry/acknowledge/abandon on a key never claimed by this owner return not-found, never create a row',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const { localSale } = setUpAuthorizedContext(database, repositories)
    const missingKey = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

    const retried = localSale.retry(missingKey)
    deepEqual(retried, { outcome: 'failed', code: 'not-found', attemptKey: null })
    checkoutCompletionOutcomeSchema.parse(retried)
    deepEqual(localSale.acknowledge(missingKey), {
      outcome: 'failed',
      code: 'not-found',
      attemptKey: null
    })
    deepEqual(localSale.abandon(missingKey), {
      outcome: 'failed',
      code: 'not-found',
      attemptKey: null
    })
    equal(readCommitted(sandbox, 'SELECT * FROM sale_attempts').length, 0)
    closeDatabase(database)
  }
)

databaseTest(
  'T10: a claimed row owned by a different cashier is opaque — never disclosed, never actioned',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const { localSale } = setUpAuthorizedContext(database, repositories)

    const foreignKey = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    claimForeignAttempt(repositories, foreignKey)

    deepEqual(localSale.retry(foreignKey), {
      outcome: 'failed',
      code: 'not-found',
      attemptKey: null
    })
    deepEqual(localSale.acknowledge(foreignKey), {
      outcome: 'failed',
      code: 'not-found',
      attemptKey: null
    })
    deepEqual(localSale.abandon(foreignKey), {
      outcome: 'failed',
      code: 'not-found',
      attemptKey: null
    })
    equal(
      readCommitted<{ state: string }>(sandbox, 'SELECT state FROM sale_attempts')[0]?.state,
      'claimed'
    )
    closeDatabase(database)
  }
)

databaseTest(
  'foreign user/company/device and invalid or revoked sessions cannot commit a retained attempt',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const { localSale, authority, session } = setUpAuthorizedContext(database, repositories)
    const attemptKey = 'abababab-abab-4bab-8bab-abababababab'
    claimStuckAttempt(repositories, authority, attemptKey, validIntent())

    const sessionInput = (
      overrides: Partial<Parameters<typeof session.startSession>[0]> = {}
    ): Parameters<typeof session.startSession>[0] => ({
      userName: 'Cashier',
      userEmail: 'cashier@example.test',
      userUuid,
      userIsActive: true,
      companyUuid,
      deviceUuid,
      serverDeviceId: '22222222-2222-4222-8222-222222222222',
      ...overrides
    })

    session.startSession(sessionInput({ userUuid: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }))
    deepEqual(localSale.retry(attemptKey), {
      outcome: 'failed',
      code: 'not-found',
      attemptKey: null
    })

    session.startSession(sessionInput({ companyUuid: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }))
    deepEqual(localSale.retry(attemptKey), {
      outcome: 'failed',
      code: 'policy-blocked',
      attemptKey: null
    })

    session.startSession(sessionInput({ deviceUuid: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }))
    deepEqual(localSale.retry(attemptKey), {
      outcome: 'failed',
      code: 'policy-blocked',
      attemptKey: null
    })

    session.startSession(sessionInput({ userIsActive: false }))
    deepEqual(localSale.retry(attemptKey), {
      outcome: 'failed',
      code: 'policy-blocked',
      attemptKey: null
    })

    session.startSession(sessionInput())
    const current = authority.captureContext()
    repositories.shiftObservations.write({
      kind: 'shift',
      ...current,
      shiftUuid,
      status: 'open',
      openedAt: '2026-01-01T00:00:00.000Z',
      observedAt: '2026-01-01T01:00:00.000Z',
      source: 'current'
    })
    repositories.deviceRegistration.set({
      serverDeviceId: '22222222-2222-4222-8222-222222222222',
      status: 'revoked',
      lastSeenAt: null,
      updatedAt: '2026-01-01T02:00:00.000Z'
    })
    deepEqual(localSale.retry(attemptKey), {
      outcome: 'failed',
      code: 'context-changed',
      attemptKey
    })

    equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 0)
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoice_items').length, 0)
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoice_payments').length, 0)
    equal(readCommitted(sandbox, 'SELECT * FROM local_stock_movements').length, 0)
    equal(readCommitted(sandbox, 'SELECT * FROM local_stock_allocation_consumptions').length, 0)
    equal(
      readCommitted<{ state: string }>(sandbox, 'SELECT state FROM sale_attempts')[0]?.state,
      'claimed'
    )
    closeDatabase(database)
  }
)

databaseTest(
  'T1: a fresh key already claimed globally by a foreign owner is an opaque attempt-key-unavailable',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const { localSale } = setUpAuthorizedContext(database, repositories)

    const contestedKey = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    claimForeignAttempt(repositories, contestedKey)

    const outcome = localSale.complete(contestedKey, validIntent())
    deepEqual(outcome, {
      outcome: 'failed',
      code: 'attempt-key-unavailable',
      attemptKey: null
    })
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 0)
    closeDatabase(database)
  }
)

databaseTest(
  'abandon-attempt on an already-committed sale is refused as already-committed, never rewritten',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const { localSale } = setUpAuthorizedContext(database, repositories)
    const attemptKey = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

    localSale.complete(attemptKey, validIntent())
    const before = tableDigest(sandbox, 'local_invoices')

    const abandoned = localSale.abandon(attemptKey)
    deepEqual(abandoned, { outcome: 'failed', code: 'already-committed', attemptKey })
    equal(tableDigest(sandbox, 'local_invoices'), before)
    equal(
      readCommitted<{ state: string }>(sandbox, 'SELECT state FROM sale_attempts')[0]?.state,
      'committed'
    )
    closeDatabase(database)
  }
)
