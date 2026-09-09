/**
 * Catalog-expiry checkout guard (plan §2.2 finding 5 / §8.2 item 4).
 *
 * An issued catalog contract carries its own `valid_until`. `CatalogService` deliberately keeps an
 * expired contract *readable* (`status: 'stale'`, `isReadable: true`) so an authorized cashier can
 * still browse the retained snapshot offline. Before this suite, nothing on the main-process
 * completion path turned that stale status into a sale refusal: `CommercialAccessService` never
 * reads the contract window, and the business transaction compared only the contract *revision*,
 * which an expired snapshot still satisfies. A sale could therefore commit locally against an
 * expired catalog and be refused later by the backend, which requires
 * `generated_at <= sold_at < valid_until` at upload.
 *
 * Both reachable divergences are covered, because the fixture defaults make the catalog window and
 * the license revalidation deadline coincide (both `2026-01-04T00:00:00Z`) and so hide the defect:
 *
 *  - **License re-validated without a catalog refresh.** `POST /desktop/license/validate` advances
 *    the stored `nextValidationDueAt` on its own; the retained catalog snapshot keeps its older
 *    `valid_until`.
 *  - **Subscription grace.** The backend clips `valid_until` to `subscription.expires_at`, while
 *    commercial access keeps allowing `sell` until `grace_ends_at`.
 *
 * Time is controlled entirely through the fixture's injected `now`; no OS clock, real license, or
 * live subscription is touched, and every database is a disposable sandbox file.
 */

import { equal, ok } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import { licenseStatusFixture } from '../../../src/main/testing/fixtures/licenseStatus.fixture'
import { databaseTest, type DatabaseSandbox } from '../support/sandbox'
import { readCommitted } from '../support/committedState'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories, type RealRepositories } from '../support/realRepositories'
import {
  companyUuid,
  deviceUuid,
  methodUuid,
  productUuid,
  setUpAuthorizedContext,
  trackedProductUuid,
  validIntent,
  warehouseUuid
} from '../support/localSaleFixture'

/** The fixture catalog contract's own window; the suite never re-derives it from a clock. */
const CATALOG_VALID_UNTIL = '2026-01-04T00:00:00.000Z'
const INSIDE_CATALOG_WINDOW = new Date('2026-01-03T12:00:00.000Z')
const EXACTLY_AT_EXPIRY = new Date(CATALOG_VALID_UNTIL)
const AFTER_EXPIRY = new Date('2026-01-05T00:00:00.000Z')

function assertNoBusinessWrites(sandbox: DatabaseSandbox): void {
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

/**
 * Divergence A: the license was validated again at `2026-01-04`, so commercial sell authority runs
 * to `2026-01-07`, while the retained catalog snapshot still expires at `2026-01-04`.
 */
function reValidateLicenseWithoutCatalogRefresh(repositories: RealRepositories): void {
  repositories.licenseMetadata.setValidatedStatus(
    licenseStatusFixture({
      validatedAt: '2026-01-04T00:00:00+00:00',
      serverTime: '2026-01-04T00:00:00+00:00',
      nextValidationDueAt: '2026-01-07T00:00:00+00:00'
    }),
    '2026-01-04T00:00:00.000Z'
  )
}

/**
 * Divergence B: the subscription expired at `2026-01-02` (which is what clipped the catalog
 * window), but grace runs to `2026-01-06`, so commercial access still allows `sell`.
 */
function enterSubscriptionGrace(repositories: RealRepositories): void {
  repositories.licenseMetadata.setValidatedStatus(
    licenseStatusFixture({
      validatedAt: '2026-01-04T00:00:00+00:00',
      serverTime: '2026-01-04T00:00:00+00:00',
      nextValidationDueAt: '2026-01-07T00:00:00+00:00',
      isInGrace: true,
      expiresAt: '2026-01-02T00:00:00+00:00',
      subscription: {
        status: 'active',
        expiresAt: '2026-01-02T00:00:00+00:00',
        graceEndsAt: '2026-01-06T00:00:00+00:00'
      }
    }),
    '2026-01-04T00:00:00.000Z'
  )
}

function grantTrackedAllocation(repositories: RealRepositories): void {
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
    // Deliberately far beyond the catalog window: this proves the refusal comes from the catalog
    // guard and not from allocation expiry.
    consumeUntil: '2027-01-01T00:00:00.000Z',
    envelopeHash: 'a'.repeat(64),
    receivedAt: '2026-01-01T00:00:00.000Z'
  })
}

function trackedIntent(): ReturnType<typeof validIntent> {
  return validIntent({
    items: [
      {
        id: 'item-1',
        productUuid: trackedProductUuid,
        quantity: '2.000',
        discountType: null,
        discountValue: 0
      }
    ],
    payments: [{ id: 'payment-1', paymentMethodUuid: methodUuid, amount: 1000, reference: null }]
  })
}

databaseTest(
  'an expired catalog refuses an untracked-only completion after an independent license revalidation',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    try {
      const repositories = realRepositories(database)
      const { localSale } = setUpAuthorizedContext(database, repositories, () => AFTER_EXPIRY)
      reValidateLicenseWithoutCatalogRefresh(repositories)

      const outcome = localSale.complete('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', validIntent())

      ok(outcome.outcome === 'failed')
      equal(outcome.code, 'refresh-required')
      assertNoBusinessWrites(sandbox)
      // Non-terminal: the attempt stays claimed with its retained intent, so the cashier's cart is
      // recoverable once the catalog is refreshed. It is not rejected into a dead key.
      equal(
        readCommitted<{ state: string }>(sandbox, 'SELECT state FROM sale_attempts')[0]?.state,
        'claimed'
      )
    } finally {
      closeDatabase(database)
    }
  }
)

