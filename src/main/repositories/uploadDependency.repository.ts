import type { SqliteDatabase } from '../database/connection'

/**
 * Rev 4 §10.3 — allocation-chain upload dependencies.
 *
 * The server accepts consumption `s` on chain `(allocation_uuid, rights_generation)` only when its
 * last accepted sequence on that chain is `s − 1`; anything else quarantines permanently as
 * `allocation_sequence_gap`. So an invoice whose first consumption on a chain is `s` may be SENT only
 * once there is verified server evidence that the predecessor `s − 1` — held by another local
 * invoice — was applied:
 *
 *  - that consumption row is `acknowledged` (the server returned its consumption id), or
 *  - the predecessor invoice's upload is `synced` (201, or the duplicate 200 of an identical replay),
 *  - a coverage boundary (bootstrap / top-up / upload response) accepted `≥ s − 1` on the same chain
 *    AND its `accepted_chain_hash` equals the local `chain_hash` at that sequence, or
 *  - the chain carries a durable disposition chain-break hold (PS6b: an applied server disposition
 *    broke the chain; dependents then upload unchanged and quarantine independently).
 *
 * Several consumptions of one chain inside ONE invoice (§10.3a) are possible — the split drains
 * grants per line and numbers each consumption in the same serialized commit — so only the chain's
 * EXTERNAL predecessor is required, and the invoice's own sequences must be contiguous (they are by
 * construction; a gap is reported, never guessed through).
 *
 * Read-only. Nothing here renumbers, re-keys, rewrites, requeues or releases a row.
 */

export type UploadDependencyBlock =
  /** Predecessor still pending/uploading/retrying: released automatically. */
  | 'predecessor-pending'
  /** Predecessor rejected/conflict with no release evidence: needs support. */
  | 'predecessor-terminal'
  /** The invoice's own sequences on a chain are not contiguous (local integrity). */
  | 'non-contiguous'

export interface UploadDependencyPredecessor {
  readonly allocationUuid: string
  readonly rightsGeneration: number | null
  readonly sequence: number
  readonly invoiceLocalUuid: string
  readonly queueState: string | null
}

export type UploadDependencyDecision =
  | { readonly eligible: true }
  | {
      readonly eligible: false
      readonly block: UploadDependencyBlock
      readonly predecessor: UploadDependencyPredecessor | null
    }

export interface HeldUpload {
  readonly invoiceLocalUuid: string
  readonly userUuid: string
  readonly localQueueUuid: string
  readonly createdAt: string
  readonly block: UploadDependencyBlock
  readonly predecessor: UploadDependencyPredecessor | null
}

interface ConsumptionRow {
  readonly allocation_uuid: string
  readonly rights_generation: number | null
  readonly consumption_sequence: number
}

interface PredecessorRow {
  readonly invoice_local_uuid: string
  readonly rights_generation: number | null
  readonly server_status: string
  readonly queue_state: string | null
}

const TERMINAL_QUEUE_STATES = new Set(['rejected', 'conflict'])

export class UploadDependencyRepository {
  constructor(private readonly database: SqliteDatabase) {}

  evaluate(invoiceLocalUuid: string): UploadDependencyDecision {
    const consumptions = this.database
      .prepare(
        `SELECT allocation_uuid, rights_generation, consumption_sequence
           FROM local_stock_allocation_consumptions
          WHERE invoice_local_uuid = ?
          ORDER BY allocation_uuid ASC, consumption_sequence ASC`
      )
      .all(invoiceLocalUuid) as ConsumptionRow[]

    const chains = new Map<string, ConsumptionRow[]>()
    for (const row of consumptions) {
      const key = `${row.allocation_uuid}|${row.rights_generation ?? ''}`
      const list = chains.get(key)
      if (list) {
        list.push(row)
      } else {
        chains.set(key, [row])
      }
    }

    for (const rows of chains.values()) {
      for (let index = 1; index < rows.length; index += 1) {
        if (rows[index].consumption_sequence !== rows[index - 1].consumption_sequence + 1) {
          return { eligible: false, block: 'non-contiguous', predecessor: null }
        }
      }

      const first = rows[0]
      const decision = this.externalPredecessor(invoiceLocalUuid, first)
      if (!decision.eligible) {
        return decision
      }
    }

    return { eligible: true }
  }

