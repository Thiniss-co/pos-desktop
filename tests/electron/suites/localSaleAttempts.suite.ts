import { deepEqual, equal, ok } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import { databaseTest } from '../support/sandbox'
import { readCommitted, tableDigest } from '../support/committedState'
import { failingDatabase } from '../support/failingDatabase'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories } from '../support/realRepositories'
import {
  bootstrapResource,
  claimStuckAttempt,
  methodUuid,
  setUpAuthorizedContext,
  validIntent
} from '../support/localSaleFixture'

/**
 * Plan CP-5b, `localSaleAttempts.suite.ts` — the attempt-lifecycle edges the completion suite does
 * not reach: the full fault-injection boundary sweep (plan §7d), the deliberately-inconsistent
 * stored shapes that must fail closed without mutating anything (§1.6/§2.11), and the D1-A rights
 * matrix, which must gate discover/retrieve/acknowledge/abandon *separately* from new/retry.
 */

const KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_KEY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

/** Every business-table row count, for proving a rollback left absolutely nothing behind. */
function businessRowCounts(sandbox: Parameters<typeof readCommitted>[0]): Record<string, number> {
  return {
    invoices: readCommitted(sandbox, 'SELECT * FROM local_invoices').length,
    items: readCommitted(sandbox, 'SELECT * FROM local_invoice_items').length,
    payments: readCommitted(sandbox, 'SELECT * FROM local_invoice_payments').length,
    movements: readCommitted(sandbox, 'SELECT * FROM local_stock_movements').length,
    consumptions: readCommitted(sandbox, 'SELECT * FROM local_stock_allocation_consumptions')
      .length,
    queued: readCommitted(sandbox, "SELECT * FROM sync_queue WHERE aggregate_type = 'invoice'")
      .length
  }
}

databaseTest(
  'an instrumented dry run enumerates the real write boundaries the sweep must cover',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const fixture = setUpAuthorizedContext(database, repositories)

    // Plan §7d: the boundary count is *read from an instrumented dry run*, never guessed, so the
    // sweep below cannot silently stop covering writes that were added later.
    let writes = 0
    const counting = fixture.withWriteDatabase(
      failingDatabase(database, { failOnWriteNumber: -1, onWrite: (count) => (writes = count) })
    )

    const outcome = counting.complete(KEY, validIntent())

    ok(outcome.outcome === 'committed')
    // claim + invoice + item + payment + attempt update + queue insert, at minimum.
    ok(writes >= 6, `expected at least six write boundaries, observed ${writes}`)
    closeDatabase(database)
  }
)

databaseTest(
  'a fault injected at every enumerated write boundary rolls back to zero business rows',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const fixture = setUpAuthorizedContext(database, repositories)

    let boundaries = 0
    const counting = fixture.withWriteDatabase(
      failingDatabase(database, { failOnWriteNumber: -1, onWrite: (count) => (boundaries = count) })
    )
    ok(counting.complete(OTHER_KEY, validIntent()).outcome === 'committed')
    ok(boundaries >= 6)

    // Every boundary from the claim insert onwards, one fresh sandbox database each.
    for (let boundary = 1; boundary <= boundaries; boundary += 1) {
      const scoped = openTestDatabase({
        ...sandbox,
        databasePath: `${sandbox.databasePath}.b${boundary}`,
        register: (value) => value,
        root: sandbox.root,
        retain: sandbox.retain,
        dispose: sandbox.dispose
      })
      const scopedRepositories = realRepositories(scoped)
      const scopedFixture = setUpAuthorizedContext(scoped, scopedRepositories)
      const failing = scopedFixture.withWriteDatabase(
        failingDatabase(scoped, { failOnWriteNumber: boundary })
      )

      let threw = false
      let outcome: ReturnType<typeof failing.complete> | null = null
      try {
        outcome = failing.complete(KEY, validIntent())
      } catch {
        // A failure at the claim insert itself is reported as an opaque unavailable key, never a
        // thrown error, so any throw here is itself worth surfacing.
        threw = true
      }

      const invoices = scoped.prepare('SELECT COUNT(*) AS total FROM local_invoices').get() as {
        total: number
      }
      const items = scoped.prepare('SELECT COUNT(*) AS total FROM local_invoice_items').get() as {
        total: number
      }
      const payments = scoped
        .prepare('SELECT COUNT(*) AS total FROM local_invoice_payments')
        .get() as { total: number }
      const movements = scoped
        .prepare('SELECT COUNT(*) AS total FROM local_stock_movements')
        .get() as { total: number }
      const queued = scoped
        .prepare("SELECT COUNT(*) AS total FROM sync_queue WHERE aggregate_type = 'invoice'")
        .get() as { total: number }

      // No boundary may leave a partially written sale: it is all of it, or none of it.
      equal(invoices.total, 0, `boundary ${boundary} left an invoice behind`)
      equal(items.total, 0, `boundary ${boundary} left invoice items behind`)
      equal(payments.total, 0, `boundary ${boundary} left payments behind`)
      equal(movements.total, 0, `boundary ${boundary} left stock movements behind`)
      equal(queued.total, 0, `boundary ${boundary} left a queued upload behind`)
      ok(!threw || boundary === 1, `boundary ${boundary} threw unexpectedly`)

      if (outcome) {
        // Never a committed sale, and never a silent success.
        ok(
          outcome.outcome === 'rejected' || outcome.outcome === 'failed',
          `boundary ${boundary} produced ${outcome.outcome}`
        )
      }

      scoped.close()
    }

    closeDatabase(database)
  }
)

