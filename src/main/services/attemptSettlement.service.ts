import type { SqliteDatabase } from '../database/connection'
import { runSerializedWrite } from '../database/serializedWrite'
import type { SaleAttemptRepository } from '../repositories/saleAttempt.repository'

/**
 * Rev 4 §9.1 — main-owned settlement of a claimed attempt that can provably never commit.
 *
 * Runs after every catalog install and at start, inside one serialized write, with no network:
 *
 *  - a completion in flight settles itself → skip;
 *  - the owner's claimed attempt is NOT superseded (its revision is the installed, still-valid one)
 *    → nothing (it stays claimed and committable);
 *  - superseded, `recorded` dispatch evidence → `claimed → rejected` with `catalog-superseded`, the
 *    SAME transition and code a retry would produce. Outstanding dispatch rows are untouched; the
 *    reconciler owns them and ingests a late grant exactly once;
 *  - superseded, `unknown` (legacy) evidence → NEVER rejected (Rule L). It stays claimed with its
 *    frozen intent until the explicit acknowledgement-cancel records the uncertainty;
 *  - committed/acknowledged attempts and invoices are never read or touched here.
 *
 * Nothing is fabricated: no server outcome, no key replacement, no request-byte change, no deletion.
 */

export type SettlementResult = 'settled' | 'none' | 'legacy-unresolved' | 'in-flight' | 'no-owner'

export interface AttemptSettlementDependencies {
  readonly database: SqliteDatabase
  readonly saleAttempts: Pick<SaleAttemptRepository, 'findBlockingForOwner' | 'markRejected'>
  readonly owner: () => { companyUuid: string; deviceUuid: string; userUuid: string } | null
  readonly catalog: {
    getStatus(): {
      readonly isReadable: boolean
      readonly status: string
      readonly contract: { readonly revision: string; readonly validUntil: string } | null
    }
  }
  readonly completionInFlight: (attemptKey: string) => boolean
  readonly now: () => Date
  /** Pushed after a settlement so the renderer re-discovers pending attempts. */
  readonly onSettled?: (result: SettlementResult) => void
}

export class AttemptSettlementService {
  constructor(private readonly dependencies: AttemptSettlementDependencies) {}

  settleSuperseded(): SettlementResult {
    const owner = this.dependencies.owner()
    if (owner === null) {
      return 'no-owner'
    }

    const result = runSerializedWrite(this.dependencies.database, (): SettlementResult => {
      const claimed = this.dependencies.saleAttempts.findBlockingForOwner(owner)
      if (!claimed || claimed.intentJson === null) {
        return 'none'
      }
      if (this.dependencies.completionInFlight(claimed.attemptKey)) {
        return 'in-flight'
      }

      let intentRevision: unknown = null
      try {
        intentRevision = (JSON.parse(claimed.intentJson) as { catalogRevision?: unknown })
          .catalogRevision
      } catch {
        return 'none'
      }

      const status = this.dependencies.catalog.getStatus()
      if (!status.isReadable || status.contract === null) {
        // An unreadable catalog proves nothing; the attempt stays claimed.
        return 'none'
      }

      const now = this.dependencies.now().getTime()
      const validUntil = Date.parse(status.contract.validUntil)
      const superseded =
        status.contract.revision !== intentRevision ||
        status.status === 'stale' ||
        (Number.isFinite(validUntil) && now >= validUntil)

      if (!superseded) {
        return 'none'
      }

      if (claimed.dispatchEvidence === 'unknown') {
        return 'legacy-unresolved'
      }

      this.dependencies.saleAttempts.markRejected(
        claimed.attemptKey,
        'catalog-superseded',
        new Date(now).toISOString()
      )
      return 'settled'
    })

    if (result === 'settled' || result === 'legacy-unresolved') {
      try {
        this.dependencies.onSettled?.(result)
      } catch {
        // A notification must never affect the recorded state.
      }
    }

    return result
  }
}
