import { publicAppErrorSchema, type PublicAppError } from '@shared/contracts/api.contract'
import type {
  CheckoutIntent,
  CheckoutPreviewOutcome,
  ShiftUnavailableState
} from '@shared/contracts/checkout.contract'
import { calculateCart } from '@shared/pos/posCalculator'
import {
  calculatePayments,
  type PaymentInputRow,
  type ResolvedPaymentMethod
} from '@shared/pos/paymentCalculator'
import type { CheckoutResolutionInput } from '../repositories/catalog.repository'
import type { CatalogService } from './catalog.service'
import type { CommercialAccessService } from './commercialAccess.service'
import type { ShiftAuthority, ShiftAuthorityService } from './shiftAuthority.service'

export interface CheckoutPermissionReader {
  hasPermission(permission: string): boolean
}

export interface CheckoutPreviewDependencies {
  readonly commercialAccess: Pick<CommercialAccessService, 'assertAllowed' | 'evaluate'>
  readonly permissions: CheckoutPermissionReader
  readonly shiftAuthority: Pick<ShiftAuthorityService, 'resolveForSell'>
  readonly catalog: Pick<CatalogService, 'resolveForCheckout'>
  readonly now?: () => Date
}

function permissionDeniedError(): PublicAppError {
  return publicAppErrorSchema.parse({
    category: 'authorization',
    message: 'Your account does not have permission to sell.',
    backendCode: 'CHECKOUT_PERMISSION_DENIED',
    retryable: false
  })
}

type UnavailableShiftAuthority = Exclude<ShiftAuthority, { readonly kind: 'open' }>

function shiftUnavailableState(authority: UnavailableShiftAuthority): ShiftUnavailableState {
  switch (authority.kind) {
    case 'not-open':
      return authority.status
    case 'reconciliation-required':
      return 'reconciliation-required'
    case 'none':
    case 'unknown':
    case 'foreign':
      return authority.kind
  }
}

function resolutionInput(intent: CheckoutIntent): CheckoutResolutionInput {
  return {
    productUuids: intent.items.map((item) => item.productUuid),
    paymentMethodUuids: intent.payments.map((payment) => payment.paymentMethodUuid),
    customerUuid: intent.customerUuid
  }
}

/**
 * The authoritative main-process checkout validation. Produces **a preview and a payment draft,
 * nothing else** — it never writes an invoice, payment, outbox, or stock row, never mutates a
 * shift, and never calls a payment processor. A `valid` outcome is not an authorization token: no
 * `validated` flag, no nonce, no cached decision is persisted from it. Phase 3F re-resolves,
 * re-validates, and recalculates everything inside its own transaction before it may write
 * anything; this service's `valid` outcome grants no authority over that later step.
 */
export class CheckoutPreviewService {
  private readonly now: () => Date

  constructor(private readonly dependencies: CheckoutPreviewDependencies) {
    this.now = dependencies.now ?? (() => new Date())
  }

  validate(intent: CheckoutIntent): CheckoutPreviewOutcome {
    this.dependencies.commercialAccess.assertAllowed('sell')

    if (!this.dependencies.permissions.hasPermission('pos.sell')) {
      throw permissionDeniedError()
    }

    const shift = this.dependencies.shiftAuthority.resolveForSell()
    if (shift.kind !== 'open') {
      return { outcome: 'shift-unavailable', state: shiftUnavailableState(shift) }
    }

    const input = resolutionInput(intent)
    const resolution = this.dependencies.catalog.resolveForCheckout(input)

    if (!resolution || resolution.contract.revision !== intent.catalogRevision) {
      return { outcome: 'refresh-required', draftRevision: intent.draftRevision }
    }

    const productsByUuid = new Map(resolution.products.map((product) => [product.uuid, product]))
    const cart = calculateCart(
      intent.items.map((item) => {
        const product = productsByUuid.get(item.productUuid)
        if (!product) {
          throw new Error('resolveForCheckout returned an incomplete product set')
        }

        return {
          id: item.id,
          productUuid: item.productUuid,
          quantity: item.quantity,
          unitPriceAmount: product.price.amount,
          currency: product.price.currency,
          discountType: item.discountType,
          discountValue: item.discountValue,
          taxMode: product.tax.mode,
          taxRateBasisPoints: product.tax.rateBasisPoints
        }
      }),
      resolution.contract,
      intent.invoiceDiscount.discountType,
      intent.invoiceDiscount.discountValue
    )

    if (!cart.ok) {
      return {
        outcome: 'invalid',
        code: cart.code,
        field: null,
        draftRevision: intent.draftRevision
      }
    }

    const resolvedMethods: readonly ResolvedPaymentMethod[] = resolution.paymentMethods.map(
      (method) => ({
        uuid: method.uuid,
        type: method.type,
        isActive: method.isActive,
        requiresReference: method.requiresReference,
        allowsChange: method.allowsChange
      })
    )
    const paymentRows: readonly PaymentInputRow[] = intent.payments.map((payment) => ({
      id: payment.id,
      methodUuid: payment.paymentMethodUuid,
      amount: payment.amount,
      reference: payment.reference
    }))
    const payments = calculatePayments(paymentRows, resolvedMethods, cart.value.grandTotalAmount)

    if (!payments.ok) {
      return {
        outcome: 'invalid',
        code: payments.code,
        field: 'payments',
        draftRevision: intent.draftRevision
      }
    }

    // Re-checked after every read above, so a mutation landing mid-preview (a shift closed on
    // another terminal, a permission revoked, a catalog republished) can never be reported valid.
    if (!this.dependencies.commercialAccess.evaluate('sell').allowed) {
      return { outcome: 'context-changed', draftRevision: intent.draftRevision }
    }

    const recheckedShift = this.dependencies.shiftAuthority.resolveForSell()
    if (recheckedShift.kind !== 'open' || recheckedShift.shiftUuid !== shift.shiftUuid) {
      return { outcome: 'context-changed', draftRevision: intent.draftRevision }
    }

    const recheckedResolution = this.dependencies.catalog.resolveForCheckout(input)
    if (
      !recheckedResolution ||
      recheckedResolution.contract.revision !== resolution.contract.revision
    ) {
      return { outcome: 'context-changed', draftRevision: intent.draftRevision }
    }

    return {
      outcome: 'valid',
      totals: { ...cart.value, lines: cart.value.lines.map((line) => ({ ...line })) },
      payments: { ...payments.value, rows: payments.value.rows.map((row) => ({ ...row })) },
      changeDueAmount: payments.value.changeDueAmount,
      dueAmount: payments.value.dueAmount,
      warnings: [],
      catalogRevision: resolution.contract.revision,
      draftRevision: intent.draftRevision,
      shiftObservedAt: shift.observedAt,
      evaluatedAt: this.now().toISOString()
    }
  }
}
