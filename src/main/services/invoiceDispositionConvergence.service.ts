import type { SyncStatusEntry } from '@shared/contracts/dispositionDiscovery.contract'
import { SYNC_STATUS_MAXIMUM_KEYS } from '../sync/dispositionStatus.client'
import type {
  DispositionApplyResult,
  DispositionDiscoveryOwner,
  InvoiceDispositionDiscoveryService
} from './invoiceDispositionDiscovery.service'

export interface InvoiceDispositionConvergenceDependencies {
  readonly discovery: Pick<InvoiceDispositionDiscoveryService, 'findCandidates' | 'apply'>
  /** One PS5b read for at most `SYNC_STATUS_MAXIMUM_KEYS` keys, answered per key. */
  readonly fetchStatuses: (
    idempotencyKeys: readonly string[]
  ) => Promise<ReadonlyMap<string, SyncStatusEntry>>
  /** Main's own session owner, resolved on every call and never accepted from a renderer. */
  readonly owner: () => DispositionDiscoveryOwner | null
  /** Called once per run that recorded anything (an application or a conflict). */
  readonly onConverged?: (summary: DispositionConvergenceSummary) => void
  /** §7.3a.5 per-row minimum interval: a row asked about recently is not asked again yet. */
  readonly perRowIntervalMs?: number
  readonly now?: () => number
}

export interface DispositionConvergenceSummary {
  readonly asked: number
  readonly undecided: number
  readonly applied: number
  readonly noop: number
  readonly conflicts: number
}

const EMPTY: DispositionConvergenceSummary = {
  asked: 0,
  undecided: 0,
  applied: 0,
  noop: 0,
  conflicts: 0
}

/**
 * How many eligible rows one run may look at locally before choosing which to ask about. Quarantine
 * is an exceptional state, so this is a bound on a pathological backlog, not a working-set size.
 */
const CANDIDATE_SCAN_LIMIT = 500

const DEFAULT_PER_ROW_INTERVAL_MS = 2 * 60 * 1000

/**
 * PS6b — the main-owned convergence run behind `DispositionDiscoveryTrigger`.
 *
 * One run asks about at most 50 of this device's quarantined physical-presence invoices and applies
 * each decided one through `InvoiceDispositionDiscoveryService.apply()`, which verifies and commits
 * atomically or records a durable conflict. Everything else is left exactly as it was:
 *
 *  - an undecided quarantine, `not_found`, or any other status is not a decision and changes nothing;
 *  - a transport failure or an unreadable answer throws before anything is written, so the next
 *    legitimate trigger asks again (the request is a pure read, so repeating it is always safe);
 *  - a session that changed while the request was in flight applies nothing — the answer was
 *    obtained for the previous owner, and `apply()` re-checks the owner inside its transaction too.
 *
 * No queued payload, idempotency key or local UUID is created or changed, and an upload is never
 * resent from here: a decision is the server's account of an upload it already holds.
 */
export class InvoiceDispositionConvergenceService {
  private readonly lastAskedAt = new Map<string, number>()
  private readonly now: () => number

  constructor(private readonly dependencies: InvoiceDispositionConvergenceDependencies) {
    this.now = dependencies.now ?? Date.now
  }

  async run(): Promise<DispositionConvergenceSummary> {
    const owner = this.dependencies.owner()

    if (owner === null) {
      return EMPTY
    }

    const nowMs = this.now()
    const intervalMs = this.dependencies.perRowIntervalMs ?? DEFAULT_PER_ROW_INTERVAL_MS
    const candidates = this.dependencies.discovery
      .findCandidates(owner, CANDIDATE_SCAN_LIMIT)
      .filter((candidate) => {
        const askedAt = this.lastAskedAt.get(candidate.invoiceLocalUuid)

        return askedAt === undefined || nowMs - askedAt >= intervalMs
      })
      .slice(0, SYNC_STATUS_MAXIMUM_KEYS)

    if (candidates.length === 0) {
      return EMPTY
    }

    const statuses = await this.dependencies.fetchStatuses(
      candidates.map((candidate) => candidate.idempotencyKey)
    )

    for (const candidate of candidates) {
      this.lastAskedAt.set(candidate.invoiceLocalUuid, nowMs)
    }

    const current = this.dependencies.owner()

    if (
      current === null ||
      current.companyUuid !== owner.companyUuid ||
      current.deviceUuid !== owner.deviceUuid
    ) {
      return { ...EMPTY, asked: candidates.length, undecided: candidates.length }
    }

    let undecided = 0
    const outcomes: DispositionApplyResult[] = []

    for (const candidate of candidates) {
      const entry = statuses.get(candidate.idempotencyKey)

      // Only an entry that carries a stored decision is evidence of one. An undecided quarantine
      // returns `disposition: null`; `not_found` and every other status return none at all.
      if (entry === undefined || entry.disposition === null || entry.disposition === undefined) {
        undecided += 1
        continue
      }

      outcomes.push(this.dependencies.discovery.apply(owner, candidate, entry))
    }

    const summary: DispositionConvergenceSummary = {
      asked: candidates.length,
      undecided,
      applied: outcomes.filter((outcome) => outcome.kind === 'applied').length,
      noop: outcomes.filter((outcome) => outcome.kind === 'noop').length,
      conflicts: outcomes.filter((outcome) => outcome.kind === 'conflict').length
    }

    if (summary.applied > 0 || summary.conflicts > 0) {
      try {
        this.dependencies.onConverged?.(summary)
      } catch {
        // A notification failure must never undo or mask a committed convergence.
      }
    }

    return summary
  }
}
