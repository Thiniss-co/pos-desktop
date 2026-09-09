import type { SqliteDatabase } from '../database/connection'
import { runSerializedWrite } from '../database/serializedWrite'
import type { IncomingCoverageBoundary } from '../repositories/stockAllocation.repository'
import type {
  AllocationReconciliationService,
  ReconciliationOwner
} from '../services/allocationReconciliation.service'
import type { LocalSaleRepository } from '../repositories/localSale.repository'
import type { SyncConflictRepository } from '../repositories/syncConflict.repository'
import type {
  ClaimedInvoiceUpload,
  SyncQueueErrorDetails,
  SyncQueueRepository
} from '../repositories/syncQueue.repository'

/**
 * A decided upload outcome, ready to be persisted.
 *
 * Deciding it — reading an HTTP answer or an error and choosing which of these it is — belongs to
 * the worker (CP-3G-3). This module only writes a decision down, atomically. Keeping the two apart
 * means the mapping can be unit-tested without SQLite and the persistence can be proven against
 * real SQLite without HTTP.
 */
export type InvoiceUploadOutcome =
  | {
      /** 201 DESKTOP_INVOICE_UPLOADED or 200 DESKTOP_INVOICE_ALREADY_UPLOADED — both are acceptance. */
      readonly kind: 'synced'
      readonly remoteUuid: string
      readonly serverNumber: string
      /**
       * BH-04B-3: coverage the server reported for the allocations this invoice touched. Applied in
       * the same transaction that resolves the queue row, so acknowledgement and reconciliation
       * cannot land apart. Absent when the response reported none.
       */
      readonly coverage?: readonly IncomingCoverageBoundary[]
      readonly owner?: ReconciliationOwner
    }
  | {
      /** Transient: transport, timeout, 429, 5xx, an expired lease, an unreadable answer. */
      readonly kind: 'retryable'
      readonly errorCode: string
      readonly retryDelayMs: number
      readonly details?: SyncQueueErrorDetails
    }
  | {
      /** 409. Terminal, and the local payload is preserved for a human to compare. */
      readonly kind: 'conflict'
      readonly errorCode: string
      readonly details?: SyncQueueErrorDetails
      /** What the server reported, verbatim, for side-by-side review. */
      readonly reportedDetails?: string
    }
  | {
      /** A terminal business rejection: a 422 class, or an opaque attribution refusal. */
      readonly kind: 'rejected'
      readonly errorCode: string
      readonly details?: SyncQueueErrorDetails
    }

export interface InvoiceUploadOutcomeRecorderDependencies {
  readonly database: SqliteDatabase
  readonly syncQueue: SyncQueueRepository
  readonly localSale: LocalSaleRepository
  readonly syncConflicts: SyncConflictRepository
  /** BH-04B-3. Optional: without it an upload response's coverage is not applied, never guessed. */
  readonly allocationReconciliation?: Pick<AllocationReconciliationService, 'applyCoverage'>
  readonly now?: () => string
}

const MAXIMUM_LAST_SYNC_ERROR_LENGTH = 500

function summarize(errorCode: string, details: SyncQueueErrorDetails | undefined): string {
  const message = details?.message?.trim()
  const summary = message ? `${errorCode}: ${message}` : errorCode

  return summary.slice(0, MAXIMUM_LAST_SYNC_ERROR_LENGTH)
}

/**
 * Writes one upload outcome across `sync_queue`, `local_invoices` and (for a conflict)
 * `sync_conflicts` in a **single** transaction.
 *
 * The queue row and the invoice row must never disagree about whether an invoice reached the
 * server: a crash between the two would leave a `synced` queue row over an invoice with no
 * `remote_uuid`, which is precisely the state no later reader could safely interpret. One
 * transaction removes the question.
 */
export class InvoiceUploadOutcomeRecorder {
  private readonly now: () => string

  constructor(private readonly dependencies: InvoiceUploadOutcomeRecorderDependencies) {
    this.now = dependencies.now ?? ((): string => new Date().toISOString())
  }

  record(claimed: ClaimedInvoiceUpload, outcome: InvoiceUploadOutcome): void {
    const nowIso = this.now()

    runSerializedWrite(this.dependencies.database, () => {
      if (outcome.kind === 'synced') {
        this.dependencies.syncQueue.markUploadSynced(claimed.localQueueUuid, nowIso)
        this.dependencies.localSale.markInvoiceSynced(claimed.invoiceLocalUuid, {
          remoteUuid: outcome.remoteUuid,
          serverNumber: outcome.serverNumber,
          syncedAt: nowIso
        })

        // BH-04B-3: acknowledging an upload never deletes a consumption row and never flips one to
        // `acknowledged` to remove its deduction. A row stops being deducted only when an accepted
        // boundary's sequence reaches it, which is what makes both arrival orders converge on the
        // same balance. Applying the boundary here — inside the transaction that resolves the queue
        // row — is what keeps the two from committing separately.
        if (outcome.owner !== undefined && this.dependencies.allocationReconciliation) {
          for (const boundary of outcome.coverage ?? []) {
            this.dependencies.allocationReconciliation.applyCoverage(
              boundary,
              outcome.owner,
              'invoice_upload',
              nowIso
            )
          }
        }

        return
      }

      const state = outcome.kind === 'retryable' ? 'retryable_error' : outcome.kind

      this.dependencies.syncQueue.failUpload(claimed.localQueueUuid, state, nowIso, {
        errorCode: outcome.errorCode,
        details: outcome.details,
        ...(outcome.kind === 'retryable'
          ? {
              nextAttemptAt: new Date(
                new Date(nowIso).getTime() + Math.max(outcome.retryDelayMs, 0)
              ).toISOString()
            }
          : {})
      })

      this.dependencies.localSale.markInvoiceUploadFailed(claimed.invoiceLocalUuid, {
        syncStatus: state,
        lastSyncError: summarize(outcome.errorCode, outcome.details),
        updatedAt: nowIso
      })

      if (outcome.kind === 'conflict') {
        // The queued payload is stored beside the server's account of the disagreement so a person
        // can compare them. Neither side is overwritten and nothing is auto-retried: a conflict is
        // a question for a human, and the worker has no authority to answer it.
        this.dependencies.syncConflicts.record({
          localQueueUuid: claimed.localQueueUuid,
          conflictCode: outcome.errorCode,
          localPayloadJson: claimed.payloadJson,
          ...(outcome.reportedDetails === undefined
            ? {}
            : { reportedDetails: outcome.reportedDetails })
        })
      }
    })
  }
}
