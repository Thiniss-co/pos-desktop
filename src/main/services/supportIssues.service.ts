import {
  SUPPORT_ISSUE_LIST_LIMIT,
  type SupportIssue,
  type SupportIssueKind,
  type SupportIssueLine,
  type SupportPaymentAwaiting,
  type SyncSupportIssues
} from '@shared/contracts/sync.contract'
import type {
  AllocationDispatchRepository,
  AllocationDispatchRow
} from '../repositories/allocationDispatch.repository'
import type {
  LegacyDispatchUncertaintyRow,
  SaleAttemptRepository
} from '../repositories/saleAttempt.repository'
import type { UploadDependencyRepository } from '../repositories/uploadDependency.repository'
import type { LocalSaleService } from './localSale.service'

export interface SupportIssuesSessionReader {
  getContext(): {
    readonly isAuthenticated: boolean
    readonly companyUuid: string | null
    readonly deviceUuid: string | null
    readonly userUuid: string | null
  }
}

export interface SupportIssuesDependencies {
  readonly session: SupportIssuesSessionReader
  readonly allocationDispatches: Pick<AllocationDispatchRepository, 'listForOwnerByStates'>
  readonly saleAttempts: Pick<
    SaleAttemptRepository,
    'listOpenLegacyUncertainties' | 'findBlockingForOwner'
  >
  readonly recoverySummary: Pick<LocalSaleService, 'recoverySummary'>['recoverySummary']
  /** Display name from the installed catalog, or `null` when the product is no longer in it. */
  readonly productName: (productUuid: string) => string | null
  /** Rev 4 §10.4: uploads held behind a terminal predecessor. Absent → none are listed. */
  readonly uploadDependencies?: Pick<UploadDependencyRepository, 'listHeld'>
}

const EMPTY: SyncSupportIssues = {
  needsSupport: [],
  automaticReconciliation: [],
  paymentAwaitingDecision: null
}

const QUANTITY = /^\d{1,9}(\.\d{1,3})?$/

/**
 * A stable, non-secret reference a cashier can read to support: a two-letter source prefix and the
 * first twelve hex digits of the request/attempt identity. Neither identity is a credential.
 */
export function supportReference(prefix: 'AD' | 'SA' | 'IN' | 'QC', identity: string): string {
  const hex = identity.replace(/[^0-9a-f]/gi, '').toUpperCase()
  return `${prefix}-${hex.slice(0, 12).padEnd(12, '0')}`
}

/**
 * POS reliability — the read-only projection behind the Sync page's "needs attention" view.
 *
 * It reads only durable evidence main already keeps (dispatch rows, legacy uncertainties, the
 * blocking sale attempt) and has **no** mutating operation: nothing here retries, acknowledges,
 * closes or deletes, and an unknown server outcome is never presented as resolved.
 *
 * Scope is resolved here from main's own session, never from the caller: only this company's and
 * this device's records are read. Another cashier's record on the same workstation keeps its kind,
 * dates and support reference but loses every transaction detail (products, quantities).
 */
export class SupportIssuesService {
  constructor(private readonly dependencies: SupportIssuesDependencies) {}

  list(): SyncSupportIssues {
    const context = this.dependencies.session.getContext()

    if (
      !context.isAuthenticated ||
      !context.companyUuid ||
      !context.deviceUuid ||
      !context.userUuid
    ) {
      return EMPTY
    }

    const owner = { companyUuid: context.companyUuid, deviceUuid: context.deviceUuid }
    const userUuid = context.userUuid
    const integrity = this.dependencies.allocationDispatches
      .listForOwnerByStates(owner, ['conflict', 'invalid'], SUPPORT_ISSUE_LIST_LIMIT)
      .map((row) => this.fromDispatch(row, userUuid))
    const legacy = this.dependencies.saleAttempts
      .listOpenLegacyUncertainties(owner, SUPPORT_ISSUE_LIST_LIMIT)
      .map((row) => this.fromLegacy(row, userUuid))
    const held = (
      this.dependencies.uploadDependencies?.listHeld(owner, SUPPORT_ISSUE_LIST_LIMIT) ?? []
    ).map((row) => this.fromHeldUpload(row, userUuid))
    const pending = this.dependencies.allocationDispatches
      .listForOwnerByStates(owner, ['dispatched'], SUPPORT_ISSUE_LIST_LIMIT)
      .map((row) => this.fromDispatch(row, userUuid))

    return {
      needsSupport: [...integrity, ...legacy, ...held].sort((left, right) =>
        right.occurredAt.localeCompare(left.occurredAt)
      ),
      automaticReconciliation: pending,
      paymentAwaitingDecision: this.blockingPayment({ ...owner, userUuid })
    }
  }

