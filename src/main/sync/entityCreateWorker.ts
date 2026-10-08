import { randomUUID } from 'node:crypto'
import type { QuickCreateAccess, QuickCreateEntity } from '@shared/contracts/quickCreate.contract'
import type {
  OutboxRow,
  QuickCreateOwner,
  QuickCreateRepository
} from '../repositories/quickCreate.repository'
import type { QuickCreateDispatchResult } from './quickCreate.client'

/** A dispatch outlives its lease only after a crash; the next drain then replays it (`unknown`). */
export const ENTITY_CREATE_LEASE_MS = 60_000
const RETRY_INITIAL_MS = 5_000
const RETRY_MAX_MS = 5 * 60_000

export interface EntityCreateWorkerDependencies {
  readonly repository: Pick<
    QuickCreateRepository,
    'claimNext' | 'settle' | 'reclaimExpired' | 'reclaimInterrupted' | 'nextRetryAt'
  >
  readonly access: { access(): QuickCreateAccess }
  readonly session: {
    getContext(): {
      readonly isAuthenticated: boolean
      readonly userUuid: string | null
      readonly companyUuid: string | null
      readonly deviceUuid: string | null
    }
  }
  readonly dispatch: (row: OutboxRow) => Promise<QuickCreateDispatchResult>
  /**
   * Nothing is claimed while the service is known unreachable: a claim records dispatch evidence,
   * and requests created offline must keep their positive "never sent" proof (the reassignment rule).
   * Absent → always online.
   */
  readonly isOnline?: () => boolean
  readonly now?: () => Date
  readonly schedule?: (callback: () => void, delayMs: number) => () => void
  /** A product/customer was accepted, refused, conflicted or blocked: dependents re-evaluate. */
  readonly onEntityResolved?: (row: OutboxRow, outcome: QuickCreateDispatchResult['kind']) => void
  readonly onChanged?: () => void
  readonly log?: (line: string) => void
}

/** The backoff for replaying an unknown outcome (same key and bytes). */
export function entityCreateRetryDelay(dispatchCount: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.max(0, dispatchCount - 1))
}

/**
 * POS improvements, Stage 2 — drains register quick-create requests, one at a time.
 *
 *  - It sends only the SIGNED-IN user's own requests (company, device and creator). Another user's
 *    pending request waits for its creator or an explicit, audited reassignment.
 *  - The claim commits dispatch evidence before the network call; the outcome settles under the same
 *    lease in a second transaction. A crash in between leaves a lease that a later drain reclaims to
 *    `unknown`, which is replayed with the SAME key and bytes — never assumed failed.
 *  - `blocked_permission` rows are replayed only once the fresh access check for their entity kind
 *    passes again (a later bootstrap restored the permission).
 *  - A 401 pauses the drain; it resumes on the next trigger (sign-in, connectivity, bootstrap).
 */
export class EntityCreateWorker {
  private readonly now: () => Date
  private readonly schedule: (callback: () => void, delayMs: number) => () => void
  private running: Promise<void> | null = null
  private rerunRequested = false
  private cancelTimer: (() => void) | null = null
  private stopped = false
  /** Owners whose interrupted leases this process already took back (once per owner). */
  private readonly reclaimedAtStart = new Set<string>()

  constructor(private readonly dependencies: EntityCreateWorkerDependencies) {
    this.now = dependencies.now ?? ((): Date => new Date())
    this.schedule =
      dependencies.schedule ??
      ((callback, delayMs): (() => void) => {
        const handle = setTimeout(callback, delayMs)
        handle.unref?.()
        return () => clearTimeout(handle)
      })
  }

  requestRun(): void {
    void this.run().catch((error: unknown) => this.log(`entity-create-run-failed ${String(error)}`))
  }

  async run(): Promise<void> {
    if (this.running) {
      this.rerunRequested = true
      return this.running
    }
    this.running = this.drain()
    try {
      await this.running
    } finally {
      this.running = null
      if (this.rerunRequested && !this.stopped) {
        this.rerunRequested = false
        this.requestRun()
      }
    }
  }

  shutdown(): void {
    this.stopped = true
    this.cancelTimer?.()
    this.cancelTimer = null
  }

