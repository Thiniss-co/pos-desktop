import { deepEqual, equal, notEqual, ok } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import type { NewStockAllocationGrant } from '../../../src/main/repositories/stockAllocation.repository'
import { databaseTest } from '../support/sandbox'
import { readCommitted, tableDigest } from '../support/committedState'
import { openTestDatabase } from '../support/openTestDatabase'
import { runFreshProcess } from '../support/freshProcess'
import { realRepositories } from '../support/realRepositories'
import {
  companyUuid,
  deviceUuid,
  methodUuid,
  setUpAuthorizedContext,
  trackedProductUuid,
  validIntent,
  warehouseUuid
} from '../support/localSaleFixture'

/**
 * Plan CP-5b, `localSaleRecovery.suite.ts` — **fresh-process** recovery.
 *
 * Every test here spawns genuinely separate Electron processes against one sandbox database file.
 * The crashing process is hard-killed with `SIGKILL` at a real write boundary; the recovering
 * process shares nothing with it and discovers every attempt from on-disk state through
 * `pendingAttempts()`, never from a UUID the test kept in a variable (plan §2.11: "Fresh-process
 * tests use no retained test-variable UUID and no renderer draft").
 *
 * Plan §2.11 also requires that recovery is *driven to completion*: a banner that offers no
 * executable resolution is explicitly not an acceptable outcome, so each test ends in a real
 * retry, abandon, or acknowledgment.
 */

const CLAIM_KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SECOND_KEY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

/** Migrates the sandbox file, then hands it over: every later actor is a separate process. */
function prepareSandbox(sandbox: Parameters<typeof openTestDatabase>[0]): void {
  const database = openTestDatabase(sandbox)
  closeDatabase(database)
}

function attemptStates(
  sandbox: Parameters<typeof openTestDatabase>[0]
): { attempt_key: string; state: string; invoice_local_uuid: string | null }[] {
  return readCommitted<{
    attempt_key: string
    state: string
    invoice_local_uuid: string | null
  }>(sandbox, 'SELECT attempt_key, state, invoice_local_uuid FROM sale_attempts ORDER BY rowid')
}

databaseTest(
  'a SIGKILL before the business commit leaves a claimed attempt and no sale whatsoever',
  (sandbox) => {
    prepareSandbox(sandbox)

    const crashed = runFreshProcess(sandbox, 'crash-before-commit', {
      POS_ITEST_ATTEMPT_KEY: CLAIM_KEY
    })

    // A real killed process: hard-killed mid-transaction, and it never reached its emit.
    equal(crashed.killedBySignal, true)
    notEqual(crashed.status, 0)
    equal(crashed.result, null)
    ok(!crashed.stdout.includes('survived-the-kill-boundary'))

    const attempts = attemptStates(sandbox)
    equal(attempts.length, 1)
    equal(attempts[0]?.state, 'claimed')
    equal(attempts[0]?.invoice_local_uuid, null)
    // Plan §1.7's two independent witnesses that nothing committed.
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 0)
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoice_items').length, 0)
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoice_payments').length, 0)
    equal(readCommitted(sandbox, 'SELECT * FROM local_stock_movements').length, 0)
    equal(
      readCommitted(sandbox, "SELECT * FROM sync_queue WHERE aggregate_type = 'invoice'").length,
      0
    )
  }
)

databaseTest(
  'a process restart inside the same still-valid session keeps claim and commit epochs equal',
  (sandbox) => {
    prepareSandbox(sandbox)
    runFreshProcess(sandbox, 'crash-before-commit', { POS_ITEST_ATTEMPT_KEY: CLAIM_KEY })
    const claimEpoch = readCommitted<{ claim_session_epoch: number }>(
      sandbox,
      'SELECT claim_session_epoch FROM sale_attempts'
    )[0]?.claim_session_epoch

    const retried = runFreshProcess(sandbox, 'retry-discovered-same-session')
    equal(retried.status, 0)
    equal(retried.result?.outcome, 'committed')
    equal(retried.result?.replay, false)
    equal(
      readCommitted<{ commit_session_epoch: number }>(
        sandbox,
        'SELECT commit_session_epoch FROM local_invoices'
      )[0]?.commit_session_epoch,
      claimEpoch
    )
  }
)