databaseTest(
  'an expired catalog refuses an untracked-only completion during subscription grace',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    try {
      const repositories = realRepositories(database)
      const { localSale } = setUpAuthorizedContext(database, repositories, () => AFTER_EXPIRY)
      enterSubscriptionGrace(repositories)

      const outcome = localSale.complete('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', validIntent())

      ok(outcome.outcome === 'failed')
      equal(outcome.code, 'refresh-required')
      assertNoBusinessWrites(sandbox)
    } finally {
      closeDatabase(database)
    }
  }
)

databaseTest(
  'an expired catalog refuses a tracked completion even with a valid unexpired allocation',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    try {
      const repositories = realRepositories(database)
      const { localSale } = setUpAuthorizedContext(database, repositories, () => AFTER_EXPIRY)
      reValidateLicenseWithoutCatalogRefresh(repositories)
      grantTrackedAllocation(repositories)

      const outcome = localSale.complete('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', trackedIntent())

      ok(outcome.outcome === 'failed')
      equal(outcome.code, 'refresh-required')
      assertNoBusinessWrites(sandbox)
      // The grant itself is untouched and still active: the refusal consumed no rights.
      equal(
        readCommitted<{ status: string }>(sandbox, 'SELECT status FROM stock_allocation_grants')[0]
          ?.status,
        'active'
      )
    } finally {
      closeDatabase(database)
    }
  }
)

databaseTest('a sale exactly at catalog valid_until cannot commit', (sandbox) => {
  const database = openTestDatabase(sandbox)
  try {
    const repositories = realRepositories(database)
    const { localSale } = setUpAuthorizedContext(database, repositories, () => EXACTLY_AT_EXPIRY)
    reValidateLicenseWithoutCatalogRefresh(repositories)

    const outcome = localSale.complete('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', validIntent())

    ok(outcome.outcome === 'failed')
    equal(outcome.code, 'refresh-required')
    assertNoBusinessWrites(sandbox)
  } finally {
    closeDatabase(database)
  }
})

databaseTest(
  'a draft claimed inside the catalog window cannot be completed after it expires',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    try {
      const repositories = realRepositories(database)
      let current = INSIDE_CATALOG_WINDOW
      const { localSale } = setUpAuthorizedContext(database, repositories, () => current)

      const attemptKey = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      // The claim happens while the contract is genuinely current.
      const prepared = localSale.prepareCompletion(attemptKey, validIntent())
      ok(prepared.kind === 'ready')

      // Time crosses the boundary between the claim and the business transaction — the exact race the
      // guard has to lose safely. The license is revalidated in that same interval (the realistic
      // cause of the divergence), so commercial sell authority is genuinely still granted and the
      // only thing standing between this cart and a commit is the catalog window.
      current = AFTER_EXPIRY
      reValidateLicenseWithoutCatalogRefresh(repositories)
      const outcome = localSale.runPrepared(prepared)

      ok(outcome.outcome === 'failed')
      equal(outcome.code, 'refresh-required')
      assertNoBusinessWrites(sandbox)
      equal(
        readCommitted<{ state: string }>(sandbox, 'SELECT state FROM sale_attempts')[0]?.state,
        'claimed'
      )
    } finally {
      closeDatabase(database)
    }
  }
)

databaseTest(
  'a valid cached catalog still permits an offline sale when every other guard passes',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    try {
      const repositories = realRepositories(database)
      // Offline: connectivity is unavailable, but the issued contract is still inside its window.
      const { localSale } = setUpAuthorizedContext(
        database,
        repositories,
        () => INSIDE_CATALOG_WINDOW,
        'offline'
      )

      const outcome = localSale.complete('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', validIntent())

      ok(outcome.outcome === 'committed')
      equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 1)
      equal(
        readCommitted(sandbox, "SELECT * FROM sync_queue WHERE aggregate_type = 'invoice'").length,
        1
      )
    } finally {
      closeDatabase(database)
    }
  }
)

databaseTest(
  'an already committed sale still replays after its catalog expires and is not re-checked as a new checkout',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    try {
      const repositories = realRepositories(database)
      let current = INSIDE_CATALOG_WINDOW
      const { localSale } = setUpAuthorizedContext(database, repositories, () => current)

      const attemptKey = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      const intent = validIntent()
      const committed = localSale.complete(attemptKey, intent)
      ok(committed.outcome === 'committed')

      // The catalog expires after the sale was validly rung. A historically valid sale must stay
      // retrievable; expiry stops *new* commits only.
      current = AFTER_EXPIRY
      reValidateLicenseWithoutCatalogRefresh(repositories)

      const replay = localSale.complete(attemptKey, intent)

      ok(replay.outcome === 'committed')
      equal(replay.replay, true)
      // Still exactly one invoice and one queue row: the replay created nothing.
      equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 1)
      equal(
        readCommitted(sandbox, "SELECT * FROM sync_queue WHERE aggregate_type = 'invoice'").length,
        1
      )
    } finally {
      closeDatabase(database)
    }
  }
)

databaseTest('the tracked product remains sellable while the catalog is valid', (sandbox) => {
  const database = openTestDatabase(sandbox)
  try {
    const repositories = realRepositories(database)
    const { localSale } = setUpAuthorizedContext(
      database,
      repositories,
      () => INSIDE_CATALOG_WINDOW
    )
    grantTrackedAllocation(repositories)

    const outcome = localSale.complete('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', trackedIntent())

    ok(outcome.outcome === 'committed')
    equal(readCommitted(sandbox, 'SELECT * FROM local_stock_movements').length, 1)
    ok(productUuid.length > 0)
  } finally {
    closeDatabase(database)
  }
})
