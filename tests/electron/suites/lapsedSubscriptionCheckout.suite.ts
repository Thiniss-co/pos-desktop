import { deepEqual, equal, ok } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import { licenseStatusFixture } from '../../../src/main/testing/fixtures/licenseStatus.fixture'
import { databaseTest } from '../support/sandbox'
import { readCommitted } from '../support/committedState'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories } from '../support/realRepositories'
import { claimStuckAttempt, setUpAuthorizedContext, validIntent } from '../support/localSaleFixture'

/**
 * Platform Phase 4 closeout — a sale refused while the subscription has lapsed (paid period and grace both ended).
 *
 * The refusal is the till's own commercial-access decision. It must say so (`access-denied`, never the unrelated
 * "shift or workstation changed" of `context-changed`), and before any claim it must write nothing at all, so the
 * draft stays recoverable: once a refresh brings a valid license, the same intent commits exactly once.
 */

const REFUSED_KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const RECOVERED_KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const CLAIMED_KEY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'

const LAPSED = licenseStatusFixture({
  subscription: {
    status: 'active',
    expiresAt: '2025-12-01T00:00:00+00:00',
    graceEndsAt: '2025-12-15T00:00:00+00:00'
  }
})

function counts(sandbox: Parameters<typeof readCommitted>[0]): Record<string, number> {
  return {
    attempts: readCommitted(sandbox, 'SELECT * FROM sale_attempts').length,
    invoices: readCommitted(sandbox, 'SELECT * FROM local_invoices').length,
    payments: readCommitted(sandbox, 'SELECT * FROM local_invoice_payments').length,
    queued: readCommitted(sandbox, "SELECT * FROM sync_queue WHERE aggregate_type = 'invoice'")
      .length
  }
}

databaseTest(
  'a lapsed-subscription refusal claims nothing and names access; after reactivation the draft commits once',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const { localSale } = setUpAuthorizedContext(database, repositories)

    repositories.licenseMetadata.setValidatedStatus(LAPSED, '2026-01-01T00:00:00Z')
    deepEqual(localSale.complete(REFUSED_KEY, validIntent()), {
      outcome: 'failed',
      code: 'access-denied',
      attemptKey: null
    })
    deepEqual(counts(sandbox), { attempts: 0, invoices: 0, payments: 0, queued: 0 })
    deepEqual(localSale.attemptStatus(REFUSED_KEY), { state: 'unknown', failureCode: null })

    // The platform reactivated the subscription and a refresh stored the new license.
    repositories.licenseMetadata.setValidatedStatus(licenseStatusFixture(), '2026-01-01T00:00:00Z')
    const recovered = localSale.complete(RECOVERED_KEY, validIntent())
    equal(recovered.outcome, 'committed')
    deepEqual(counts(sandbox), { attempts: 1, invoices: 1, payments: 1, queued: 1 })

    // A repeated press of the recovered draft replays the same sale; it never creates a second one.
    const replay = localSale.complete(RECOVERED_KEY, validIntent())
    ok(replay.outcome === 'committed' && replay.replay === true)
    deepEqual(counts(sandbox), { attempts: 1, invoices: 1, payments: 1, queued: 1 })
    closeDatabase(database)
  }
)

databaseTest(
  'a claimed attempt whose access lapses before its commit stays claimed and is refused as access-denied',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const { localSale, authority } = setUpAuthorizedContext(database, repositories)
    claimStuckAttempt(repositories, authority, CLAIMED_KEY, validIntent())

    repositories.licenseMetadata.setValidatedStatus(LAPSED, '2026-01-01T00:00:00Z')
    deepEqual(localSale.retry(CLAIMED_KEY), {
      outcome: 'failed',
      code: 'access-denied',
      attemptKey: CLAIMED_KEY
    })
    equal(
      readCommitted<{ state: string }>(sandbox, 'SELECT state FROM sale_attempts')[0]?.state,
      'claimed'
    )
    equal(counts(sandbox).invoices, 0)

    repositories.licenseMetadata.setValidatedStatus(licenseStatusFixture(), '2026-01-01T00:00:00Z')
    equal(localSale.retry(CLAIMED_KEY).outcome, 'committed')
    equal(counts(sandbox).invoices, 1)
    closeDatabase(database)
  }
)
