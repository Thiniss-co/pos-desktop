import type { SqliteDatabase } from '../database/connection'
import { runSerializedWrite } from '../database/serializedWrite'
import { normalizeCatalogSearch } from '@shared/catalog/normalization'
import type { QuickCreateEntity } from '@shared/contracts/quickCreate.contract'

/**
 * POS improvements, Stage 2 — main-owned persistence of register quick-create (migration 0021).
 *
 * Every write here runs in one `BEGIN IMMEDIATE` transaction (`runSerializedWrite`), and every state
 * change is ONE conditional UPDATE that must change exactly one row; the CHECKs and triggers of
 * 0021 reject anything else. No transaction is ever open across a network call: a claim commits its
 * dispatch evidence first, the request is sent, and the outcome is settled in a second transaction.
 */

export type OutboxState =
  | 'pending'
  | 'dispatching'
  | 'unknown'
  | 'blocked_permission'
  | 'accepted'
  | 'refused'
  | 'conflict'
  | 'superseded'

export interface QuickCreateOwner {
  readonly companyUuid: string
  readonly deviceUuid: string
  readonly userUuid: string
}

export interface OutboxRow {
  readonly requestKey: string
  readonly entityType: QuickCreateEntity
  readonly clientEntityUuid: string
  readonly companyUuid: string
  readonly deviceUuid: string
  readonly creatorUserUuid: string
  readonly canonicalPayloadJson: string
  readonly payloadSha256: string
  readonly state: OutboxState
  readonly leaseId: string | null
  readonly dispatchCount: number
  readonly nextAttemptAt: string | null
  readonly serverEntityUuid: string | null
  readonly resultCode: string | null
  readonly resultMessage: string | null
  readonly resultFieldsJson: string | null
  readonly traceId: string | null
  readonly supersededByRequestKey: string | null
  readonly resubmittedAsRequestKey: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

interface OutboxDbRow {
  readonly request_key: string
  readonly entity_type: QuickCreateEntity
  readonly client_entity_uuid: string
  readonly company_uuid: string
  readonly device_uuid: string
  readonly creator_user_uuid: string
  readonly canonical_payload_json: string
  readonly payload_sha256: string
  readonly state: OutboxState
  readonly lease_id: string | null
  readonly dispatch_count: number
  readonly next_attempt_at: string | null
  readonly server_entity_uuid: string | null
  readonly result_code: string | null
  readonly result_message: string | null
  readonly result_fields_json: string | null
  readonly trace_id: string | null
  readonly superseded_by_request_key: string | null
  readonly resubmitted_as_request_key: string | null
  readonly created_at: string
  readonly updated_at: string
}

function toRow(row: OutboxDbRow): OutboxRow {
  return {
    requestKey: row.request_key,
    entityType: row.entity_type,
    clientEntityUuid: row.client_entity_uuid,
    companyUuid: row.company_uuid,
    deviceUuid: row.device_uuid,
    creatorUserUuid: row.creator_user_uuid,
    canonicalPayloadJson: row.canonical_payload_json,
    payloadSha256: row.payload_sha256,
    state: row.state,
    leaseId: row.lease_id,
    dispatchCount: row.dispatch_count,
    nextAttemptAt: row.next_attempt_at,
    serverEntityUuid: row.server_entity_uuid,
    resultCode: row.result_code,
    resultMessage: row.result_message,
    resultFieldsJson: row.result_fields_json,
    traceId: row.trace_id,
    supersededByRequestKey: row.superseded_by_request_key,
    resubmittedAsRequestKey: row.resubmitted_as_request_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** The local mirror of the entity the latest request describes. */
export type LocalEntityRecord =
  | {
      readonly type: 'customer'
      readonly name: string
      readonly phone: string | null
      readonly email: string | null
      readonly taxNumber: string | null
      readonly address: string | null
      readonly notes: string | null
    }
  | {
      readonly type: 'supplier'
      readonly name: string
      readonly contactPerson: string | null
      readonly phone: string | null
      readonly email: string | null
      readonly taxNumber: string | null
    }
  | {
      readonly type: 'product'
      readonly name: string
      readonly sku: string | null
      readonly barcode: string | null
      readonly priceAmount: number
      readonly currency: string
      readonly categoryUuid: string
      readonly taxUuid: string | null
      readonly taxMode: 'none' | 'inclusive' | 'exclusive'
      readonly unit: string | null
      readonly trackStock: boolean
    }

export interface NewRequest {
  readonly requestKey: string
  readonly clientEntityUuid: string
  readonly owner: QuickCreateOwner
  readonly canonicalPayloadJson: string
  readonly payloadSha256: string
  readonly record: LocalEntityRecord
  readonly now: string
}

export type SettleOutcome =
  | { readonly state: 'accepted'; readonly serverEntityUuid: string }
  | {
      readonly state: 'refused' | 'conflict' | 'blocked_permission' | 'unknown'
      readonly code: string | null
      readonly message: string | null
      readonly fields: Record<string, readonly string[]> | null
      readonly traceId: string | null
      readonly nextAttemptAt?: string | null
    }

const SELECT = 'SELECT * FROM entity_create_outbox'

export class QuickCreateRepository {
  constructor(private readonly database: SqliteDatabase) {}

  /** Entity mirror + pending request + audit, atomically. */
  create(request: NewRequest): OutboxRow {
    return runSerializedWrite(this.database, () => {
      this.upsertRecord(request.clientEntityUuid, request.owner, request.record, request.now)
      this.insertPending(request)
      this.audit(
        request.requestKey,
        request.owner.userUuid,
        null,
        'pending',
        'created',
        null,
        request.now
      )
      return this.require(request.requestKey)
    })
  }

  find(requestKey: string): OutboxRow | null {
    const row = this.database.prepare(`${SELECT} WHERE request_key = ?`).get(requestKey) as
      OutboxDbRow | undefined
    return row ? toRow(row) : null
  }

  /**
   * Claims the next sendable request of THIS owner (company, device AND creator): a due `pending` or
   * `unknown` row, or — only when `allowBlocked` — a `blocked_permission` row. The claim commits the
   * dispatch evidence (`dispatch_count + 1`) and a lease BEFORE the caller touches the network.
   */
  claimNext(
    owner: QuickCreateOwner,
    now: string,
    leaseId: string,
    leaseExpiresAt: string,
    /** Entity kinds whose fresh access check passes: only their blocked rows may be replayed. */
    unblockedTypes: readonly QuickCreateEntity[]
  ): OutboxRow | null {
    return runSerializedWrite(this.database, () => {
      // A blocked row is retried only after a bootstrap NEWER than the refusal (the permission cache
      // was refreshed since the server said no) and only for kinds the fresh check allows. Without
      // this, a stale cache that still says "allowed" would re-send it in a loop.
      const blocked =
        unblockedTypes.length === 0
          ? ''
          : `OR (state = 'blocked_permission' AND entity_type IN (${unblockedTypes.map(() => '?').join(', ')})
                 AND updated_at < COALESCE((SELECT updated_at FROM bootstrap_snapshot_owner WHERE id = 1), ''))`
      const candidate = this.database
        .prepare(
          `${SELECT}
           WHERE company_uuid = ? AND device_uuid = ? AND creator_user_uuid = ?
             AND (
               (state IN ('pending', 'unknown') AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
               ${blocked}
             )
           ORDER BY created_at ASC, request_key ASC
           LIMIT 1`
        )
        .get(owner.companyUuid, owner.deviceUuid, owner.userUuid, now, ...unblockedTypes) as
        OutboxDbRow | undefined
      if (!candidate) {
        return null
      }
      const changed = this.database
        .prepare(
          `UPDATE entity_create_outbox
             SET state = 'dispatching', lease_id = ?, lease_expires_at = ?,
                 dispatch_count = dispatch_count + 1,
                 first_dispatched_at = COALESCE(first_dispatched_at, ?), last_dispatched_at = ?,
                 updated_at = ?
           WHERE request_key = ? AND state = ? AND lease_id IS NULL
             AND creator_user_uuid = ?`
        )
        .run(
          leaseId,
          leaseExpiresAt,
          now,
          now,
          now,
          candidate.request_key,
          candidate.state,
          owner.userUuid
        ).changes
      if (changed !== 1) {
        return null
      }
      this.audit(
        candidate.request_key,
        owner.userUuid,
        candidate.state,
        'dispatching',
        'claim',
        null,
        now
      )
      return this.require(candidate.request_key)
    })
  }

  /** Records the outcome of a dispatch — only for the lease that dispatched it. */
  settle(requestKey: string, leaseId: string, outcome: SettleOutcome, now: string): boolean {
    return runSerializedWrite(this.database, () => {
      const before = this.find(requestKey)
      const changes =
        outcome.state === 'accepted'
          ? this.database
              .prepare(
                `UPDATE entity_create_outbox
                   SET state = 'accepted', lease_id = NULL, lease_expires_at = NULL,
                       server_entity_uuid = ?, result_code = 'DESKTOP_ENTITY_CREATED',
                       result_message = NULL, result_fields_json = NULL, next_attempt_at = NULL,
                       updated_at = ?
                 WHERE request_key = ? AND state = 'dispatching' AND lease_id = ?`
              )
              .run(outcome.serverEntityUuid, now, requestKey, leaseId).changes
          : this.database
              .prepare(
                `UPDATE entity_create_outbox
                   SET state = ?, lease_id = NULL, lease_expires_at = NULL,
                       result_code = ?, result_message = ?, result_fields_json = ?, trace_id = ?,
                       next_attempt_at = ?, updated_at = ?
                 WHERE request_key = ? AND state = 'dispatching' AND lease_id = ?`
              )
              .run(
                outcome.state,
                outcome.code?.slice(0, 64) ?? null,
                outcome.message?.slice(0, 500) ?? null,
                outcome.fields ? JSON.stringify(outcome.fields).slice(0, 4000) : null,
                outcome.traceId?.slice(0, 128) ?? null,
                outcome.nextAttemptAt ?? null,
                now,
                requestKey,
                leaseId
              ).changes
      if (changes === 1) {
        this.audit(
          requestKey,
          before?.creatorUserUuid ?? null,
          'dispatching',
          outcome.state,
          outcome.state === 'accepted' ? 'server accepted' : (outcome.code ?? 'outcome'),
          null,
          now
        )
      }
      return changes === 1
    })
  }

  /**
   * A lease that outlived its holder (a crash, a killed process) becomes `unknown`: the request may
   * have reached the server, so it is replayed with the same key and bytes, never assumed failed.
   */
  reclaimExpired(owner: QuickCreateOwner, now: string): number {
    return runSerializedWrite(this.database, () => {
      const rows = this.database
        .prepare(
          `SELECT request_key FROM entity_create_outbox
           WHERE company_uuid = ? AND device_uuid = ? AND state = 'dispatching' AND lease_expires_at < ?`
        )
        .all(owner.companyUuid, owner.deviceUuid, now) as Array<{ request_key: string }>
      let reclaimed = 0
      for (const row of rows) {
        const changed = this.database
          .prepare(
            `UPDATE entity_create_outbox
               SET state = 'unknown', lease_id = NULL, lease_expires_at = NULL,
                   result_code = 'LEASE_EXPIRED', next_attempt_at = NULL, updated_at = ?
             WHERE request_key = ? AND state = 'dispatching' AND lease_expires_at < ?`
          )
          .run(now, row.request_key, now).changes
        if (changed === 1) {
          reclaimed += 1
          this.audit(row.request_key, null, 'dispatching', 'unknown', 'lease expired', null, now)
        }
      }
      return reclaimed
    })
  }

  /**
   * Hands a request that PROVABLY never left this register to another (permitted) user: allowed only
   * from `pending` (which, by CHECK, means no dispatch evidence) with no lease. One transaction:
   * supersede the old row, create the new one under the new actor, audit both.
   */
  reassign(
    oldRequestKey: string,
    newRequest: NewRequest,
    actor: QuickCreateOwner
  ): 'reassigned' | 'refused' {
    return runSerializedWrite(this.database, () => {
      const changed = this.database
        .prepare(
          `UPDATE entity_create_outbox
             SET state = 'superseded', superseded_by_request_key = ?, updated_at = ?
           WHERE request_key = ? AND state = 'pending' AND dispatch_count = 0 AND lease_id IS NULL
             AND creator_user_uuid <> ? AND company_uuid = ? AND device_uuid = ?`
        )
        .run(
          newRequest.requestKey,
          newRequest.now,
          oldRequestKey,
          actor.userUuid,
          actor.companyUuid,
          actor.deviceUuid
        ).changes
      if (changed !== 1) {
        return 'refused'
      }
      this.audit(
        oldRequestKey,
        actor.userUuid,
        'pending',
        'superseded',
        'reassigned',
        newRequest.requestKey,
        newRequest.now
      )
      this.upsertRecord(
        newRequest.clientEntityUuid,
        newRequest.owner,
        newRequest.record,
        newRequest.now
      )
      this.insertPending(newRequest)
      this.audit(
        newRequest.requestKey,
        actor.userUuid,
        null,
        'pending',
        'reassignment of',
        oldRequestKey,
        newRequest.now
      )
      return 'reassigned'
    })
  }

  /** A corrected request for the SAME entity id after a durable refusal (or a key conflict). */
  resubmit(oldRequestKey: string, newRequest: NewRequest): 'resubmitted' | 'refused' {
    return runSerializedWrite(this.database, () => {
      const changed = this.database
        .prepare(
          `UPDATE entity_create_outbox
             SET resubmitted_as_request_key = ?, updated_at = updated_at
           WHERE request_key = ? AND state IN ('refused', 'conflict')
             AND resubmitted_as_request_key IS NULL AND client_entity_uuid = ?`
        )
        .run(newRequest.requestKey, oldRequestKey, newRequest.clientEntityUuid).changes
      if (changed !== 1) {
        return 'refused'
      }
      this.upsertRecord(
        newRequest.clientEntityUuid,
        newRequest.owner,
        newRequest.record,
        newRequest.now
      )
      this.insertPending(newRequest)
      this.audit(
        newRequest.requestKey,
        newRequest.owner.userUuid,
        null,
        'pending',
        'resubmission of',
        oldRequestKey,
        newRequest.now
      )
      return 'resubmitted'
    })
  }

  /** The newest request for an entity id (live if any, else the latest history row). */
  latestFor(type: QuickCreateEntity, clientEntityUuid: string): OutboxRow | null {
    const live = this.database
      .prepare(
        `${SELECT} WHERE entity_type = ? AND client_entity_uuid = ?
           AND state NOT IN ('superseded', 'refused', 'conflict')`
      )
      .get(type, clientEntityUuid) as OutboxDbRow | undefined
    if (live) {
      return toRow(live)
    }
    const latest = this.database
      .prepare(
        `${SELECT} WHERE entity_type = ? AND client_entity_uuid = ? AND state <> 'superseded'
         ORDER BY created_at DESC, request_key DESC LIMIT 1`
      )
      .get(type, clientEntityUuid) as OutboxDbRow | undefined
    return latest ? toRow(latest) : null
  }

  /** Every request of one company on this register, newest first (history included). */
  listForCompany(companyUuid: string, limit = 200): OutboxRow[] {
    return (
      this.database
        .prepare(
          `${SELECT} WHERE company_uuid = ? ORDER BY created_at DESC, request_key DESC LIMIT ?`
        )
        .all(companyUuid, limit) as OutboxDbRow[]
    ).map(toRow)
  }

  /** The display name of the local record an entity id refers to. */
  recordName(type: QuickCreateEntity, uuid: string): string | null {
    const table =
      type === 'customer'
        ? 'local_customers'
        : type === 'supplier'
          ? 'local_suppliers'
          : 'local_products'
    const row = this.database.prepare(`SELECT name FROM ${table} WHERE uuid = ?`).get(uuid) as
      { name: string } | undefined
    return row?.name ?? null
  }

  /** Earliest future retry among this owner's unknown rows (for the worker's single timer). */
  nextRetryAt(owner: QuickCreateOwner): string | null {
    const row = this.database
      .prepare(
        `SELECT MIN(next_attempt_at) AS at FROM entity_create_outbox
         WHERE company_uuid = ? AND device_uuid = ? AND creator_user_uuid = ?
           AND state = 'unknown' AND next_attempt_at IS NOT NULL`
      )
      .get(owner.companyUuid, owner.deviceUuid, owner.userUuid) as { at: string | null }
    return row.at
  }

  auditTrail(requestKey: string): Array<{
    from: string | null
    to: string
    reason: string | null
    actor: string | null
    related: string | null
  }> {
    return (
      this.database
        .prepare(
          'SELECT from_state, to_state, reason, actor_user_uuid, related_request_key FROM entity_create_audit WHERE request_key = ? ORDER BY id'
        )
        .all(requestKey) as Array<{
        from_state: string | null
        to_state: string
        reason: string | null
        actor_user_uuid: string | null
        related_request_key: string | null
      }>
    ).map((row) => ({
      from: row.from_state,
      to: row.to_state,
      reason: row.reason,
      actor: row.actor_user_uuid,
      related: row.related_request_key
    }))
  }

  private require(requestKey: string): OutboxRow {
    const row = this.find(requestKey)
    if (!row) {
      throw new Error('quick-create request vanished inside its own transaction')
    }
    return row
  }

  private insertPending(request: NewRequest): void {
    this.database
      .prepare(
        `INSERT INTO entity_create_outbox (
           request_key, entity_type, client_entity_uuid, company_uuid, device_uuid, creator_user_uuid,
           canonical_payload_json, payload_sha256, state, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      )
      .run(
        request.requestKey,
        request.record.type,
        request.clientEntityUuid,
        request.owner.companyUuid,
        request.owner.deviceUuid,
        request.owner.userUuid,
        request.canonicalPayloadJson,
        request.payloadSha256,
        request.now,
        request.now
      )
  }

  private upsertRecord(
    uuid: string,
    owner: QuickCreateOwner,
    record: LocalEntityRecord,
    now: string
  ): void {
    if (record.type === 'customer') {
      this.database
        .prepare(
          `INSERT INTO local_customers (
             uuid, company_uuid, device_uuid, creator_user_uuid, name, phone, email, tax_number,
             address, notes, search_name, search_phone, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(uuid) DO UPDATE SET
             name = excluded.name, phone = excluded.phone, email = excluded.email,
             tax_number = excluded.tax_number, address = excluded.address, notes = excluded.notes,
             search_name = excluded.search_name, search_phone = excluded.search_phone,
             updated_at = excluded.updated_at`
        )
        .run(
          uuid,
          owner.companyUuid,
          owner.deviceUuid,
          owner.userUuid,
          record.name,
          record.phone,
          record.email,
          record.taxNumber,
          record.address,
          record.notes,
          normalizeCatalogSearch(record.name),
          record.phone === null ? null : normalizeCatalogSearch(record.phone),
          now,
          now
        )
      return
    }
    if (record.type === 'supplier') {
      this.database
        .prepare(
          `INSERT INTO local_suppliers (
             uuid, company_uuid, device_uuid, creator_user_uuid, name, contact_person, phone, email,
             tax_number, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(uuid) DO UPDATE SET
             name = excluded.name, contact_person = excluded.contact_person, phone = excluded.phone,
             email = excluded.email, tax_number = excluded.tax_number, updated_at = excluded.updated_at`
        )
        .run(
          uuid,
          owner.companyUuid,
          owner.deviceUuid,
          owner.userUuid,
          record.name,
          record.contactPerson,
          record.phone,
          record.email,
          record.taxNumber,
          now,
          now
        )
      return
    }
    this.database
      .prepare(
        `INSERT INTO local_products (
           uuid, company_uuid, device_uuid, creator_user_uuid, name, sku, barcode, price_amount, currency,
           category_uuid, tax_uuid, tax_mode, unit, track_stock, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(uuid) DO UPDATE SET
           name = excluded.name, sku = excluded.sku, barcode = excluded.barcode,
           price_amount = excluded.price_amount, currency = excluded.currency,
           category_uuid = excluded.category_uuid, tax_uuid = excluded.tax_uuid,
           tax_mode = excluded.tax_mode, unit = excluded.unit, track_stock = excluded.track_stock,
           updated_at = excluded.updated_at`
      )
      .run(
        uuid,
        owner.companyUuid,
        owner.deviceUuid,
        owner.userUuid,
        record.name,
        record.sku,
        record.barcode,
        record.priceAmount,
        record.currency,
        record.categoryUuid,
        record.taxUuid,
        record.taxMode,
        record.unit,
        record.trackStock ? 1 : 0,
        now,
        now
      )
  }

  private audit(
    requestKey: string,
    actor: string | null,
    from: string | null,
    to: string,
    reason: string | null,
    related: string | null,
    at: string
  ): void {
    this.database
      .prepare(
        `INSERT INTO entity_create_audit (request_key, actor_user_uuid, from_state, to_state, reason, related_request_key, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(requestKey, actor, from, to, reason?.slice(0, 200) ?? null, related, at)
  }
}
