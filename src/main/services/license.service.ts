import { ZodError } from 'zod'
import { licenseStatusSchema, type LicenseStatus } from '@shared/contracts/license.contract'
import { publicAppErrorSchema, type PublicAppError } from '@shared/contracts/api.contract'
import { DESKTOP_API_ROUTES } from '@shared/constants/apiRoutes'
import type { DesktopApiClient } from '../http/desktopApiClient'
import { licenseResourceSchema } from '../http/desktopResources.contract'

export const DESKTOP_LICENSE_JWT_KEY = 'desktop_license_jwt'

export interface LicenseSecureStorage {
  setSecret(key: string, value: string): void
}

export interface LicenseMetadataWriter {
  getTrustedTimeAnchor(): string | null
  setValidatedStatus(status: LicenseStatus, trustedTimeAnchor: string): void
}

function licenseContractError(): PublicAppError {
  return publicAppErrorSchema.parse({
    category: 'unexpected',
    message:
      'The service returned unsupported license data. Please update the desktop application or contact support.',
    backendCode: 'license_payload_contract_invalid',
    retryable: false
  })
}

function timestampValue(value: string): number {
  const timestamp = Date.parse(value)

  if (Number.isNaN(timestamp)) {
    throw new Error('Expected an ISO-8601 timestamp')
  }

  return timestamp
}

export class LicenseService {
  constructor(
    private readonly apiClient: DesktopApiClient,
    private readonly licenseMetadataRepository: LicenseMetadataWriter,
    private readonly secureStorage: LicenseSecureStorage,
    private readonly now: () => Date = () => new Date()
  ) {}

  async validate(): Promise<LicenseStatus> {
    const response = await this.apiClient.request(DESKTOP_API_ROUTES.licenseValidate)
    let resource: ReturnType<typeof licenseResourceSchema.parse>
    let status: LicenseStatus

    try {
      resource = licenseResourceSchema.parse(response)
      status = licenseStatusSchema.parse({
        restrictionLevel: resource.access.restriction_level,
        canSell: resource.access.can_sell,
        canSync: resource.access.can_sync,
        isActive: resource.access.is_active,
        isInGrace: resource.access.is_in_grace,
        isExpired: resource.access.is_expired,
        expiresAt: resource.expires_at,
        warningMessage: resource.access.warning_message ?? null,
        validatedAt: resource.last_validated_at,
        serverTime: resource.server_time,
        nextValidationDueAt: resource.next_validation_due_at,
        maxOfflineHours: resource.max_offline_hours,
        subscription: resource.subscription
          ? {
              status: resource.subscription.status,
              expiresAt: resource.subscription.expires_at,
              graceEndsAt: resource.subscription.grace_ends_at
            }
          : null
      })
    } catch (error) {
      if (error instanceof ZodError) {
        throw licenseContractError()
      }

      throw error
    }

    const currentTime = this.now()
    const existingAnchor = this.licenseMetadataRepository.getTrustedTimeAnchor()
    const existingAnchorTimestamp = existingAnchor
      ? Date.parse(existingAnchor)
      : Number.NEGATIVE_INFINITY
    const trustedTimeAnchor = new Date(
      Math.max(
        timestampValue(status.serverTime),
        Number.isNaN(existingAnchorTimestamp) ? Number.NEGATIVE_INFINITY : existingAnchorTimestamp,
        currentTime.getTime()
      )
    ).toISOString()

    this.secureStorage.setSecret(DESKTOP_LICENSE_JWT_KEY, resource.token)
    this.licenseMetadataRepository.setValidatedStatus(status, trustedTimeAnchor)

    return status
  }
}
