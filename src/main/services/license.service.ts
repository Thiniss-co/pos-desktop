import { licenseStatusSchema, type LicenseStatus } from '@shared/contracts/license.contract'
import { DESKTOP_API_ROUTES } from '@shared/constants/apiRoutes'
import type { DesktopApiClient } from '../http/desktopApiClient'
import { licenseResourceSchema } from '../http/desktopResources.contract'

export const DESKTOP_LICENSE_JWT_KEY = 'desktop_license_jwt'

export interface LicenseSecureStorage {
  setSecret(key: string, value: string): void
}

export interface LicenseMetadataWriter {
  set(status: LicenseStatus): void
}

export class LicenseService {
  constructor(
    private readonly apiClient: DesktopApiClient,
    private readonly licenseMetadataRepository: LicenseMetadataWriter,
    private readonly secureStorage: LicenseSecureStorage
  ) {}

  async validate(): Promise<LicenseStatus> {
    const response = await this.apiClient.request(DESKTOP_API_ROUTES.licenseValidate)
    const resource = licenseResourceSchema.parse(response)
    const validatedAt = new Date().toISOString()

    this.secureStorage.setSecret(DESKTOP_LICENSE_JWT_KEY, resource.token)

    const status = licenseStatusSchema.parse({
      restrictionLevel: resource.access.restriction_level,
      canSell: resource.access.can_sell,
      canSync: resource.access.can_sync,
      isActive: resource.access.is_active,
      isInGrace: resource.access.is_in_grace,
      isExpired: resource.access.is_expired,
      expiresAt: resource.expires_at,
      warningMessage: resource.access.warning_message ?? null,
      validatedAt
    })

    this.licenseMetadataRepository.set(status)

    return status
  }
}
