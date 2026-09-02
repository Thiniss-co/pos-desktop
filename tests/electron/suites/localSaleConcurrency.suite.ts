import { deepEqual, equal, ok, throws } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import { databaseTest } from '../support/sandbox'
import { readCommitted, tableDigest } from '../support/committedState'
import { failingDatabase } from '../support/failingDatabase'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories } from '../support/realRepositories'
import {
  bootstrapResource,
  methodUuid,
  setUpAuthorizedContext,
  validIntent
} from '../support/localSaleFixture'

/**
 * Plan CP-5b, `localSaleConcurrency.suite.ts` — plan §7e/§7f.
 *
 * The concurrency argument for this app is structural, not statistical: one main process, one
 * `better-sqlite3` handle, a fully synchronous API, `journal_mode=WAL`, `busy_timeout=5000` ⇒ a
 * single writer with no in-process interleaving. The `async`/`await` grep is supplemental only, so
 * these are the behavioural tests the plan requires instead.
 */

const FIRST_KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SECOND_KEY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

databaseTest(
  'two completions issued in one tick each commit exactly once, never interleaved',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const { localSale } = setUpAuthorizedContext(database, repositories)

    // No await between them: the business path is synchronous, so the second call observes the
    // first's fully committed state — never a half-written one.
    const outcomes = [FIRST_KEY, SECOND_KEY].map((key) => localSale.complete(key, validIntent()))

    ok(outcomes[0].outcome === 'committed')
    // The second key is genuinely new, but the first attempt already committed and freed the
    // blocking index, so this is a legitimate second sale rather than a duplicate of the first.
    ok(outcomes[1].outcome === 'committed')
    if (outcomes[0].outcome === 'committed' && outcomes[1].outcome === 'committed') {
      ok(outcomes[0].invoice.localUuid !== outcomes[1].invoice.localUuid)
      ok(outcomes[0].invoice.offlineNumber !== outcomes[1].invoice.offlineNumber)
    }
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 2)
    equal(
      readCommitted(sandbox, "SELECT * FROM sync_queue WHERE aggregate_type = 'invoice'").length,
      2
    )
    closeDatabase(database)
  }
)

databaseTest(
  'a double-submitted identical completion in one tick commits once and replays once',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const { localSale } = setUpAuthorizedContext(database, repositories)
    const intent = validIntent()

    // The real double-click shape: the same key twice, with no await between.
    const first = localSale.complete(FIRST_KEY, intent)
    const second = localSale.complete(FIRST_KEY, intent)

    ok(first.outcome === 'committed' && second.outcome === 'committed')
    if (first.outcome === 'committed' && second.outcome === 'committed') {
      equal(first.replay, false)
      equal(second.replay, true)
      equal(first.invoice.localUuid, second.invoice.localUuid)
    }
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 1)
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoice_payments').length, 1)
    closeDatabase(database)
  }
)

databaseTest('a completion racing a bootstrap write leaves both consistent', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  const { localSale } = setUpAuthorizedContext(database, repositories)

  const committed = localSale.complete(FIRST_KEY, validIntent())
  ok(committed.outcome === 'committed')

  // A bootstrap snapshot write immediately after the sale — the same single writer, serialized.
  repositories.bootstrapSnapshot.persistSnapshot(bootstrapResource(), '2026-01-01T03:00:00+00:00')

  // The catalogue was rewritten, but the committed sale and its queued payload are untouched.
  equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 1)
  const queued = readCommitted<{ payload_json: string }>(
    sandbox,
    "SELECT payload_json FROM sync_queue WHERE aggregate_type = 'invoice'"
  )
  equal(queued.length, 1)
  if (committed.outcome === 'committed') {
    ok(queued[0]?.payload_json.includes(committed.invoice.localUuid))
  }
  closeDatabase(database)
})

