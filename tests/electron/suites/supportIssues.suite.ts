import { deepEqual, equal, ok } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import type { CheckoutIntent } from '../../../src/shared/contracts/checkout.contract'
import type { SaleAttemptRow } from '../../../src/shared/contracts/sale.contract'
import { syncSupportIssuesSchema } from '../../../src/shared/contracts/sync.contract'
import type { LocalSaleService } from '../../../src/main/services/localSale.service'
import {
  SupportIssuesService,
  supportReference
} from '../../../src/main/services/supportIssues.service'
import { databaseTest } from '../support/sandbox'
import { readCommitted } from '../support/committedState'
import { openExistingTestDatabase, openTestDatabase } from '../support/openTestDatabase'
import { realRepositories, type RealRepositories } from '../support/realRepositories'
import {
  claimStuckAttempt,
  companyUuid,
  deviceUuid,
  methodUuid,
  setUpAuthorizedContext,
  trackedProductUuid,
  userUuid,
  validIntent,
  warehouseUuid
} from '../support/localSaleFixture'
import { enableAllocationCapability } from '../support/allocationTopUp'

/**
 * POS reliability — the Sync page's "needs attention" projection on real SQLite.
 *
 * Proves that the evidence behind it is durable (it survives closing the payment dialog,
 * cancellation, and a restart), that it is read-only, and that it stays inside this company,
 * device and cashier's visibility.
 */

const ATTEMPT_KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_USER = '12121212-1212-4212-8212-121212121212'
const OTHER_DEVICE = '34343434-3434-4343-8343-343434343434'
const OTHER_COMPANY = '99999999-9999-4999-8999-999999999991'
const NOW = '2026-01-01T02:00:00.000Z'

function trackedIntent(): CheckoutIntent {
  return validIntent({
    items: [
      {
        id: 'item-1',
        productUuid: trackedProductUuid,
        quantity: '1.000',
        discountType: null,
        discountValue: 0
      }
    ],
    payments: [{ id: 'payment-1', paymentMethodUuid: methodUuid, amount: 500, reference: null }]
  })
}

function supportIssuesFor(
  repositories: RealRepositories,
  localSale: LocalSaleService
): SupportIssuesService {
  return new SupportIssuesService({
    session: repositories.sessionMetadata,
    allocationDispatches: repositories.allocationDispatches,
    saleAttempts: repositories.saleAttempts,
    recoverySummary: (attempt) => localSale.recoverySummary(attempt),
    productName: (uuid) => repositories.catalog.getProduct(uuid)?.name ?? null
  })
}

/** A legacy uncertainty row for another owner, through the real append-only repository write. */
function foreignLegacyUncertainty(
  repositories: RealRepositories,
  attemptKey: string,
  owner: { companyUuid: string; deviceUuid: string; userUuid: string }
): void {
  repositories.saleAttempts.recordLegacyUncertainty(
    {
      attemptKey,
      ...owner,
      originWarehouseUuid: warehouseUuid,
      intentJson: JSON.stringify({ items: [{ productUuid: trackedProductUuid, quantity: '3' }] }),
      claimedAt: NOW
    } as SaleAttemptRow,
    [{ productUuid: trackedProductUuid, quantity: '3' }],
    NOW
  )
}

databaseTest(
  'a cancelled legacy attempt stays listed as needing support after the dialog closes and after a restart',
  async (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const { localSale, authority } = setUpAuthorizedContext(database, repositories)
    enableAllocationCapability(repositories)
    claimStuckAttempt(repositories, authority, ATTEMPT_KEY, trackedIntent())
    // Exactly what migration 0016 does to an attempt claimed by an earlier build.
    database
      .prepare("UPDATE sale_attempts SET dispatch_evidence = 'unknown' WHERE attempt_key = ?")
      .run(ATTEMPT_KEY)

    // While it is still claimed it is a payment waiting on the POS screen, flagged as legacy.
    const before = syncSupportIssuesSchema.parse(supportIssuesFor(repositories, localSale).list())
    equal(before.paymentAwaitingDecision?.reference, supportReference('SA', ATTEMPT_KEY))
    equal(before.paymentAwaitingDecision?.legacyDispatchUnknown, true)
    equal(before.needsSupport.length, 0)

    equal(
      localSale.abandon(ATTEMPT_KEY, { acknowledgeLegacyUncertainty: true }).outcome,
      'abandoned'
    )

    const after = syncSupportIssuesSchema.parse(supportIssuesFor(repositories, localSale).list())
    equal(after.paymentAwaitingDecision, null)
    equal(after.needsSupport.length, 1)
    equal(after.needsSupport[0].kind, 'legacy-dispatch-uncertainty')
    equal(after.needsSupport[0].reference, supportReference('SA', ATTEMPT_KEY))
    equal(after.needsSupport[0].ownedByCurrentUser, true)
    deepEqual(
      after.needsSupport[0].lines?.map((line) => line.quantity),
      ['1.000']
    )
    closeDatabase(database)

    // Restart: a fresh connection and fresh services over the same file.
    const reopened = openExistingTestDatabase(sandbox)
    try {
      const reopenedRepositories = realRepositories(reopened)
      const restarted = setUpAuthorizedContext(
        reopened,
        reopenedRepositories,
        undefined,
        'online',
        false
      )
      const listed = syncSupportIssuesSchema.parse(
        supportIssuesFor(reopenedRepositories, restarted.localSale).list()
      )
      equal(listed.needsSupport.length, 1)
      equal(listed.needsSupport[0].kind, 'legacy-dispatch-uncertainty')
      equal(
        readCommitted<{ status: string }>(
          sandbox,
          'SELECT status FROM legacy_dispatch_uncertainties WHERE attempt_key = ?',
          [ATTEMPT_KEY]
        )[0]?.status,
        'open'
      )
      equal(
        readCommitted<{ state: string }>(sandbox, 'SELECT state FROM sale_attempts')[0]?.state,
        'abandoned'
      )
    } finally {
      closeDatabase(reopened)
    }
  }
)

