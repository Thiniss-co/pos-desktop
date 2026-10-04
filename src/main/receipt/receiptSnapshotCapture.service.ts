import type { ReceiptSnapshotRepository } from '../repositories/receiptSnapshot.repository'
import { RECEIPT_TEMPLATE_VERSION } from './receiptDocument.service'

/**
 * Owner receipt copies — freezes a sale's receipt snapshot inside the sale-commit transaction, right
 * after the receipt context and the fiscal context (whose QR it copies) are written.
 *
 * The snapshot never decides whether the sale commits: if it cannot be frozen, the repository's
 * savepoint leaves no partial row, the sale commits without a snapshot, and the owner portal says the
 * original receipt is unavailable. Nothing about the sale or its upload changes.
 */
export class ReceiptSnapshotCaptureService {
  private readonly now: () => Date

  constructor(
    private readonly dependencies: {
      readonly repository: Pick<ReceiptSnapshotRepository, 'captureForSale'>
      readonly now?: () => Date
      readonly log?: (line: string) => void
    }
  ) {
    this.now = dependencies.now ?? (() => new Date())
  }

  captureForSale(params: { readonly invoiceLocalUuid: string }): void {
    try {
      this.dependencies.repository.captureForSale({
        invoiceLocalUuid: params.invoiceLocalUuid,
        templateVersion: RECEIPT_TEMPLATE_VERSION,
        createdAt: this.now().toISOString()
      })
    } catch (error) {
      this.dependencies.log?.(
        `[receipt-snapshot] not frozen for a sale: ${error instanceof Error ? error.message : 'unknown error'}`
      )
    }
  }
}