  private blockingPayment(owner: {
    readonly companyUuid: string
    readonly deviceUuid: string
    readonly userUuid: string
  }): SupportPaymentAwaiting | null {
    const attempt = this.dependencies.saleAttempts.findBlockingForOwner(owner)

    if (!attempt) {
      return null
    }

    const summary = this.dependencies.recoverySummary(attempt)

    return {
      reference: supportReference('SA', attempt.attemptKey),
      claimedAt: attempt.claimedAt,
      failureCode: attempt.failureCode,
      retryAvailable: !summary.needsSupport,
      legacyDispatchUnknown: summary.legacyDispatchUnknown,
      outstandingRequests: summary.outstandingRequests,
      traceId: summary.supportReference
    }
  }

  private fromDispatch(row: AllocationDispatchRow, userUuid: string): SupportIssue {
    const owned = row.actorUserUuid === userUuid
    const kind: SupportIssueKind =
      row.state === 'conflict'
        ? 'allocation-identity-conflict'
        : row.state === 'invalid'
          ? 'allocation-request-invalid'
          : 'allocation-request-pending'
    const pending = row.state === 'dispatched'

    return {
      kind,
      reference: supportReference('AD', row.idempotencyKey),
      traceId: row.lastOutcome?.traceId ?? null,
      occurredAt: row.createdAt,
      updatedAt: row.resolvedAt,
      ownedByCurrentUser: owned,
      lines: owned
        ? this.lines(
            row.requestBody.items.map((item) => ({
              productUuid: item.product_uuid,
              quantity: item.quantity
            }))
          )
        : null,
      sendCount: pending ? row.sendCount : null,
      nextAttemptAfter: pending ? row.retryNotBefore : null,
      relatedReference: null
    }
  }

  private fromHeldUpload(
    row: ReturnType<UploadDependencyRepository['listHeld']>[number],
    userUuid: string
  ): SupportIssue {
    if (row.entity) {
      return {
        kind: 'upload-held-by-entity',
        reference: supportReference('IN', row.invoiceLocalUuid),
        traceId: null,
        occurredAt: row.createdAt,
        updatedAt: null,
        ownedByCurrentUser: row.userUuid === userUuid,
        lines: null,
        sendCount: null,
        nextAttemptAfter: null,
        relatedReference: row.entity.requestKey
          ? supportReference('QC', row.entity.requestKey)
          : null
      }
    }
    return {
      kind: 'upload-held-by-predecessor',
      reference: supportReference('IN', row.invoiceLocalUuid),
      traceId: null,
      occurredAt: row.createdAt,
      updatedAt: null,
      ownedByCurrentUser: row.userUuid === userUuid,
      lines: null,
      sendCount: null,
      nextAttemptAfter: null,
      relatedReference: row.predecessor
        ? supportReference('IN', row.predecessor.invoiceLocalUuid)
        : null
    }
  }

  private fromLegacy(row: LegacyDispatchUncertaintyRow, userUuid: string): SupportIssue {
    const owned = row.userUuid === userUuid

    return {
      kind: 'legacy-dispatch-uncertainty',
      reference: supportReference('SA', row.attemptKey),
      traceId: null,
      occurredAt: row.claimedAt,
      updatedAt: row.recordedAt,
      ownedByCurrentUser: owned,
      lines: owned ? this.lines(row.productQuantities) : null,
      sendCount: null,
      nextAttemptAfter: null,
      relatedReference: null
    }
  }

  private lines(
    items: readonly { readonly productUuid: string; readonly quantity: string }[]
  ): SupportIssueLine[] {
    return items
      .filter((item) => QUANTITY.test(item.quantity))
      .slice(0, 200)
      .map((item) => ({
        productName: this.dependencies.productName(item.productUuid),
        quantity: item.quantity
      }))
  }
}
