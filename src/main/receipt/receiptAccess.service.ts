import { publicAppErrorSchema, type PublicAppError } from '@shared/contracts/api.contract'
import type { LocalInvoiceRow } from '@shared/contracts/sale.contract'
import type { LocalRefundRow } from '@shared/contracts/refund.contract'
import type {
  ShiftAuthorityContext,
  ShiftAuthorityService
} from '../services/shiftAuthority.service'

/**
 * Receipt-printing plan §D-6 — receipt access. Deliberately narrower than
 * `ShiftAuthorityService.captureContext()` alone: it additionally requires `pos.view`, and its
 * callers additionally check document ownership (`assertDocument`). It requires NO open shift, NO
 * `pos.sell`, NO license window and NO connectivity -- a closed-shift, offline, license-expired
 * reprint of an already-completed sale is exactly what this is FOR.
 */

export interface ReceiptOwner extends ShiftAuthorityContext {}

export interface ReceiptAccessDependencies {
  readonly shiftAuthority: Pick<ShiftAuthorityService, 'captureContext'>
  readonly permissions: { hasPermission(permission: string): boolean }
}

function notFound(): PublicAppError {
  return publicAppErrorSchema.parse({
    category: 'validation',
    message: 'This receipt could not be found.',
    backendCode: 'receipt_not_found',
    retryable: false
  })
}

function refundNotConfirmed(): PublicAppError {
  return publicAppErrorSchema.parse({
    category: 'validation',
    message: 'This refund has not been confirmed yet, so its receipt is not available.',
    backendCode: 'receipt_refund_not_confirmed',
    retryable: false
  })
}

export class ReceiptAccessService {
  constructor(private readonly dependencies: ReceiptAccessDependencies) {}

  /** Throws `authorization`/`RECEIPT_NOT_FOUND` semantics are left to the caller's owner check;
   *  this only establishes WHO is asking and whether they may read receipts at all. */
  resolveCaller(): ReceiptOwner {
    const owner = this.dependencies.shiftAuthority.captureContext()

    if (!this.dependencies.permissions.hasPermission('pos.view')) {
      throw publicAppErrorSchema.parse({
        category: 'authorization',
        message: 'You do not have permission to view receipts.',
        retryable: false
      })
    }

    return owner
  }

  assertSaleDocument(owner: ReceiptOwner, row: LocalInvoiceRow | null): LocalInvoiceRow {
    if (!row || row.companyUuid !== owner.companyUuid || row.deviceUuid !== owner.deviceUuid) {
      throw notFound()
    }

    return row
  }

  assertRefundDocument(owner: ReceiptOwner, row: LocalRefundRow | null): LocalRefundRow {
    if (!row || row.companyUuid !== owner.companyUuid || row.deviceUuid !== owner.deviceUuid) {
      throw notFound()
    }

    if (row.submissionState !== 'accepted') {
      throw refundNotConfirmed()
    }

    return row
  }
}