databaseTest(
  'a fresh process discovers the stranded claim from disk and drives a retry to completion',
  (sandbox) => {
    prepareSandbox(sandbox)
    runFreshProcess(sandbox, 'crash-before-commit', { POS_ITEST_ATTEMPT_KEY: CLAIM_KEY })
    const claimEpoch = readCommitted<{ claim_session_epoch: number }>(
      sandbox,
      'SELECT claim_session_epoch FROM sale_attempts'
    )[0]?.claim_session_epoch

    // A distinct process performs a real logout/end-session before the same owner logs back in.
    const ended = runFreshProcess(sandbox, 'end-session')
    equal(ended.result?.outcome, 'session-ended')
    ok(Number(ended.result?.epoch) > Number(claimEpoch))

    // A brand-new authenticated process, with no knowledge of CLAIM_KEY, must find the attempt.
    const discovered = runFreshProcess(sandbox, 'discover')
    equal(discovered.status, 0)
    equal(discovered.result?.blockingAttemptKey, CLAIM_KEY)
    deepEqual(discovered.result?.unacknowledgedKeys, [])

    // A third process retries the attempt it discovers — from the stored intent, no renderer draft.
    const retried = runFreshProcess(sandbox, 'retry-discovered')
    equal(retried.status, 0)
    equal(retried.result?.outcome, 'committed')
    equal(retried.result?.attemptKey, CLAIM_KEY)
    equal(retried.result?.replay, false)
    equal(retried.result?.itemCount, 1)
    equal(retried.result?.paymentCount, 1)

    const attempts = attemptStates(sandbox)
    equal(attempts.length, 1)
    equal(attempts[0]?.state, 'committed')
    notEqual(attempts[0]?.invoice_local_uuid, null)
    // Exactly one sale resulted from claim + crash + retry — never two.
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 1)
    equal(
      readCommitted(sandbox, "SELECT * FROM sync_queue WHERE aggregate_type = 'invoice'").length,
      1
    )
    const committedEpoch = readCommitted<{ commit_session_epoch: number }>(
      sandbox,
      'SELECT commit_session_epoch FROM local_invoices'
    )[0]?.commit_session_epoch
    const currentEpoch = readCommitted<{ value: number }>(
      sandbox,
      'SELECT value FROM session_epoch'
    )[0]?.value
    ok(Number(committedEpoch) > Number(claimEpoch))
    equal(committedEpoch, currentEpoch)

    // Exact replay in another process preserves the epoch recorded by the original business commit.
    const replayed = runFreshProcess(sandbox, 'replay-first')
    equal(replayed.result?.outcome, 'committed')
    equal(replayed.result?.replay, true)
    equal(
      readCommitted<{ commit_session_epoch: number }>(
        sandbox,
        'SELECT commit_session_epoch FROM local_invoices'
      )[0]?.commit_session_epoch,
      committedEpoch
    )
  }
)

databaseTest(
  'a fresh process can abandon the stranded claim instead, leaving no sale and an unblocked till',
  (sandbox) => {
    prepareSandbox(sandbox)
    runFreshProcess(sandbox, 'crash-before-commit', { POS_ITEST_ATTEMPT_KEY: CLAIM_KEY })

    const abandoned = runFreshProcess(sandbox, 'abandon-discovered')
    equal(abandoned.status, 0)
    equal(abandoned.result?.outcome, 'abandoned')
    equal(abandoned.result?.attemptKey, CLAIM_KEY)

    const attempts = attemptStates(sandbox)
    equal(attempts[0]?.state, 'abandoned')
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 0)
    // D6-A: abandoning purges the retained intent but keeps the tombstone.
    const purged = readCommitted<{ intent_json: string | null }>(
      sandbox,
      'SELECT intent_json FROM sale_attempts'
    )
    equal(purged[0]?.intent_json, null)

    // The till is unblocked: nothing is claimed any more.
    const discovered = runFreshProcess(sandbox, 'discover')
    equal(discovered.result?.blockingAttemptKey, null)
  }
)

