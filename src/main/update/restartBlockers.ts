import type { SqliteDatabase } from '../database/connection'
import type { RestartBlocker } from '@shared/contracts/update.contract'

export interface RestartActivityGate {
  /** Every window reported an empty, idle draft (no cart lines, held drafts or payment on screen). */
  draftIdle(): boolean
  /** A claimed sale attempt or a completion in flight. */
  paymentActive(): boolean
  /** A catalog snapshot is being installed (or held for the cashier's consent). */
  isHoldActive(): boolean
}

function count(database: SqliteDatabase, sql: string): number {
  return (database.prepare(sql).get() as { n: number }).n
}

/**
 * What an update restart would interrupt right now (read-only). Durable, queued work (pending sales,
 * prepared or unresolved refunds, pending quick-create requests, queued receipts) is not listed:
 * it survives the upgrade in the database and continues afterwards.
 */
export function readRestartBlockers(
  database: SqliteDatabase,
  gate: RestartActivityGate
): RestartBlocker[] {
  const blockers: RestartBlocker[] = []

  if (!gate.draftIdle() || gate.paymentActive()) {
    blockers.push('sale_in_progress')
  }
  if (
    count(
      database,
      "SELECT COUNT(*) AS n FROM local_refunds WHERE submission_state = 'dispatched'"
    ) > 0
  ) {
    blockers.push('refund_in_flight')
  }
  if (
    count(
      database,
      "SELECT COUNT(*) AS n FROM receipt_print_jobs WHERE status IN ('queued', 'preparing', 'dispatching')"
    ) > 0
  ) {
    blockers.push('print_in_progress')
  }
  if (
    count(database, "SELECT COUNT(*) AS n FROM sync_queue WHERE state = 'uploading'") +
      count(
        database,
        "SELECT COUNT(*) AS n FROM entity_create_outbox WHERE state = 'dispatching'"
      ) >
    0
  ) {
    blockers.push('upload_in_flight')
  }
  if (gate.isHoldActive()) {
    blockers.push('catalog_install')
  }

  return blockers
}
