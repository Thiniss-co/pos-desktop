import { createHash, randomUUID } from 'crypto'
import {
  type DispositionConflictCode,
  type DispositionEnvelope,
  type SyncStatusEntry,
  dispositionEnvelopeSchema
} from '@shared/contracts/dispositionDiscovery.contract'
import type { SqliteDatabase } from '../database/connection'
import { runSerializedWrite } from '../database/serializedWrite'
import { allocationItemLineUuid } from './allocationJournal'
import { invoiceRequestHash, isPhysicalPresenceContractVersion } from './invoiceRequestHash'

/** The exact quarantine reasons a disposition may act on (§7.3a.2). Closed on purpose. */
export const ELIGIBLE_QUARANTINE_REASONS: ReadonlySet<string> = new Set([
  'allocation_not_owned',
  'allocation_generation_mismatch',
  'allocation_sequence_gap',
  'allocation_insufficient_rights',
  'allocation_expired_at_sale_time'
])

/**
 * The backend's `DispositionOverrideReason` cases: the five classification failures, plus
 * `prefix_broken` (every later proof on an identity whose prefix already broke) and
 * `permanent_rejection` (every proof of a `reject_permanently` decision).
 */
const CLASSIFICATION_OVERRIDE_REASONS: ReadonlySet<string> = ELIGIBLE_QUARANTINE_REASONS

/**
 * PHP `json_encode($value)` with its default flags, which is what the backend hashes
 * (`DesktopInvoiceDisposition::canonicalResultHash()`).
 *
 * Key order is NOT taken from the wire. On MySQL the `result_snapshot` JSON column re-sorts object
 * keys on read, while the backend stamped the hash over its in-memory insertion order. The caller
 * therefore passes the strictly parsed result, whose keys Zod emits in schema order, and the schema
 * declares the backend's insertion order field for field. What remains is the escaping PHP applies by
 * default and `JSON.stringify` does not: `/` becomes `\/`, and every non-ASCII UTF-16 code unit
 * becomes a lowercase `\uXXXX` escape (a surrogate pair as two escapes, as PHP writes it).
 */