databaseTest(
  'a committed result whose queued payload was tampered with fails closed, without mutating it',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const { localSale } = setUpAuthorizedContext(database, repositories)

    ok(localSale.complete(KEY, validIntent()).outcome === 'committed')

    // Corrupt the immutable queued payload behind the service's back.
    database
      .prepare(
        "UPDATE sync_queue SET payload_json = json_set(payload_json, '$.currency', 'USD') WHERE aggregate_type = 'invoice'"
      )
      .run()
    const beforeDigest = tableDigest(sandbox, 'sync_queue')
    const attemptsBefore = tableDigest(sandbox, 'sale_attempts')

    // Plan §1.6 item 3: a replay must independently verify the stored result, not merely the
    // attempt↔invoice linkage, and must fail closed while preserving every row as evidence.
    const replay = localSale.complete(KEY, validIntent())

    deepEqual(replay, { outcome: 'failed', code: 'integrity-inconsistency', attemptKey: KEY })
    equal(tableDigest(sandbox, 'sync_queue'), beforeDigest)
    equal(tableDigest(sandbox, 'sale_attempts'), attemptsBefore)
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 1)
    closeDatabase(database)
  }
)

databaseTest(
  'a committed result whose payload hash no longer matches its payload fails closed',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const { localSale } = setUpAuthorizedContext(database, repositories)

    ok(localSale.complete(KEY, validIntent()).outcome === 'committed')

    database
      .prepare("UPDATE sync_queue SET payload_hash = ? WHERE aggregate_type = 'invoice'")
      .run('0'.repeat(64))
    const beforeDigest = tableDigest(sandbox, 'sync_queue')

    equal(localSale.retry(KEY).outcome, 'failed')
    deepEqual(localSale.acknowledge(KEY), {
      outcome: 'failed',
      code: 'integrity-inconsistency',
      attemptKey: KEY
    })
    // A failed integrity check never acknowledges, repairs, or rewrites anything.
    equal(tableDigest(sandbox, 'sync_queue'), beforeDigest)
    equal(
      readCommitted<{ state: string }>(sandbox, 'SELECT state FROM sale_attempts')[0]?.state,
      'committed'
    )
    closeDatabase(database)
  }
)

databaseTest('a committed result with no queued upload row at all fails closed', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  const { localSale } = setUpAuthorizedContext(database, repositories)

  ok(localSale.complete(KEY, validIntent()).outcome === 'committed')
  database.prepare("DELETE FROM sync_queue WHERE aggregate_type = 'invoice'").run()

  deepEqual(localSale.retry(KEY), {
    outcome: 'failed',
    code: 'integrity-inconsistency',
    attemptKey: KEY
  })
  // The invoice is still there — evidence is preserved, never deleted to "tidy up".
  equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 1)
  closeDatabase(database)
})