databaseTest(
  'a SIGKILL after the commit leaves a complete, discoverable, acknowledgeable sale',
  (sandbox) => {
    prepareSandbox(sandbox)

    const crashed = runFreshProcess(sandbox, 'crash-after-commit', {
      POS_ITEST_ATTEMPT_KEY: CLAIM_KEY
    })
    // The reply was lost with the process — the cashier never saw a result.
    equal(crashed.killedBySignal, true)
    equal(crashed.result, null)

    const attempts = attemptStates(sandbox)
    equal(attempts[0]?.state, 'committed')
    notEqual(attempts[0]?.invoice_local_uuid, null)
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 1)

    // A fresh process finds the committed-but-unacknowledged result, and nothing blocking.
    const discovered = runFreshProcess(sandbox, 'discover')
    equal(discovered.result?.blockingAttemptKey, null)
    deepEqual(discovered.result?.unacknowledgedKeys, [CLAIM_KEY])

    const acknowledged = runFreshProcess(sandbox, 'acknowledge-first')
    equal(acknowledged.status, 0)
    deepEqual(
      (acknowledged.result?.acknowledged as Record<string, unknown>).outcome,
      'acknowledged'
    )
    deepEqual((acknowledged.result?.remaining as Record<string, unknown>).unacknowledgedKeys, [])

    // Acknowledgment records that the cashier saw it; it never deletes the sale.
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 1)
    equal(attemptStates(sandbox)[0]?.state, 'acknowledged')
  }
)

databaseTest(
  'two lost committed replies are both discoverable across a restart and acknowledged independently',
  (sandbox) => {
    prepareSandbox(sandbox)

    // Two separate processes each commit a sale and lose their reply.
    runFreshProcess(sandbox, 'crash-after-commit', { POS_ITEST_ATTEMPT_KEY: CLAIM_KEY })
    runFreshProcess(sandbox, 'crash-after-commit', { POS_ITEST_ATTEMPT_KEY: SECOND_KEY })

    equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 2)

    // Plan §2.6: committed rows free the blocking index, so many may validly accumulate.
    const discovered = runFreshProcess(sandbox, 'discover')
    equal(discovered.result?.blockingAttemptKey, null)
    deepEqual(discovered.result?.unacknowledgedKeys, [CLAIM_KEY, SECOND_KEY])

    // Acknowledge exactly one; the other must survive untouched — keyset pagination can never
    // hide, skip, or silently acknowledge a second row.
    const first = runFreshProcess(sandbox, 'acknowledge-first')
    deepEqual((first.result?.remaining as Record<string, unknown>).unacknowledgedKeys, [SECOND_KEY])

    const second = runFreshProcess(sandbox, 'acknowledge-first')
    deepEqual((second.result?.remaining as Record<string, unknown>).unacknowledgedKeys, [])

    const states = attemptStates(sandbox)
    equal(states.length, 2)
    ok(states.every((row) => row.state === 'acknowledged'))
    // Both sales still exist; acknowledgment is a display fact, not a deletion.
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 2)
  }
)

databaseTest(
  'complete pagination surfaces every unacknowledged result, never only the newest page',
  (sandbox) => {
    prepareSandbox(sandbox)
    runFreshProcess(sandbox, 'crash-after-commit', { POS_ITEST_ATTEMPT_KEY: CLAIM_KEY })
    runFreshProcess(sandbox, 'crash-after-commit', { POS_ITEST_ATTEMPT_KEY: SECOND_KEY })

    // One row per page forces the cursor to be exercised rather than a single oversized read.
    const paged = runFreshProcess(sandbox, 'discover-paged')
    equal(paged.status, 0)
    deepEqual(paged.result?.keys, [CLAIM_KEY, SECOND_KEY])
    ok(Number(paged.result?.pages) >= 2, 'more than one page must actually have been fetched')
  }
)

databaseTest(
  'a committed result stays replayable for the same owner across a new session epoch',
  (sandbox) => {
    prepareSandbox(sandbox)
    runFreshProcess(sandbox, 'crash-after-commit', { POS_ITEST_ATTEMPT_KEY: CLAIM_KEY })

    const epochsBefore = readCommitted<{ value: number }>(
      sandbox,
      'SELECT value FROM session_epoch'
    )

    // Each fresh worker starts a new session, exactly as a real relaunch and re-login does.
    const discovered = runFreshProcess(sandbox, 'discover')
    deepEqual(discovered.result?.unacknowledgedKeys, [CLAIM_KEY])

    const epochsAfter = readCommitted<{ value: number }>(sandbox, 'SELECT value FROM session_epoch')
    ok(
      Number(epochsAfter[0]?.value) > Number(epochsBefore[0]?.value),
      'the recovering process must genuinely be a later session epoch'
    )

    // Plan §2.7: epoch is audit, never ownership — the exact owner still retrieves the result.
    const acknowledged = runFreshProcess(sandbox, 'acknowledge-first')
    equal((acknowledged.result?.acknowledged as Record<string, unknown>).outcome, 'acknowledged')
  }
)