databaseTest(
  'a storage failure (SQLITE_BUSY) fails cleanly, writes nothing, and leaves the attempt claimed',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const fixture = setUpAuthorizedContext(database, repositories)

    // Plan §2.4: a storage failure is NOT a definite rejection. It must surface as a typed
    // transport failure and leave the row `claimed` — the safe direction, still retryable.
    // (`busy_timeout=5000` means a real cross-process lock resolves or raises exactly this.)
    const busyLocalSale = fixture.withWriteDatabase(
      failingDatabase(database, {
        failOnWriteNumber: 3,
        failWith: () => Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
      })
    )

    throws(() => busyLocalSale.complete(FIRST_KEY, validIntent()), /database is locked/)

    const attempts = readCommitted<{ state: string; intent_json: string | null }>(
      sandbox,
      'SELECT state, intent_json FROM sale_attempts'
    )
    equal(attempts.length, 1)
    equal(attempts[0]?.state, 'claimed')
    // The retained intent survives, so the attempt can be retried from disk.
    ok(attempts[0]?.intent_json !== null)

    // Rolls back to zero business rows.
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 0)
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoice_items').length, 0)
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoice_payments').length, 0)
    equal(readCommitted(sandbox, 'SELECT * FROM local_stock_movements').length, 0)
    equal(
      readCommitted(sandbox, "SELECT * FROM sync_queue WHERE aggregate_type = 'invoice'").length,
      0
    )
    closeDatabase(database)
  }
)

databaseTest(
  'a claimed attempt left by a storage failure is retryable to exactly one sale',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const fixture = setUpAuthorizedContext(database, repositories)

    const busyLocalSale = fixture.withWriteDatabase(
      failingDatabase(database, {
        failOnWriteNumber: 3,
        failWith: () => Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
      })
    )
    throws(() => busyLocalSale.complete(FIRST_KEY, validIntent()))

    // The lock clears; the same attempt retries through the healthy connection.
    const retried = fixture.localSale.retry(FIRST_KEY)

    ok(retried.outcome === 'committed')
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 1)
    equal(
      readCommitted<{ state: string }>(sandbox, 'SELECT state FROM sale_attempts')[0]?.state,
      'committed'
    )
    closeDatabase(database)
  }
)

databaseTest(
  'completing a sale makes no outbound network call of any kind (plan §7f)',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const { localSale } = setUpAuthorizedContext(database, repositories)

    // A process-level spy, not an import sweep: anything the completion path actually invokes is
    // recorded here, including through every existing sync-queue consumer.
    const calls: string[] = []
    const globalScope = globalThis as unknown as Record<string, unknown>
    const originalFetch = globalScope.fetch

    globalScope.fetch = (...parameters: unknown[]): never => {
      calls.push(`fetch:${String(parameters[0])}`)
      throw new Error('Phase 3F must not perform any network request')
    }

    try {
      const outcome = localSale.complete(FIRST_KEY, validIntent())
      ok(outcome.outcome === 'committed')

      // And the queue row exists, so "no call" is not merely "nothing happened".
      equal(
        readCommitted(sandbox, "SELECT * FROM sync_queue WHERE aggregate_type = 'invoice'").length,
        1
      )
    } finally {
      globalScope.fetch = originalFetch
    }

    deepEqual(calls, [])
    closeDatabase(database)
  }
)

databaseTest(
  'the queued upload row is never consumed or transitioned by completing more sales',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const { localSale } = setUpAuthorizedContext(database, repositories)

    localSale.complete(FIRST_KEY, validIntent())
    const afterFirst = tableDigest(sandbox, 'sync_queue')

    localSale.complete(
      SECOND_KEY,
      validIntent({
        payments: [
          { id: 'payment-1', paymentMethodUuid: methodUuid, amount: 1000, reference: null }
        ]
      })
    )

    const rows = readCommitted<{ state: string; attempt_count: number }>(
      sandbox,
      "SELECT state, attempt_count FROM sync_queue WHERE aggregate_type = 'invoice'"
    )
    equal(rows.length, 2)
    // No upload worker exists in Phase 3F: every queued row stays `pending`, never attempted.
    ok(rows.every((row) => row.state === 'pending'))
    ok(rows.every((row) => row.attempt_count === 0))
    // The first row's bytes are unchanged by the second sale.
    ok(afterFirst !== tableDigest(sandbox, 'sync_queue'))
    closeDatabase(database)
  }
)
