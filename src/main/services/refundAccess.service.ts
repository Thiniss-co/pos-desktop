import { publicAppErrorSchema } from '@shared/contracts/api.contract'

export interface RefundAccessDependencies {
  readonly permissions: { hasPermission(permission: string): boolean }
  readonly commercialAccess: { assertAllowed(action: 'sell'): void }
}

/**
 * Plan §4 — mirrors the backend's own refund gates on the main-process side, so the cashier learns
 * of a denial before any dispatch, not merely at 403. The backend route middleware
 * (`desktop.context:sell,refunds,pos.refund`) remains the sole authority; this is advisory.
 */
export class RefundAccessService {
  constructor(private readonly dependencies: RefundAccessDependencies) {}

  assertCanRefund(): void {
    this.dependencies.commercialAccess.assertAllowed('sell')

    if (!this.dependencies.permissions.hasPermission('pos.refund')) {
      throw publicAppErrorSchema.parse({
        category: 'authorization',
        message: 'Refunds are not available for this workstation session.',
        backendCode: 'PERMISSION_DENIED',
        retryable: false
      })
    }
  }
}