databaseTest(
  'an identity conflict needs support with its trace id, is never retryable, and a pending request is listed apart',
  async (sandbox) => {
    const database = openTestDatabase(sandbox)
    try {
      const repositories = realRepositories(database)
      const { localSale, authority } = setUpAuthorizedContext(database, repositories)
      enableAllocationCapability(repositories)
      claimStuckAttempt(repositories, authority, ATTEMPT_KEY, trackedIntent())
      const dispatchOwner = { companyUuid, deviceUuid, warehouseUuid, actorUserUuid: userUuid }
      const conflictKey = 'c'.repeat(64)
      const pendingKey = 'd'.repeat(64)

      for (const key of [conflictKey, pendingKey]) {
        ok(
          repositories.allocationDispatches.insertForClaimedAttempt({
            attemptKey: ATTEMPT_KEY,
            owner: dispatchOwner,
            body: {
              idempotency_key: key,
              allocation_payload_version: 2,
              items: [{ product_uuid: trackedProductUuid, quantity: '1.000' }]
            },
            createdAt: NOW
          })
        )
        repositories.allocationDispatches.markSending(key, NOW)
      }
      repositories.allocationDispatches.resolve(
        conflictKey,
        'conflict',
        {
          kind: 'response',
          category: 'conflict',
          backendCode: 'IDEMPOTENCY_CONFLICT',
          httpStatus: 409,
          traceId: 'trace-409'
        },
        NOW
      )
      repositories.allocationDispatches.recordAmbiguous(
        pendingKey,
        { kind: 'ambiguous', reason: 'transport' },
        '2026-01-01T02:10:00.000Z'
      )

      const listed = syncSupportIssuesSchema.parse(supportIssuesFor(repositories, localSale).list())

      equal(listed.needsSupport.length, 1)
      equal(listed.needsSupport[0].kind, 'allocation-identity-conflict')
      equal(listed.needsSupport[0].traceId, 'trace-409')
      equal(listed.needsSupport[0].reference, supportReference('AD', conflictKey))
      equal(listed.automaticReconciliation.length, 1)
      equal(listed.automaticReconciliation[0].kind, 'allocation-request-pending')
      equal(listed.automaticReconciliation[0].sendCount, 1)
      equal(listed.automaticReconciliation[0].nextAttemptAfter, '2026-01-01T02:10:00.000Z')
      // The waiting payment says Retry cannot succeed; nothing here re-sends or resolves anything.
      equal(listed.paymentAwaitingDecision?.retryAvailable, false)
      equal(listed.paymentAwaitingDecision?.traceId, 'trace-409')
      deepEqual(
        readCommitted<{ state: string }>(
          sandbox,
          'SELECT state FROM attempt_allocation_dispatches ORDER BY idempotency_key'
        ).map((row) => row.state),
        ['conflict', 'dispatched']
      )
    } finally {
      closeDatabase(database)
    }
  }
)

databaseTest(
  "another cashier's record on this device is redacted; another device's or company's is excluded",
  async (sandbox) => {
    const database = openTestDatabase(sandbox)
    try {
      const repositories = realRepositories(database)
      const { localSale } = setUpAuthorizedContext(database, repositories)
      foreignLegacyUncertainty(repositories, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', {
        companyUuid,
        deviceUuid,
        userUuid: OTHER_USER
      })
      foreignLegacyUncertainty(repositories, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', {
        companyUuid,
        deviceUuid: OTHER_DEVICE,
        userUuid
      })
      foreignLegacyUncertainty(repositories, 'ffffffff-ffff-4fff-8fff-ffffffffffff', {
        companyUuid: OTHER_COMPANY,
        deviceUuid,
        userUuid
      })

      const listed = syncSupportIssuesSchema.parse(supportIssuesFor(repositories, localSale).list())

      equal(listed.needsSupport.length, 1)
      equal(
        listed.needsSupport[0].reference,
        supportReference('SA', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
      )
      equal(listed.needsSupport[0].ownedByCurrentUser, false)
      equal(listed.needsSupport[0].lines, null)
      ok(!JSON.stringify(listed).includes(trackedProductUuid))
      // All three rows still exist: excluded from view, never removed.
      equal(readCommitted(sandbox, 'SELECT * FROM legacy_dispatch_uncertainties').length, 3)
    } finally {
      closeDatabase(database)
    }
  }
)
