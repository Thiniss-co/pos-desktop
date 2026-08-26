import { publicAppErrorSchema } from '@shared/contracts/api.contract'
import { isTerminalDeviceStatus } from '@shared/constants/deviceStatuses'
import type { StoredDeviceIdentity } from './deviceIdentity.service'
import type { DeviceRegistrationRecord } from '../repositories/deviceRegistration.repository'
import type { SessionContext } from '../repositories/sessionMetadata.repository'
import type { BootstrapCompany } from '../repositories/bootstrapSnapshot.repository'

export interface CatalogReadAccessDependencies {
  readonly identity: { get(): StoredDeviceIdentity | null }
  readonly deviceRegistration: { get(): DeviceRegistrationRecord | null }
  readonly session: { getContext(): SessionContext }
  readonly secrets: { getSecret(key: string): string | null }
  readonly company: { getCompany(): BootstrapCompany | null }
  readonly permissions: { hasPermission(permission: string): boolean }
}

export interface CatalogReadDecision {
  readonly allowed: boolean
}

export interface CatalogReadAccess {
  evaluate(): CatalogReadDecision
  assertAllowed(): void
}

/**
 * Catalog reads intentionally do not reuse the sell/sync policy: a signed-in `pos.view` user can
 * inspect the retained snapshot while offline, without an open shift, `pos.sell`, or `canSync`.
 */
export class CatalogReadAccessService {
  constructor(private readonly dependencies: CatalogReadAccessDependencies) {}

  evaluate(): CatalogReadDecision {
    const identity = this.dependencies.identity.get()
    const registration = this.dependencies.deviceRegistration.get()

    if (
      !identity?.isRegistered ||
      !registration ||
      isTerminalDeviceStatus(registration.status) ||
      !this.dependencies.secrets.getSecret('desktop_access_token')
    ) {
      return { allowed: false }
    }

    const session = this.dependencies.session.getContext()
    if (!session.isAuthenticated || !session.userIsActive) {
      return { allowed: false }
    }

    if (
      session.deviceUuid !== identity.deviceUuid ||
      session.serverDeviceId !== registration.serverDeviceId
    ) {
      return { allowed: false }
    }

    const company = this.dependencies.company.getCompany()
    if (!company || !company.isActive || session.companyUuid !== company.companyUuid) {
      return { allowed: false }
    }

    return { allowed: this.dependencies.permissions.hasPermission('pos.view') }
  }

  assertAllowed(): void {
    if (!this.evaluate().allowed) {
      throw publicAppErrorSchema.parse({
        category: 'authorization',
        message: 'Catalog access is not available for this workstation session.',
        backendCode: 'CATALOG_READ_ACCESS_DENIED',
        retryable: false
      })
    }
  }
}
