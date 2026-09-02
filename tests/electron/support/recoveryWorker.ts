import { openSandboxDatabaseAtPath } from './openTestDatabase'
import { realRepositories } from './realRepositories'
import { setUpAuthorizedContext, validIntent } from './localSaleFixture'
import { failingDatabase } from './failingDatabase'

/**
 * The other side of `runFreshProcess()`: a standalone Electron-node process that rebuilds the
 * authorized context against an existing sandbox database and performs exactly one command.
 *
 * It holds no state from the parent process. Every attempt it acts on is discovered from
 * `pendingAttempts()` — the same read-only discovery channel the renderer's recovery banner uses —
 * never from a UUID passed in from the test, so these tests cannot accidentally prove recovery
 * using knowledge only the parent had. The one exception is `seed-*`, which is the *setup* half.
 *
 * `crash-*` commands hard-kill this process with `SIGKILL` at a chosen write boundary. That is a
 * real process death mid-transaction: nothing catches it, nothing unwinds, and whatever SQLite had
 * committed by then is what the next process finds.
 */

const RESULT_PREFIX = '@@RESULT@@'

function emit(value: Record<string, unknown>): void {
  console.log(RESULT_PREFIX + JSON.stringify(value))
}

const databasePath = process.env.POS_ITEST_DB_PATH
const command = process.env.POS_ITEST_COMMAND

if (!databasePath || !command) {
  throw new Error('recoveryWorker requires POS_ITEST_DB_PATH and POS_ITEST_COMMAND')
}

const database = openSandboxDatabaseAtPath(databasePath)
const repositories = realRepositories(database)
const preserveExistingSession =
  command === 'retry-discovered-same-session' || command === 'end-session'
const fixture = setUpAuthorizedContext(
  database,
  repositories,
  undefined,
  'online',
  !preserveExistingSession
)
const { localSale } = fixture

/** Strips row shapes down to what an assertion needs, so stdout stays a stable contract. */
function summarize(outcome: ReturnType<typeof localSale.complete>): Record<string, unknown> {
  if (outcome.outcome === 'committed' || outcome.outcome === 'acknowledged') {
    return {
      outcome: outcome.outcome,
      attemptKey: outcome.attemptKey,
      replay: outcome.replay,
      invoiceLocalUuid: outcome.invoice.localUuid,
      offlineNumber: outcome.invoice.offlineNumber,
      grandTotalAmount: outcome.invoice.grandTotalAmount,
      itemCount: outcome.items.length,
      paymentCount: outcome.payments.length
    }
  }

  return { ...outcome }
}

function discovery(): Record<string, unknown> {
  const pending = localSale.pendingAttempts()
  return {
    blockingAttemptKey: pending.blockingAttempt?.attemptKey ?? null,
    unacknowledgedKeys: pending.unacknowledgedResults.map((row) => row.attemptKey),
    nextCursor: pending.nextCursor
  }
}

try {
  switch (command) {
    /** Setup only: claim and commit one sale so the parent can inspect the durable result. */
    case 'seed-committed': {
      const key = process.env.POS_ITEST_ATTEMPT_KEY
      if (!key) {
        throw new Error('seed-committed requires POS_ITEST_ATTEMPT_KEY')
      }
      emit(summarize(localSale.complete(key, validIntent())))
      break
    }

    /**
     * Crash *before* the business commit: claim durably, then hard-kill this process at the first
     * write of the business transaction. Leaves the plan's `claimed` + no-invoice shape on disk.
     */
    case 'crash-before-commit': {
      const key = process.env.POS_ITEST_ATTEMPT_KEY
      if (!key) {
        throw new Error('crash-before-commit requires POS_ITEST_ATTEMPT_KEY')
      }
      const boundary = Number(process.env.POS_ITEST_KILL_ON_WRITE ?? '2')
      const killing = fixture.withWriteDatabase(
        failingDatabase(database, {
          // Never reached: the kill happens in `onWrite` first. A real crash is not an exception.
          failOnWriteNumber: -1,
          onWrite: (writeNumber) => {
            if (writeNumber === boundary) {
              process.kill(process.pid, 'SIGKILL')
            }
          }
        })
      )
      killing.complete(key, validIntent())
      emit({ outcome: 'survived-the-kill-boundary' })
      break
    }

    /**
     * Crash *after* the business commit but before the caller could ever see the result — the
     * "lost reply" boundary. The sale is durable; nothing acknowledged it.
     */
    case 'crash-after-commit': {
      const key = process.env.POS_ITEST_ATTEMPT_KEY
      if (!key) {
        throw new Error('crash-after-commit requires POS_ITEST_ATTEMPT_KEY')
      }
      localSale.complete(key, validIntent())
      process.kill(process.pid, 'SIGKILL')
      emit({ outcome: 'survived-the-kill-boundary' })
      break
    }

    /** Read-only discovery from on-disk state alone. */
    case 'discover': {
      emit(discovery())
      break
    }

    /** Retry whatever blocking attempt this owner has, discovered from disk. */
    case 'retry-discovered':
    case 'retry-discovered-same-session': {
      const pending = localSale.pendingAttempts()
      const key = pending.blockingAttempt?.attemptKey

      if (!key) {
        emit({ outcome: 'nothing-to-retry' })
        break
      }

      emit(summarize(localSale.retry(key)))
      break
    }

    /** End the persisted session without creating a replacement session first. */
    case 'end-session': {
      fixture.session.endSession()
      emit({ outcome: 'session-ended', epoch: repositories.sessionEpoch.current() })
      break
    }

    /** Replay the first committed result discovered from disk, with no retained key or draft. */
    case 'replay-first': {
      const pending = localSale.pendingAttempts()
      const [first] = pending.unacknowledgedResults

      if (!first) {
        emit({ outcome: 'nothing-to-replay' })
        break
      }

      emit(summarize(localSale.retry(first.attemptKey)))
      break
    }

    /** Abandon whatever blocking attempt this owner has, discovered from disk. */
    case 'abandon-discovered': {
      const pending = localSale.pendingAttempts()
      const key = pending.blockingAttempt?.attemptKey

      if (!key) {
        emit({ outcome: 'nothing-to-abandon' })
        break
      }

      emit(summarize(localSale.abandon(key)))
      break
    }

    /** Acknowledge exactly one discovered unacknowledged result, then re-report what remains. */
    case 'acknowledge-first': {
      const before = localSale.pendingAttempts()
      const [first] = before.unacknowledgedResults

      if (!first) {
        emit({ outcome: 'nothing-to-acknowledge' })
        break
      }

      const acknowledged = summarize(localSale.acknowledge(first.attemptKey))
      emit({ acknowledged, remaining: discovery() })
      break
    }

    /** Pages through every unacknowledged result one row at a time, exhausting the cursor. */
    case 'discover-paged': {
      const keys: string[] = []
      let cursor = null as { readonly committedAt: string; readonly attemptKey: string } | null
      let pages = 0

      do {
        const page = localSale.pendingAttempts(1, cursor)
        for (const row of page.unacknowledgedResults) {
          keys.push(row.attemptKey)
        }
        cursor = page.nextCursor
        pages += 1
      } while (cursor && pages < 20)

      emit({ keys, pages })
      break
    }

    default:
      throw new Error(`Unknown recoveryWorker command: ${command}`)
  }

  database.close()
} catch (error) {
  database.close()
  emit({ outcome: 'worker-error', message: error instanceof Error ? error.message : String(error) })
  process.exitCode = 1
}