export function phpJsonEncode(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\//g, '\\/')
    .replace(/[\u0080-￿]/g, (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

interface ExpectedProof {
  readonly line_index: number
  readonly proof_index: number
  readonly allocation_uuid: string
  readonly rights_generation: number
  readonly consumption_sequence: number
  readonly local_consumption_uuid: string
  readonly item_line_uuid: string
  readonly quantity_milli: number
  readonly request_hash: string
}

const PROOF_IDENTITY_FIELDS = [
  'line_index',
  'proof_index',
  'allocation_uuid',
  'rights_generation',
  'consumption_sequence',
  'local_consumption_uuid',
  'item_line_uuid',
  'quantity_milli',
  'request_hash'
] as const satisfies ReadonlyArray<keyof ExpectedProof>

function identityKey(proof: {
  readonly allocation_uuid: string
  readonly rights_generation: number
}): string {
  return `${proof.allocation_uuid}#${proof.rights_generation}`
}

export interface DispositionDiscoveryOwner {
  readonly companyUuid: string
  readonly deviceUuid: string
}

export interface DispositionCandidate {
  readonly invoiceLocalUuid: string
  readonly idempotencyKey: string
  readonly localQueueUuid: string
  readonly payloadJson: string
  readonly payloadHash: string
  readonly quarantineReason: string
  readonly queueFailureJson: string
}

export type DispositionApplyResult =
  | { readonly kind: 'applied'; readonly invoiceLocalUuid: string }
  | { readonly kind: 'noop'; readonly invoiceLocalUuid: string }
  | {
      readonly kind: 'conflict'
      readonly invoiceLocalUuid: string
      readonly code: DispositionConflictCode
    }

export interface InvoiceDispositionDiscoveryDependencies {
  readonly database: SqliteDatabase
  readonly now?: () => Date
  readonly createUuid?: () => string
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * PS6b §7.3a.4–§7.3a.6 — discover an authoritative operator decision and converge on it, once.
 *
 * ## Candidate selection is exact, not "anything terminal"
 *
 * A candidate must satisfy ALL of: the queue row and the local invoice are both `rejected`; the
 * persisted backend code is exactly `DESKTOP_INVOICE_QUARANTINED`; the persisted reason is one of
 * five allocation reasons; the frozen payload parses as v3 with a physical-presence authority and
 * still recomputes to its stored hashes; and no application or conflict already finalizes the row.
 *
 * Everything else is never queried — `DESKTOP_ALLOCATION_PROOF_REQUIRED`, invalid authority,
 * ordinary validation, catalog, contract, attribution failures, and every conflict. The allowlist is
 * closed rather than "everything except", because an "except" rule silently admits each new failure
 * mode someone adds later, and this path can commit a sale.
 *
 * Message text is never interpreted. An ambiguous legacy row stays ambiguous until an ordinary
 * immutable retry obtains the backend's own stored classification (§7.3a.4).
 *
 * ## What convergence deliberately does NOT do
 *
 * It never updates or widens `local_stock_allocation_consumptions`. Overridden rows stay `pending`
 * immutable journal evidence and keep counting against committed quantity; `committedQuantityAboveSequence()`,
 * `nextConsumptionSequence()` and the chain hash are untouched. The allocation identity is denied
 * instead through an independent hold, because excluding a row from a quantity sum cannot repair a
 * broken sequence or reproduce a hash (§7.3a.6).
 */
export class InvoiceDispositionDiscoveryService {
  private readonly now: () => Date
  private readonly createUuid: () => string

  constructor(private readonly dependencies: InvoiceDispositionDiscoveryDependencies) {
    this.now = dependencies.now ?? (() => new Date())
    this.createUuid = dependencies.createUuid ?? randomUUID
  }

  /**
   * Owner-scoped candidates, bounded.
   *
   * The limit is not a performance concern: discovery runs are main-owned and bounded (once at
   * startup, once per debounced reconnect, and explicitly for at most the visible failure page), and
   * an unbounded sweep would turn a narrow convergence step into a bulk history walk.
   */
  findCandidates(owner: DispositionDiscoveryOwner, limit = 50): readonly DispositionCandidate[] {
    const rows = this.dependencies.database
      .prepare(
        `SELECT i.local_uuid          AS invoice_local_uuid,
                q.local_queue_uuid    AS local_queue_uuid,
                q.idempotency_key     AS idempotency_key,
                q.payload_json        AS payload_json,
                q.payload_hash        AS payload_hash,
                q.last_error_details  AS last_error_details
           FROM local_invoices i
           JOIN sync_queue q
             ON q.local_aggregate_uuid = i.local_uuid
            AND q.aggregate_type = 'invoice'
            AND q.operation = 'upload'
          WHERE i.company_uuid = ?
            AND i.device_uuid = ?
            AND i.sync_status = 'rejected'
            AND q.state = 'rejected'
            AND i.offline_sale_authority_uuid IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM invoice_disposition_applications a
               WHERE a.invoice_local_uuid = i.local_uuid
            )
            AND NOT EXISTS (
              SELECT 1 FROM invoice_disposition_conflicts c
               WHERE c.invoice_local_uuid = i.local_uuid
            )
          ORDER BY i.created_at ASC
          LIMIT ?`
      )
      .all(owner.companyUuid, owner.deviceUuid, limit) as Array<Record<string, unknown>>

    const candidates: DispositionCandidate[] = []

    for (const row of rows) {
      const failureJson = (row.last_error_details ?? null) as string | null

      if (failureJson === null) {
        continue
      }

      let failure: Record<string, unknown>

      try {
        failure = JSON.parse(failureJson) as Record<string, unknown>
      } catch {
        continue
      }

      // The exact backend code, persisted by PS4 — never inferred from the message.
      if (failure.backendCode !== 'DESKTOP_INVOICE_QUARANTINED') {
        continue
      }

      const reason = failure.quarantineReason

      // A row PS4 marked as a reason contract error is deliberately NOT a candidate: "we could not
      // read the reason" is not the same as "the reason was one of the five".
      if (typeof reason !== 'string' || !ELIGIBLE_QUARANTINE_REASONS.has(reason)) {
        continue
      }

      const payloadJson = row.payload_json as string

      // The frozen payload must still be the bytes that produced the stored hash, and must still
      // declare v3 with an authority. A payload that no longer verifies is not evidence.
      if (sha256(payloadJson) !== row.payload_hash) {
        continue
      }

      let payload: Record<string, unknown>

      try {
        payload = JSON.parse(payloadJson) as Record<string, unknown>
      } catch {
        continue
      }

      if (
        // v3, v5 (mixed taxes) or v7 (offers): the physical-presence contracts.
        !isPhysicalPresenceContractVersion(payload.client_contract_version) ||
        typeof payload.offline_sale_authority_uuid !== 'string'
      ) {
        continue
      }

      candidates.push({
        invoiceLocalUuid: row.invoice_local_uuid as string,
        idempotencyKey: row.idempotency_key as string,
        localQueueUuid: row.local_queue_uuid as string,
        payloadJson,
        payloadHash: row.payload_hash as string,
        quarantineReason: reason,
        queueFailureJson: failureJson
      })
    }

    return candidates
  }

  /**
   * Verify a discovered decision and apply it atomically, or record a durable conflict.
   *
   * Every check runs INSIDE the write transaction, after re-reading the row: a decision verified
   * against state read before the transaction opened would be verified against state that may no
   * longer hold.
   */
  apply(
    owner: DispositionDiscoveryOwner,
    candidate: DispositionCandidate,
    entry: SyncStatusEntry
  ): DispositionApplyResult {
    const parsed = dispositionEnvelopeSchema.safeParse(entry.disposition)

    if (!parsed.success) {
      return this.conflict(candidate, null, 'malformed-result', {
        issues: parsed.error.issues.slice(0, 5)
      })
    }

    const envelope = parsed.data

    return runSerializedWrite(this.dependencies.database, () => {
      const invoice = this.dependencies.database
        .prepare('SELECT * FROM local_invoices WHERE local_uuid = ?')
        .get(candidate.invoiceLocalUuid) as Record<string, unknown> | undefined

      // Owner re-checked inside the transaction, not merely at selection time.
      if (
        !invoice ||
        invoice.company_uuid !== owner.companyUuid ||
        invoice.device_uuid !== owner.deviceUuid
      ) {
        return { kind: 'noop' as const, invoiceLocalUuid: candidate.invoiceLocalUuid }
      }

      const existing = this.dependencies.database
        .prepare('SELECT * FROM invoice_disposition_applications WHERE invoice_local_uuid = ?')
        .get(candidate.invoiceLocalUuid) as Record<string, unknown> | undefined

      // Checked BEFORE the sync-status guard below, deliberately. An accepted decision leaves the
      // invoice `synced`, so a status-first check would report a genuinely CONFLICTING second
      // decision as a bland no-op and lose the evidence. Decision identity is the question here;
      // the resulting status is a consequence of it.
      if (existing) {
        // An exact rediscovery is a no-op. A DIFFERENT decision for the same invoice, or the same
        // UUID with different bytes, is a conflict — never an overwrite.
        return existing.disposition_uuid === envelope.id &&
          existing.result_hash === envelope.result_hash
          ? { kind: 'noop' as const, invoiceLocalUuid: candidate.invoiceLocalUuid }
          : this.conflict(candidate, envelope.id, 'conflicting-disposition', {
              storedDispositionUuid: existing.disposition_uuid,
              storedResultHash: existing.result_hash
            })
      }

      // Only a still-rejected invoice with no prior decision may be converged.
      if (invoice.sync_status !== 'rejected') {
        return { kind: 'noop' as const, invoiceLocalUuid: candidate.invoiceLocalUuid }
      }

      const verification = this.verify(candidate, envelope, invoice, entry)

      if (verification !== null) {
        return this.conflict(candidate, envelope.id, verification.code, verification.detail)
      }

      return this.commit(candidate, envelope)
    })
  }

  /**
   * The complete §7.3a.5 verification. Returns null when everything holds.
   *
   * Ordered cheapest-first, but every check is mandatory: none is a heuristic and none may be
   * skipped because an earlier one passed.
   */
  private verify(
    candidate: DispositionCandidate,
    envelope: DispositionEnvelope,
    invoice: Record<string, unknown>,
    entry: SyncStatusEntry
  ): { code: DispositionConflictCode; detail: Record<string, unknown> } | null {
    const result = envelope.result

    // 1. The result hash covers the canonical result excluding itself, encoded exactly as the
    //    backend encodes it (see `phpJsonEncode`). The envelope repeats the decision and its time;
    //    both copies must agree.
    if (sha256(phpJsonEncode(result)) !== envelope.result_hash) {
      return { code: 'result-hash-mismatch', detail: { dispositionUuid: envelope.id } }
    }

    if (envelope.decision !== result.decision || envelope.decided_at !== result.decided_at) {
      return { code: 'binding-mismatch', detail: { reason: 'envelope-disagrees-with-result' } }
    }

    let payload: Record<string, unknown>

    try {
      payload = JSON.parse(candidate.payloadJson) as Record<string, unknown>
    } catch {
      return { code: 'payload-hash-mismatch', detail: { reason: 'payload-unparseable' } }
    }

    // 2. Exact identity binding. A decision about a different sale must never reach this one.
    if (
      result.binding.idempotency_key !== candidate.idempotencyKey ||
      result.binding.local_invoice_uuid !== candidate.invoiceLocalUuid ||
      result.binding.client_contract_version !== payload.client_contract_version ||
      result.binding.offline_sale_authority_uuid !== invoice.offline_sale_authority_uuid
    ) {
      return { code: 'binding-mismatch', detail: { binding: result.binding } }
    }

    // The status read must tell the same story as the decision: an acceptance processed the upload
    // into exactly the decided invoice, a permanent rejection left it quarantined with none.
    const accepting = result.decision === 'accept_without_proof'

    if (
      entry.idempotency_key !== candidate.idempotencyKey ||
      (entry.local_invoice_uuid !== undefined &&
        entry.local_invoice_uuid !== candidate.invoiceLocalUuid) ||
      entry.status !== (accepting ? 'processed' : 'quarantined') ||
      (accepting ? result.invoice === null : result.invoice !== null) ||
      (entry.invoice !== undefined &&
        (entry.invoice?.invoice_uuid ?? null) !== (result.invoice?.invoice_uuid ?? null))
    ) {
      return {
        code: 'binding-mismatch',
        detail: { status: entry.status, decision: result.decision }
      }
    }

    // 3. Recomputed from the IMMUTABLE payload, not from the stored request hash: this proves the
    //    server decided about the same bytes this device still holds.
    let recomputed: string

    try {
      recomputed = invoiceRequestHash(payload as never)
    } catch {
      return { code: 'payload-hash-mismatch', detail: { reason: 'payload-unparseable' } }
    }

    if (recomputed !== result.binding.request_hash) {
      return {
        code: 'payload-hash-mismatch',
        detail: { recomputed, reported: result.binding.request_hash }
      }
    }

    // 4. Complete set-and-order equality between the frozen payload's proofs and `proof_results[]`,
    //    in the order the backend enumerates them. Duplicates, omissions and additions are invalid.
    const expected = this.expectedProofs(candidate, payload, recomputed)

    if (expected.length !== result.proof_results.length) {
      return {
        code: 'proof-set-mismatch',
        detail: { frozen: expected.length, reported: result.proof_results.length }
      }
    }

    for (let index = 0; index < expected.length; index += 1) {
      const want = expected[index]
      const actual = result.proof_results[index]
      const field = PROOF_IDENTITY_FIELDS.find((name) => want[name] !== actual[name])

      if (field !== undefined) {
        return { code: 'proof-set-mismatch', detail: { index, field } }
      }
    }

    // ...and every frozen proof is still this invoice's own row in the immutable local journal.
    const journalMismatch = this.journalMismatch(candidate.invoiceLocalUuid, expected)

    if (journalMismatch !== null) {
      return { code: 'proof-set-mismatch', detail: journalMismatch }
    }

    // 5. Outcome shape. An overridden proof never has a server consumption and always names one of
    //    the backend's override reasons; an accepted one names none. The backend does not report the
    //    server consumption UUID of an accepted proof (it stores `null`; DesktopInvoiceDisposition
    //    Test asserts it), so an accepted proof may carry `null` or a UUID — it is acknowledged
    //    later through ordinary verified coverage, never by this step.
    for (const proof of result.proof_results) {
      const shapeValid =
        proof.outcome === 'accepted'
          ? proof.override_reason === null
          : proof.server_consumption_uuid === null &&
            proof.override_reason !== null &&
            (accepting
              ? proof.override_reason === 'prefix_broken' ||
                CLASSIFICATION_OVERRIDE_REASONS.has(proof.override_reason)
              : proof.override_reason === 'permanent_rejection')

      if (!shapeValid) {
        return {
          code: 'proof-set-mismatch',
          detail: { sequence: proof.consumption_sequence, outcome: proof.outcome }
        }
      }
    }

    // 6. A permanent rejection may contain no accepted proof at all.
    if (!accepting && result.proof_results.some((proof) => proof.outcome === 'accepted')) {
      return { code: 'rejection-contains-accepted-proof', detail: {} }
    }

    // 7. The per-identity prefix rule, and the coverage and hold instructions it implies. Within one
    //    identity (in sequence order) accepted proofs form a prefix; the first overridden proof is
    //    the hold's `first_overridden_sequence` and every later one is `prefix_broken`. Coverage is
    //    the accepted prefix of THIS invoice, captured at decision time.
    const identities = new Map<
      string,
      {
        allocationUuid: string
        rightsGeneration: number
        acceptedSequence: number | null
        acceptedQuantityMilli: number
        firstOverriddenSequence: number | null
      }
    >()

    for (const proof of result.proof_results) {
      const key = identityKey(proof)
      const state = identities.get(key) ?? {
        allocationUuid: proof.allocation_uuid,
        rightsGeneration: proof.rights_generation,
        acceptedSequence: null,
        acceptedQuantityMilli: 0,
        firstOverriddenSequence: null
      }

      if (proof.outcome === 'accepted') {
        if (state.firstOverriddenSequence !== null) {
          return { code: 'coverage-prefix-unverified', detail: { identity: key } }
        }

        state.acceptedSequence = proof.consumption_sequence
        state.acceptedQuantityMilli += proof.quantity_milli
      } else if (state.firstOverriddenSequence === null) {
        if (accepting && proof.override_reason === 'prefix_broken') {
          return { code: 'proof-set-mismatch', detail: { identity: key, reason: 'prefix_broken' } }
        }

        state.firstOverriddenSequence = proof.consumption_sequence
      } else if (accepting && proof.override_reason !== 'prefix_broken') {
        return { code: 'proof-set-mismatch', detail: { identity: key, reason: 'after-break' } }
      }

      identities.set(key, state)
    }

    const expectedCoverage = [...identities.values()]
      .filter((state) => state.acceptedSequence !== null)
      .map((state) => ({
        allocation_uuid: state.allocationUuid,
        rights_generation: state.rightsGeneration,
        accepted_consumption_sequence: state.acceptedSequence,
        accepted_consumed_quantity_milli: state.acceptedQuantityMilli
      }))

    if (
      expectedCoverage.length !== result.coverage.length ||
      expectedCoverage.some((want, index) => {
        const actual = result.coverage[index]

        return (
          want.allocation_uuid !== actual.allocation_uuid ||
          want.rights_generation !== actual.rights_generation ||
          want.accepted_consumption_sequence !== actual.accepted_consumption_sequence ||
          want.accepted_consumed_quantity_milli !== actual.accepted_consumed_quantity_milli
        )
      })
    ) {
      return {
        code: 'coverage-prefix-unverified',
        detail: { expected: expectedCoverage.length, reported: result.coverage.length }
      }
    }

    const expectedHolds = [...identities.values()]
      .filter((state) => state.firstOverriddenSequence !== null)
      .map((state) => ({
        allocation_uuid: state.allocationUuid,
        rights_generation: state.rightsGeneration,
        first_overridden_sequence: state.firstOverriddenSequence
      }))

    // Every overridden identity has exactly its hold instruction, and no unrelated one is present.
    if (
      expectedHolds.length !== result.required_holds.length ||
      expectedHolds.some((want, index) => {
        const actual = result.required_holds[index]

        return (
          want.allocation_uuid !== actual.allocation_uuid ||
          want.rights_generation !== actual.rights_generation ||
          want.first_overridden_sequence !== actual.first_overridden_sequence
        )
      })
    ) {
      return {
        code: 'hold-instruction-mismatch',
        detail: {
          overridden: expectedHolds.map(identityKey),
          instructed: result.required_holds.map(identityKey)
        }
      }
    }

    // 8. An accepted decision's invoice UUID must not already belong to another local invoice.
    if (accepting && result.invoice !== null) {
      const clash = this.dependencies.database
        .prepare('SELECT local_uuid FROM local_invoices WHERE remote_uuid = ? AND local_uuid <> ?')
        .get(result.invoice.invoice_uuid, candidate.invoiceLocalUuid) as
        { local_uuid: string } | undefined

      if (clash) {
        return { code: 'invoice-uuid-conflict', detail: { heldBy: clash.local_uuid } }
      }
    }

    return null
  }

  /**
   * The frozen payload's proofs exactly as the backend enumerates them in `proof_results[]`
   * (`DispositionProofEvaluator`): flattened line by line, grouped by allocation identity in order of
   * first appearance, and ordered by consumption sequence within each identity (PHP's `usort` is
   * stable). UUIDs are lowercased and `item_line_uuid` re-derived, as the backend does.
   */
  private expectedProofs(
    candidate: DispositionCandidate,
    payload: Record<string, unknown>,
    requestHash: string
  ): readonly ExpectedProof[] {
    const groups = new Map<string, ExpectedProof[]>()
    const items = (Array.isArray(payload.items) ? payload.items : []) as Array<
      Record<string, unknown>
    >

    items.forEach((line, lineIndex) => {
      const allocations = (Array.isArray(line.allocations) ? line.allocations : []) as Array<
        Record<string, unknown>
      >

      allocations.forEach((allocation, proofIndex) => {
        const proof: ExpectedProof = {
          line_index: lineIndex,
          proof_index: proofIndex,
          allocation_uuid: String(allocation.allocation_uuid).toLowerCase(),
          rights_generation: Number(allocation.rights_generation),
          consumption_sequence: Number(allocation.consumption_sequence),
          local_consumption_uuid: String(allocation.local_consumption_uuid).toLowerCase(),
          item_line_uuid: allocationItemLineUuid(candidate.idempotencyKey, lineIndex),
          quantity_milli: Number(allocation.quantity_milli),
          request_hash: requestHash
        }
        const group = groups.get(identityKey(proof)) ?? []
        group.push(proof)
        groups.set(identityKey(proof), group)
      })
    })

    return [...groups.values()].flatMap((group) =>
      [...group].sort((left, right) => left.consumption_sequence - right.consumption_sequence)
    )
  }

  /**
   * Each frozen proof must still be this invoice's own consumption row, with the same identity,
   * sequence and quantity. Columns added by migration 0009 are compared when present; a historical
   * row that never recorded them keeps NULLs and is not invented here.
   */
  private journalMismatch(
    invoiceLocalUuid: string,
    expected: readonly ExpectedProof[]
  ): Record<string, unknown> | null {
    const read = this.dependencies.database.prepare(
      `SELECT allocation_uuid, consumption_sequence, invoice_local_uuid, quantity_milli,
              rights_generation, item_line_uuid
         FROM local_stock_allocation_consumptions
        WHERE lower(local_uuid) = ?`
    )

    for (const proof of expected) {
      const row = read.get(proof.local_consumption_uuid) as Record<string, unknown> | undefined

      if (
        !row ||
        String(row.allocation_uuid).toLowerCase() !== proof.allocation_uuid ||
        row.consumption_sequence !== proof.consumption_sequence ||
        row.invoice_local_uuid !== invoiceLocalUuid ||
        row.quantity_milli !== proof.quantity_milli ||
        (row.rights_generation !== null && row.rights_generation !== proof.rights_generation) ||
        (row.item_line_uuid !== null && row.item_line_uuid !== proof.item_line_uuid)
      ) {
        return { reason: 'local-journal', localConsumptionUuid: proof.local_consumption_uuid }
      }
    }

    return null
  }

  /**
   * The single atomic local application.
   *
   * Everything below commits together or not at all: a crash mid-way leaves the row exactly
   * `rejected`, and the next run repeats cleanly and converges once.
   */
  private commit(
    candidate: DispositionCandidate,
    envelope: DispositionEnvelope
  ): DispositionApplyResult {
    const nowIso = this.now().toISOString()
    const result = envelope.result
    const database = this.dependencies.database

    database
      .prepare(
        `INSERT INTO invoice_disposition_applications (
           invoice_local_uuid, disposition_uuid, decision, result_version, result_json, result_hash,
           queue_failure_json, queue_failure_hash, request_hash, remote_invoice_uuid, applied_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        candidate.invoiceLocalUuid,
        envelope.id,
        result.decision,
        envelope.result_version,
        JSON.stringify(result),
        envelope.result_hash,
        candidate.queueFailureJson,
        sha256(candidate.queueFailureJson),
        result.binding.request_hash,
        result.invoice?.invoice_uuid ?? null,
        nowIso
      )

    for (const proof of result.proof_results) {
      database
        .prepare(
          `INSERT INTO invoice_disposition_proof_results (
             invoice_local_uuid, line_index, proof_index, allocation_uuid, rights_generation,
             consumption_sequence, local_consumption_uuid, quantity_milli, outcome,
             server_consumption_uuid, override_reason, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          candidate.invoiceLocalUuid,
          proof.line_index,
          proof.proof_index,
          proof.allocation_uuid,
          proof.rights_generation,
          proof.consumption_sequence,
          proof.local_consumption_uuid,
          proof.quantity_milli,
          proof.outcome,
          proof.server_consumption_uuid,
          proof.override_reason,
          nowIso
        )
    }

    // The durable deny-spend holds. Installed for BOTH decisions: a permanent rejection still leaves
    // later local sequences depending on journal entries the server will never accept.
    for (const hold of result.required_holds) {
      database
        .prepare(
          `INSERT OR IGNORE INTO stock_allocation_disposition_holds (
             allocation_uuid, rights_generation, invoice_local_uuid, first_overridden_sequence,
             reason, release_allowed, created_at
           ) VALUES (?, ?, ?, ?, 'invoice_disposition_chain_break', 0, ?)`
        )
        .run(
          hold.allocation_uuid,
          hold.rights_generation,
          candidate.invoiceLocalUuid,
          hold.first_overridden_sequence,
          nowIso
        )
    }

    if (result.decision === 'accept_without_proof' && result.invoice !== null) {
      database
        .prepare(
          `UPDATE local_invoices
              SET sync_status = 'synced', remote_uuid = ?, server_number = ?, synced_at = ?,
                  last_sync_error = NULL, updated_at = ?
            WHERE local_uuid = ? AND sync_status = 'rejected'`
        )
        .run(
          result.invoice.invoice_uuid,
          result.invoice.server_number,
          nowIso,
          nowIso,
          candidate.invoiceLocalUuid
        )

      // The ONE narrow queue transition PS6b introduces, guarded on the exact row and its exact
      // rejected state. There is no generic terminal reset here — a broad "clear rejected rows"
      // helper would apply to failures no operator ever decided.
      database
        .prepare(
          `UPDATE sync_queue SET state = 'synced', updated_at = ?
            WHERE local_queue_uuid = ? AND state = 'rejected'`
        )
        .run(nowIso, candidate.localQueueUuid)
    }

    // `reject_permanently` deliberately leaves the queue row and the invoice rejected: the sale was
    // not committed and the record must stay visibly blocked.

    return { kind: 'applied', invoiceLocalUuid: candidate.invoiceLocalUuid }
  }

  /**
   * Record a durable contract conflict and change nothing else.
   *
   * Not retried: none of these is a transport problem, so repeating the request would produce the
   * same disagreement. The row is what an operator review screen reads.
   */
  private conflict(
    candidate: DispositionCandidate,
    dispositionUuid: string | null,
    code: DispositionConflictCode,
    detail: Record<string, unknown>
  ): DispositionApplyResult {
    this.dependencies.database
      .prepare(
        `INSERT INTO invoice_disposition_conflicts (
           local_uuid, invoice_local_uuid, disposition_uuid, conflict_code, detail_json, observed_at
         ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.createUuid(),
        candidate.invoiceLocalUuid,
        dispositionUuid,
        code,
        JSON.stringify(detail),
        this.now().toISOString()
      )

    return { kind: 'conflict', invoiceLocalUuid: candidate.invoiceLocalUuid, code }
  }
}
