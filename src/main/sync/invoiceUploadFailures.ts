import {
  SYNC_FAILURE_PAGE_DEFAULT_SIZE,
  type SyncFailureCursor,
  type SyncFailurePage
} from '@shared/contracts/sync.contract'
import type { SyncQueueRepository } from '../repositories/syncQueue.repository'
import type { InvoiceUploadWorkerSessionReader } from './invoiceUploadWorker'

export interface InvoiceUploadFailureReaderDependencies {
  readonly syncQueue: SyncQueueRepository
  readonly session: InvoiceUploadWorkerSessionReader
}

/**
 * The read-only review feed for terminally failed invoice uploads.
 *
 * The company/device pair is resolved **here, from the main-process session**, and is never a
 * parameter the caller can supply. That is the whole point of the seam: the renderer names a page,
 * never an owner, so no IPC payload — well-formed or not — can widen the scope to another till's or
 * another company's sales. Without a session there is nothing this device may show, so the list is
 * empty rather than unscoped.
 *
 * This performs no writes and no HTTP. Reviewing a failure never retries, acknowledges, mutates or
 * deletes it (PD-3G-1: preserve and surface).
 */
export class InvoiceUploadFailureReader {
  constructor(private readonly dependencies: InvoiceUploadFailureReaderDependencies) {}

  list(
    cursor: SyncFailureCursor | null = null,
    limit: number = SYNC_FAILURE_PAGE_DEFAULT_SIZE
  ): SyncFailurePage {
    const context = this.dependencies.session.getContext()

    if (!context.isAuthenticated || !context.companyUuid || !context.deviceUuid) {
      return { items: [], nextCursor: null }
    }

    return this.dependencies.syncQueue.listUploadFailures(
      { companyUuid: context.companyUuid, deviceUuid: context.deviceUuid },
      cursor,
      limit
    )
  }
}