databaseTest(
  'split-grant payload order is stable across insertion permutations, ANALYZE, and process restart',
  (sandbox) => {
    const lowUuid = '10000000-0000-4000-8000-000000000001'
    const highUuid = 'f0000000-0000-4000-8000-000000000001'
    const grant = (allocationUuid: string, serverSequence: number): NewStockAllocationGrant => ({
      allocationUuid,
      contractVersion: 1,
      companyUuid,
      deviceUuid,
      warehouseUuid,
      productUuid: trackedProductUuid,
      serverSequence,
      lifecycleGeneration: 1,
      grantedQuantityMilli: 500,
      consumeUntil: '2027-01-01T00:00:00.000Z',
      envelopeHash: allocationUuid === lowUuid ? 'a'.repeat(64) : 'b'.repeat(64),
      receivedAt: '2026-01-01T00:00:00.000Z'
    })
    const commit = (
      scopedSandbox: typeof sandbox,
      insertionOrder: readonly [string, string]
    ): readonly Record<string, unknown>[] => {
      const database = openTestDatabase(scopedSandbox)
      const repositories = realRepositories(database)
      const { localSale } = setUpAuthorizedContext(database, repositories)
      const grants = new Map([
        [lowUuid, grant(lowUuid, 2)],
        [highUuid, grant(highUuid, 1)]
      ])
      for (const allocationUuid of insertionOrder) {
        repositories.stockAllocations.upsertGrant(grants.get(allocationUuid)!)
      }

      const outcome = localSale.complete(
        CLAIM_KEY,
        validIntent({
          items: [
            {
              id: 'tracked-line',
              productUuid: trackedProductUuid,
              quantity: '1.000',
              discountType: null,
              discountValue: 0
            }
          ],
          payments: [
            { id: 'payment-1', paymentMethodUuid: methodUuid, amount: 500, reference: null }
          ]
        })
      )
      ok(outcome.outcome === 'committed')
      const queued = readCommitted<{ payload_json: string }>(
        scopedSandbox,
        "SELECT payload_json FROM sync_queue WHERE aggregate_type = 'invoice'"
      )[0]
      const payload = JSON.parse(queued?.payload_json ?? '{}') as {
        items?: { allocations?: Record<string, unknown>[] }[]
      }
      const allocations = payload.items?.[0]?.allocations ?? []
      deepEqual(
        allocations.map((entry) => entry.allocation_uuid),
        [lowUuid, highUuid]
      )
      closeDatabase(database)
      return allocations
    }

    // Both insertion permutations produce the same semantic allocation array. Grant-selection
    // order is highUuid then lowUuid (server sequence 1 then 2), deliberately unlike payload order.
    const primaryAllocations = commit(sandbox, [lowUuid, highUuid])
    const alternateSandbox = {
      ...sandbox,
      databasePath: `${sandbox.databasePath}.permuted`,
      register: <T>(value: T): T => value
    }
    const permutedAllocations = commit(alternateSandbox, [highUuid, lowUuid])
    deepEqual(permutedAllocations, primaryAllocations)

    const payloadBefore = tableDigest(sandbox, 'sync_queue')
    const storedBefore = readCommitted<{ payload_json: string; payload_hash: string }>(
      sandbox,
      "SELECT payload_json, payload_hash FROM sync_queue WHERE aggregate_type = 'invoice'"
    )[0]
    const database = openTestDatabase(sandbox)
    database.exec('ANALYZE')
    closeDatabase(database)
    equal(tableDigest(sandbox, 'sync_queue'), payloadBefore)
    deepEqual(
      readCommitted<{ payload_json: string; payload_hash: string }>(
        sandbox,
        "SELECT payload_json, payload_hash FROM sync_queue WHERE aggregate_type = 'invoice'"
      )[0],
      storedBefore
    )

    const replayed = runFreshProcess(sandbox, 'replay-first')
    equal(replayed.result?.outcome, 'committed')
    equal(replayed.result?.replay, true)
    equal(tableDigest(sandbox, 'sync_queue'), payloadBefore)
    deepEqual(
      readCommitted<{ payload_json: string; payload_hash: string }>(
        sandbox,
        "SELECT payload_json, payload_hash FROM sync_queue WHERE aggregate_type = 'invoice'"
      )[0],
      storedBefore
    )

    const acknowledged = runFreshProcess(sandbox, 'acknowledge-first')
    equal((acknowledged.result?.acknowledged as Record<string, unknown>).outcome, 'acknowledged')
    equal(tableDigest(sandbox, 'sync_queue'), payloadBefore)
  }
)
