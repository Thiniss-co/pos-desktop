import type {
  AllocationDispatchOutcome,
  AllocationDispatchOwner,
  AllocationDispatchRepository,
  AllocationDispatchRow,
  AllocationDispatchState
} from '../../repositories/allocationDispatch.repository'
import { serializeTopUpRequest } from '../../repositories/allocationDispatch.repository'
import type { TopUpRequestBody } from '../../services/allocationDeficit'

/**
 * Unit-test double for `AllocationDispatchRepository` (vitest runs in plain Node, where the
 * Electron-built better-sqlite3 cannot load). It enforces the same transition rules as the schema
 * triggers of migration 0016 so a test cannot pass by performing a transition SQLite would refuse;
 * the real repository is exercised in `tests/electron/suites/attemptDispatch.suite.ts`.
 */
export class InMemoryAllocationDispatches implements Pick<
  AllocationDispatchRepository,
  | 'find'
  | 'listForAttempt'
  | 'listOutstanding'
  | 'insertForClaimedAttempt'
  | 'markSending'
  | 'recordAmbiguous'
  | 'recordUnproven'
  | 'resolve'
> {
  readonly rows = new Map<string, AllocationDispatchRow>()
  /** Attempt keys considered `claimed` for insert purposes; defaults to accepting every key. */
  claimedAttempts: Set<string> | null = null

  find(idempotencyKey: string): AllocationDispatchRow | null {
    return this.rows.get(idempotencyKey) ?? null
  }

  listForAttempt(attemptKey: string): readonly AllocationDispatchRow[] {
    return [...this.rows.values()].filter((row) => row.attemptKey === attemptKey)
  }

  listOutstanding(owner: {
    readonly companyUuid: string
    readonly deviceUuid: string
  }): readonly AllocationDispatchRow[] {
    return [...this.rows.values()].filter(
      (row) =>
        row.state === 'dispatched' &&
        row.companyUuid === owner.companyUuid &&
        row.deviceUuid === owner.deviceUuid
    )
  }

  insertForClaimedAttempt(params: {
    readonly attemptKey: string
    readonly owner: AllocationDispatchOwner
    readonly body: TopUpRequestBody
    readonly createdAt: string
  }): boolean {
    if (this.claimedAttempts && !this.claimedAttempts.has(params.attemptKey)) {
      return false
    }
    if (this.rows.has(params.body.idempotency_key)) {
      throw new Error('UNIQUE constraint failed: attempt_allocation_dispatches.idempotency_key')
    }
    this.rows.set(params.body.idempotency_key, {
      idempotencyKey: params.body.idempotency_key,
      attemptKey: params.attemptKey,
      companyUuid: params.owner.companyUuid,
      deviceUuid: params.owner.deviceUuid,
      warehouseUuid: params.owner.warehouseUuid,
      actorUserUuid: params.owner.actorUserUuid,
      requestHash: serializeTopUpRequest(params.body).hash,
      requestBody: params.body,
      state: 'dispatched',
      sendCount: 0,
      ambiguousSendCount: 0,
      lastOutcome: null,
      retryNotBefore: null,
      createdAt: params.createdAt,
      resolvedAt: null
    })
    return true
  }

  markSending(idempotencyKey: string): void {
    const row = this.require(idempotencyKey)
    if (row.state !== 'dispatched' && row.state !== 'refused') {
      throw new Error('Allocation dispatch cannot be sent from its current state')
    }
    this.rows.set(idempotencyKey, {
      ...row,
      state: 'dispatched',
      resolvedAt: null,
      retryNotBefore: null,
      sendCount: row.sendCount + 1
    })
  }

  recordAmbiguous(
    idempotencyKey: string,
    outcome: AllocationDispatchOutcome,
    retryNotBefore: string | null
  ): void {
    const row = this.require(idempotencyKey)
    if (row.state !== 'dispatched') return
    this.rows.set(idempotencyKey, {
      ...row,
      ambiguousSendCount: row.ambiguousSendCount + 1,
      lastOutcome: outcome,
      retryNotBefore
    })
  }

  recordUnproven(
    idempotencyKey: string,
    outcome: AllocationDispatchOutcome,
    retryNotBefore: string | null
  ): void {
    const row = this.require(idempotencyKey)
    if (row.state !== 'dispatched') return
    this.rows.set(idempotencyKey, { ...row, lastOutcome: outcome, retryNotBefore })
  }

  resolve(
    idempotencyKey: string,
    state: Exclude<AllocationDispatchState, 'dispatched'>,
    outcome: AllocationDispatchOutcome,
    resolvedAt: string
  ): void {
    const row = this.require(idempotencyKey)
    if (row.state !== 'dispatched') {
      throw new Error('Allocation dispatch was not outstanding')
    }
    this.rows.set(idempotencyKey, { ...row, state, lastOutcome: outcome, resolvedAt })
  }

  private require(idempotencyKey: string): AllocationDispatchRow {
    const row = this.rows.get(idempotencyKey)
    if (!row) throw new Error('Unknown allocation dispatch')
    return row
  }
}