  private owner(): QuickCreateOwner | null {
    const context = this.dependencies.session.getContext()
    if (
      !context.isAuthenticated ||
      !context.userUuid ||
      !context.companyUuid ||
      !context.deviceUuid
    ) {
      return null
    }
    return {
      companyUuid: context.companyUuid,
      deviceUuid: context.deviceUuid,
      userUuid: context.userUuid
    }
  }

  private unblockedTypes(): QuickCreateEntity[] {
    const access = this.dependencies.access.access()
    return (['customer', 'supplier', 'product'] as const).filter((type) => access[type])
  }

  private async drain(): Promise<void> {
    const owner = this.owner()
    if (owner === null) {
      return
    }
    // The first drain for an owner in this process takes back what a previous process left
    // `dispatching` (a crash or a killed till); later drains only reclaim expired leases.
    const ownerKey = `${owner.companyUuid}:${owner.deviceUuid}`
    const nowIso = this.now().toISOString()
    let reclaimed = 0
    if (!this.reclaimedAtStart.has(ownerKey)) {
      this.reclaimedAtStart.add(ownerKey)
      reclaimed += this.dependencies.repository.reclaimInterrupted(owner, nowIso)
    }
    reclaimed += this.dependencies.repository.reclaimExpired(owner, nowIso)
    if (reclaimed > 0) {
      this.log(`entity-create-reclaimed ${reclaimed}`)
    }
    let changed = reclaimed > 0
    // Defence in depth: one drain never sends the same request twice.
    const sentThisDrain = new Set<string>()

    while (!this.stopped) {
      if (this.dependencies.isOnline && !this.dependencies.isOnline()) {
        break
      }
      const current = this.owner()
      if (current === null || current.userUuid !== owner.userUuid) {
        break
      }
      const now = this.now()
      const leaseId = randomUUID()
      const row = this.dependencies.repository.claimNext(
        owner,
        now.toISOString(),
        leaseId,
        new Date(now.getTime() + ENTITY_CREATE_LEASE_MS).toISOString(),
        this.unblockedTypes()
      )
      if (row === null) {
        break
      }
      if (sentThisDrain.has(row.requestKey)) {
        // Hand the lease back as an unknown outcome to retry later; never loop on one request.
        this.dependencies.repository.settle(
          row.requestKey,
          leaseId,
          {
            state: 'unknown',
            code: 'RETRY_LATER',
            message: null,
            fields: null,
            traceId: null,
            nextAttemptAt: new Date(
              now.getTime() + entityCreateRetryDelay(row.dispatchCount)
            ).toISOString()
          },
          now.toISOString()
        )
        break
      }
      sentThisDrain.add(row.requestKey)
      changed = true
      const result = await this.dependencies.dispatch(row)
      const settledAt = this.now()
      const settled = this.dependencies.repository.settle(
        row.requestKey,
        leaseId,
        result.kind === 'accepted'
          ? { state: 'accepted', serverEntityUuid: result.serverEntityUuid }
          : {
              state: result.kind,
              code: result.code,
              message: result.message,
              fields: result.fields,
              traceId: result.traceId,
              nextAttemptAt:
                result.kind === 'unknown'
                  ? new Date(
                      settledAt.getTime() + entityCreateRetryDelay(row.dispatchCount)
                    ).toISOString()
                  : null
            },
        settledAt.toISOString()
      )
      this.log(
        `entity-create ${row.entityType} ${row.requestKey} -> ${result.kind}${settled ? '' : ' (lease lost)'}`
      )
      if (settled && result.kind !== 'unknown') {
        this.dependencies.onEntityResolved?.(row, result.kind)
      }
      if (result.kind === 'unknown' && 'sessionEnded' in result && result.sessionEnded) {
        break
      }
    }

    this.rearm(owner)
    if (changed) {
      this.dependencies.onChanged?.()
    }
  }

  private rearm(owner: QuickCreateOwner): void {
    this.cancelTimer?.()
    this.cancelTimer = null
    if (this.stopped) {
      return
    }
    const next = this.dependencies.repository.nextRetryAt(owner)
    if (next === null) {
      return
    }
    const delay = Math.max(1_000, Math.min(RETRY_MAX_MS, Date.parse(next) - this.now().getTime()))
    this.cancelTimer = this.schedule(() => this.requestRun(), delay)
  }

  private log(line: string): void {
    this.dependencies.log?.(line)
  }
}
