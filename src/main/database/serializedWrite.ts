import type { SqliteDatabase } from './connection'

/**
 * BH-04B-3: the writer boundary for any transaction whose decision depends on what it reads.
 *
 * `better-sqlite3`'s `database.transaction(fn)()` issues a plain `BEGIN`, which is DEFERRED: the
 * read snapshot is taken before write authority is acquired, and the upgrade to a write lock happens
 * at the first write. Today this app runs one connection in one main process, so nothing else can
 * interleave — but that is a property of the current process layout, not of the database boundary,
 * and BH-04A §10.2 asks for the invariant to hold at the boundary itself.
 *
 * `BEGIN IMMEDIATE` takes write authority up front, so every read inside the closure already sees
 * the state this transaction will commit against. A second connection or process contending for the
 * write lock fails at `BEGIN` rather than partway through, which is what makes the restart below
 * sound: the closure has written nothing yet, so re-running it re-reads eligibility, the accepted
 * coverage boundary and local consumption from scratch.
 *
 * The restart is the important half. A retry that reused a balance computed before write authority
 * was held would be exactly the double-spend this contract exists to prevent, so this helper never
 * caches anything across attempts and never passes partial results between them.
 *
 * `busy_timeout = 5000` (set on the connection) still does the waiting; this only bounds how many
 * times a genuinely contended transaction is restarted before the failure is surfaced to the caller
 * as an ordinary storage failure.
 */
const MAX_ATTEMPTS = 5

export function isSqliteContention(error: unknown): boolean {
  const code = (error as { readonly code?: unknown } | null)?.code

  return (
    typeof code === 'string' && (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED'))
  )
}

/**
 * Runs `work` inside one `BEGIN IMMEDIATE` transaction, restarting it when the *transaction itself*
 * could not be started because another writer held the lock.
 *
 * The restart is deliberately narrow. It applies only when `BEGIN IMMEDIATE` failed — better-sqlite3
 * throws before it ever invokes the closure, so no statement ran, nothing was read, and no decision
 * exists to be stale. That is the one case where re-running is unambiguously equivalent to having
 * waited longer.
 *
 * Contention raised *inside* the closure is not retried here. Its transaction has rolled back, so
 * nothing was written, but the caller has already begun computing a decision from reads this helper
 * cannot see; silently re-running it would blur the line between "we waited" and "we recomputed".
 * It propagates instead, and `LocalSaleService` classifies it as a storage failure that leaves the
 * sale attempt claimed and retryable — a retry that re-enters the whole attempt and re-reads
 * everything from scratch. Either way, no balance computed before write authority was held is ever
 * reused.
 *
 * Anything that is not contention propagates immediately, so a business rejection or an invariant
 * violation still rolls back once and reaches the caller unchanged.
 */
export function runSerializedWrite<T>(database: SqliteDatabase, work: () => T): T {
  let entered = false
  const transaction = database.transaction(() => {
    entered = true

    return work()
  }).immediate

  for (let attempt = 1; ; attempt++) {
    entered = false

    try {
      return transaction()
    } catch (error) {
      if (entered || attempt >= MAX_ATTEMPTS || !isSqliteContention(error)) {
        throw error
      }
      // Loop. The closure never ran, so there is nothing from the failed attempt to carry forward.
    }
  }
}