  /**
   * This owner's queued invoice uploads that are held indefinitely (a terminal predecessor with no
   * release evidence, or a local sequence gap) — the `upload-held-by-predecessor` support state.
   */
  listHeld(
    owner: { readonly companyUuid: string; readonly deviceUuid: string },
    limit: number
  ): HeldUpload[] {
    const rows = this.database
      .prepare(
        `SELECT q.local_queue_uuid, q.local_aggregate_uuid, q.created_at, i.user_uuid
           FROM sync_queue q
           JOIN local_invoices i ON i.local_uuid = q.local_aggregate_uuid
          WHERE q.aggregate_type = 'invoice' AND q.operation = 'upload'
            AND q.state IN ('pending', 'retryable_error')
            AND i.company_uuid = ? AND i.device_uuid = ?
            AND EXISTS (
              SELECT 1 FROM local_stock_allocation_consumptions c
               WHERE c.invoice_local_uuid = q.local_aggregate_uuid
            )
          ORDER BY q.queue_sequence IS NULL, q.queue_sequence ASC, q.created_at ASC,
                   q.local_queue_uuid ASC`
      )
      .all(owner.companyUuid, owner.deviceUuid) as {
      readonly local_queue_uuid: string
      readonly local_aggregate_uuid: string
      readonly created_at: string
      readonly user_uuid: string
    }[]

    const held: HeldUpload[] = []
    for (const row of rows) {
      const decision = this.evaluate(row.local_aggregate_uuid)
      if (!decision.eligible && decision.block !== 'predecessor-pending') {
        held.push({
          invoiceLocalUuid: row.local_aggregate_uuid,
          userUuid: row.user_uuid,
          localQueueUuid: row.local_queue_uuid,
          createdAt: row.created_at,
          block: decision.block,
          predecessor: decision.predecessor
        })
        if (held.length >= limit) {
          break
        }
      }
    }
    return held
  }

  private externalPredecessor(
    invoiceLocalUuid: string,
    first: ConsumptionRow
  ): UploadDependencyDecision {
    const sequence = first.consumption_sequence - 1
    if (sequence < 1) {
      return { eligible: true }
    }

    // Local sequences are unique per allocation, so (allocation, s − 1) names at most one row.
    const predecessor = this.database
      .prepare(
        `SELECT c.invoice_local_uuid, c.rights_generation, c.server_status,
                (SELECT q.state FROM sync_queue q
                  WHERE q.aggregate_type = 'invoice' AND q.operation = 'upload'
                    AND q.local_aggregate_uuid = c.invoice_local_uuid
                  LIMIT 1) AS queue_state
           FROM local_stock_allocation_consumptions c
          WHERE c.allocation_uuid = ? AND c.consumption_sequence = ?`
      )
      .get(first.allocation_uuid, sequence) as PredecessorRow | undefined

    if (
      !predecessor ||
      predecessor.invoice_local_uuid === invoiceLocalUuid ||
      (predecessor.rights_generation !== null &&
        first.rights_generation !== null &&
        predecessor.rights_generation !== first.rights_generation)
    ) {
      // No local predecessor on this chain: there is nothing on this device to wait for.
      return { eligible: true }
    }

    if (predecessor.server_status === 'acknowledged' || predecessor.queue_state === 'synced') {
      return { eligible: true }
    }

    if (first.rights_generation !== null) {
      if (this.coverageReaches(first.allocation_uuid, first.rights_generation, sequence)) {
        return { eligible: true }
      }
      if (this.hasChainBreakHold(first.allocation_uuid, first.rights_generation)) {
        return { eligible: true }
      }
    }

    return {
      eligible: false,
      block:
        predecessor.queue_state !== null && TERMINAL_QUEUE_STATES.has(predecessor.queue_state)
          ? 'predecessor-terminal'
          : 'predecessor-pending',
      predecessor: {
        allocationUuid: first.allocation_uuid,
        rightsGeneration: first.rights_generation,
        sequence,
        invoiceLocalUuid: predecessor.invoice_local_uuid,
        queueState: predecessor.queue_state
      }
    }
  }

  /** A boundary is progress only when its chain hash matches the local chain at that sequence. */
  private coverageReaches(allocationUuid: string, generation: number, sequence: number): boolean {
    const boundary = this.database
      .prepare(
        `SELECT accepted_consumption_sequence AS accepted, accepted_chain_hash AS hash
           FROM stock_allocation_coverage_boundaries
          WHERE allocation_uuid = ? AND rights_generation = ?`
      )
      .get(allocationUuid, generation) as { accepted: number; hash: string } | undefined

    if (!boundary || boundary.accepted < sequence) {
      return false
    }

    const local = this.database
      .prepare(
        `SELECT chain_hash FROM local_stock_allocation_consumptions
          WHERE allocation_uuid = ? AND rights_generation = ? AND consumption_sequence = ?`
      )
      .get(allocationUuid, generation, boundary.accepted) as
      { chain_hash: string | null } | undefined

    return local?.chain_hash !== null && local?.chain_hash === boundary.hash
  }

  private hasChainBreakHold(allocationUuid: string, generation: number): boolean {
    return (
      this.database
        .prepare(
          `SELECT 1 FROM stock_allocation_disposition_holds
            WHERE allocation_uuid = ? AND rights_generation = ?`
        )
        .get(allocationUuid, generation) !== undefined
    )
  }
}