databaseTest(
  'a claimed attempt with malformed retained intent fails closed on retry',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const { localSale, authority } = setUpAuthorizedContext(database, repositories)

    claimStuckAttempt(repositories, authority, KEY, validIntent())
    database.prepare('UPDATE sale_attempts SET intent_json = ? WHERE attempt_key = ?').run('{', KEY)
    const before = tableDigest(sandbox, 'sale_attempts')

    deepEqual(localSale.retry(KEY), {
      outcome: 'failed',
      code: 'integrity-inconsistency',
      attemptKey: KEY
    })
    // Non-mutating: the corrupt row is preserved for a separately authorized repair workflow.
    equal(tableDigest(sandbox, 'sale_attempts'), before)
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 0)
    closeDatabase(database)
  }
)

databaseTest(
  'a claimed attempt whose intent no longer matches its fingerprint fails closed on retry',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const { localSale, authority } = setUpAuthorizedContext(database, repositories)

    claimStuckAttempt(repositories, authority, KEY, validIntent())
    // Well-formed JSON, but no longer the intent the stored fingerprint was computed over.
    database
      .prepare('UPDATE sale_attempts SET intent_json = ? WHERE attempt_key = ?')
      .run(
        JSON.stringify(validIntent({ customerUuid: '99999999-9999-4999-8999-999999999997' })),
        KEY
      )

    deepEqual(localSale.retry(KEY), {
      outcome: 'failed',
      code: 'integrity-inconsistency',
      attemptKey: KEY
    })
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 0)
    closeDatabase(database)
  }
)

databaseTest(
  'an impossible claimed-attempt-with-an-invoice shape is never promoted by abandon',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const { localSale, authority } = setUpAuthorizedContext(database, repositories)

    // Commit a real sale, then force the attempt back to `claimed` while its invoice still exists
    // — a shape the atomic transaction can never produce, so it can only mean corruption.
    ok(localSale.complete(KEY, validIntent()).outcome === 'committed')
    claimStuckAttempt(repositories, authority, OTHER_KEY, validIntent())
    database
      .prepare('UPDATE local_invoices SET attempt_key = ? WHERE attempt_key = ?')
      .run(OTHER_KEY, KEY)
    const before = tableDigest(sandbox, 'local_invoices')

    // Plan §2.5: an invoice witness on a claimed row is `integrity-inconsistency`, never a
    // silent promotion and never an abandonment that would hide a real sale.
    deepEqual(localSale.abandon(OTHER_KEY), {
      outcome: 'failed',
      code: 'integrity-inconsistency',
      attemptKey: OTHER_KEY
    })
    equal(tableDigest(sandbox, 'local_invoices'), before)
    equal(
      readCommitted<{ state: string }>(
        sandbox,
        `SELECT state FROM sale_attempts WHERE attempt_key = '${OTHER_KEY}'`
      )[0]?.state,
      'claimed'
    )
    closeDatabase(database)
  }
)

