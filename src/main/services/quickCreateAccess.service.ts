import { publicAppErrorSchema } from '@shared/contracts/api.contract'
import type { QuickCreateAccess, QuickCreateEntity } from '@shared/contracts/quickCreate.contract'

export interface QuickCreateAccessDependencies {
  readonly snapshot: {
    hasPermission(permission: string): boolean
    isFeatureEnabled(code: string): boolean
    getCapabilityVersion(capability: string): number | null
    getPermissionsOwnerUserUuid(): string | null
  }
  readonly session: { getContext(): { readonly userUuid: string | null } }
}

const RULES: Record<
  QuickCreateEntity,
  { readonly feature: string; readonly permissions: readonly string[] }
> = {
  customer: { feature: 'pos', permissions: ['customers.create', 'customers.manage'] },
  supplier: { feature: 'inventory', permissions: ['suppliers.create', 'suppliers.manage'] },
  product: { feature: 'pos', permissions: ['catalog.products.create', 'catalog.manage'] }
}

/**
 * POS improvements, Stage 1 — main's own check before any quick-create, online or offline. It mirrors
 * the backend gates (`desktop.context:sync,<feature>,<x>.create|<x>.manage`) from the cached
 * bootstrap, and trusts that cache only for the user it was fetched for. The backend stays the
 * authority: a later refusal there is handled by the creation outbox, never assumed away.
 */
export class QuickCreateAccessService {
  constructor(private readonly dependencies: QuickCreateAccessDependencies) {}

  access(): QuickCreateAccess {
    const available = this.capabilityAvailable() && this.snapshotBelongsToSession()
    return {
      available,
      customer: available && this.allowed('customer'),
      supplier: available && this.allowed('supplier'),
      product: available && this.allowed('product')
    }
  }

  assertCanCreate(entity: QuickCreateEntity): void {
    if (!this.capabilityAvailable()) {
      throw publicAppErrorSchema.parse({
        category: 'authorization',
        message: 'Creating records on the register is not available with this server.',
        backendCode: 'FEATURE_NOT_ENABLED',
        retryable: false
      })
    }
    if (!this.snapshotBelongsToSession() || !this.allowed(entity)) {
      throw publicAppErrorSchema.parse({
        category: 'authorization',
        message: 'You do not have permission to create this record on the register.',
        backendCode: 'PERMISSION_DENIED',
        retryable: false
      })
    }
  }

  private capabilityAvailable(): boolean {
    return this.dependencies.snapshot.getCapabilityVersion('quick_create') === 1
  }

  private snapshotBelongsToSession(): boolean {
    const sessionUser = this.dependencies.session.getContext().userUuid
    const owner = this.dependencies.snapshot.getPermissionsOwnerUserUuid()
    return sessionUser !== null && owner !== null && sessionUser === owner
  }

  private allowed(entity: QuickCreateEntity): boolean {
    const rule = RULES[entity]
    return (
      this.dependencies.snapshot.isFeatureEnabled(rule.feature) &&
      rule.permissions.some((permission) => this.dependencies.snapshot.hasPermission(permission))
    )
  }
}