databaseTest(
  'D1-A: losing pos.sell blocks a new sale and a retry but never blocks recovery',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const { localSale, authority } = setUpAuthorizedContext(database, repositories)

    // One committed-unacknowledged result, and one stranded claim, both made while authorized.
    ok(localSale.complete(KEY, validIntent()).outcome === 'committed')
    claimStuckAttempt(repositories, authority, OTHER_KEY, validIntent())

    // The cashier's selling right is revoked; everything else about the session is unchanged.
    repositories.bootstrapSnapshot.persistSnapshot(
      bootstrapResource({ permissions: ['pos.view'] }),
      '2026-01-01T04:00:00+00:00'
    )

    // New selling is refused. `commercialAccess.evaluate('sell')` consults `pos.sell` itself and
    // is checked first, so a revoked permission surfaces as `context-changed` rather than
    // `permission-denied`; both are non-terminal, so the assertion is on the property the plan
    // actually requires — refused, zero writes, still recoverable — not on which of the two.
    const nonTerminal = new Set(['permission-denied', 'context-changed', 'attempt-blocked'])
    const blocked = localSale.complete('cccccccc-cccc-4ccc-8ccc-ccccccccccce', validIntent())
    ok(blocked.outcome === 'failed')
    ok(nonTerminal.has(blocked.code), `unexpected new-sale refusal code ${blocked.code}`)

    // … and so is a retry, which would create a sale.
    const retried = localSale.retry(OTHER_KEY)
    ok(retried.outcome === 'failed')
    ok(nonTerminal.has(retried.code), `unexpected retry refusal code ${retried.code}`)

    // Neither refusal may rewrite the attempt: it must still be `claimed`, hence still abandonable.
    equal(
      readCommitted<{ state: string }>(
        sandbox,
        `SELECT state FROM sale_attempts WHERE attempt_key = '${OTHER_KEY}'`
      )[0]?.state,
      'claimed'
    )

    // … but discovery, retrieval, acknowledgment, and abandonment must all still work: the exact
    // owner has to be able to account for tender already taken (plan §1.2/§2.5).
    const pending = localSale.pendingAttempts()
    equal(pending.blockingAttempt?.attemptKey, OTHER_KEY)
    deepEqual(
      pending.unacknowledgedResults.map((row) => row.attemptKey),
      [KEY]
    )

    const acknowledged = localSale.acknowledge(KEY)
    equal(acknowledged.outcome, 'acknowledged')

    const abandoned = localSale.abandon(OTHER_KEY)
    equal(abandoned.outcome, 'abandoned')

    // No new sale resulted from any of it.
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 1)
    closeDatabase(database)
  }
)

databaseTest('a rejected key is a permanent tombstone that can never sell again', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  const fixture = setUpAuthorizedContext(database, repositories)

  const failing = fixture.withWriteDatabase(failingDatabase(database, { failOnWriteNumber: 3 }))
  const rejected = failing.complete(KEY, validIntent())
  equal(rejected.outcome, 'rejected')

  // The exact same content under the same key returns the original rejection, never a new sale.
  const repeated = fixture.localSale.complete(KEY, validIntent())
  deepEqual(repeated, { outcome: 'rejected', attemptKey: KEY, failureCode: 'invariant' })
  // Retry can never resurrect it either.
  deepEqual(fixture.localSale.retry(KEY), {
    outcome: 'rejected',
    attemptKey: KEY,
    failureCode: 'invariant'
  })

  // Changed content under a tombstoned key is a conflict, not a second sale.
  const changed = fixture.localSale.complete(
    KEY,
    validIntent({
      payments: [{ id: 'payment-1', paymentMethodUuid: methodUuid, amount: 2000, reference: null }]
    })
  )
  deepEqual(changed, { outcome: 'failed', code: 'attempt-conflict', attemptKey: KEY })

  // A corrected sale under a genuinely new key is allowed, and is the only way forward.
  ok(fixture.localSale.complete(OTHER_KEY, validIntent()).outcome === 'committed')
  equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 1)
  deepEqual(businessRowCounts(sandbox).queued, 1)
  closeDatabase(database)
})

databaseTest('an abandoned key is a tombstone that can never sell again', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  const { localSale, authority } = setUpAuthorizedContext(database, repositories)

  claimStuckAttempt(repositories, authority, KEY, validIntent())
  equal(localSale.abandon(KEY).outcome, 'abandoned')

  // Idempotent abandonment, and no resurrection through complete or retry.
  deepEqual(localSale.abandon(KEY), { outcome: 'abandoned', attemptKey: KEY })
  deepEqual(localSale.complete(KEY, validIntent()), { outcome: 'abandoned', attemptKey: KEY })
  deepEqual(localSale.retry(KEY), { outcome: 'abandoned', attemptKey: KEY })

  // Changed content against the tombstone is a conflict.
  deepEqual(
    localSale.complete(
      KEY,
      validIntent({
        payments: [
          { id: 'payment-1', paymentMethodUuid: methodUuid, amount: 3000, reference: null }
        ]
      })
    ),
    { outcome: 'failed', code: 'attempt-conflict', attemptKey: KEY }
  )

  deepEqual(businessRowCounts(sandbox), {
    invoices: 0,
    items: 0,
    payments: 0,
    movements: 0,
    consumptions: 0,
    queued: 0
  })
  closeDatabase(database)
})
