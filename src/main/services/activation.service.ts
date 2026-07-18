import { createHash } from 'crypto'
import {
  activationInputSchema,
  activationResultSchema,
  type ActivationInput,
  type ActivationResult
} from '@shared/contracts/activation.contract'
import { DESKTOP_API_ROUTES } from '@shared/constants/apiRoutes'
import type { DesktopApiClient } from '../http/desktopApiClient'
import { deviceRegisterResourceSchema } from '../http/desktopResources.contract'
import type { StoredDeviceIdentity } from './deviceIdentity.service'

export interface ActivationDeviceIdentityRepository {
  get(): StoredDeviceIdentity | null
  markRegisteredWithBackend(registeredAt: string): void
}

export interface ActivationDeviceRegistrationRepository {
  set(record: {
    serverDeviceId: string
    status: string
    lastSeenAt: string | null
    updatedAt: string
  }): void
}

export interface ActivationTransactionRunner {
  transaction(fn: () => void): () => void
}

export class ActivationService {
  constructor(
    private readonly database: ActivationTransactionRunner,
    private readonly deviceIdentityRepository: ActivationDeviceIdentityRepository,
    private readonly deviceRegistrationRepository: ActivationDeviceRegistrationRepository,
    private readonly apiClient: DesktopApiClient
  ) {}

  async register(rawInput: ActivationInput): Promise<ActivationResult> {
    const input = activationInputSchema.parse(rawInput)
    const identity = this.deviceIdentityRepository.get()

    if (!identity) {
      throw new Error('Local device identity is not initialized')
    }

    const fingerprintHash = createHash('sha256').update(identity.deviceUuid).digest('hex')

    const response = await this.apiClient.request(DESKTOP_API_ROUTES.deviceRegister, {
      company_code: input.companyCode,
      activation_code: input.activationCode,
      device_uuid: identity.deviceUuid,
      device_name: input.deviceName ?? identity.deviceName,
      fingerprint_hash: fingerprintHash,
      platform: identity.platform,
      os_version: identity.osVersion,
      app_version: identity.appVersion
    })

    const resource = deviceRegisterResourceSchema.parse(response)
    const timestamp = new Date().toISOString()

    this.database.transaction(() => {
      this.deviceIdentityRepository.markRegisteredWithBackend(timestamp)
      this.deviceRegistrationRepository.set({
        serverDeviceId: resource.id,
        status: resource.status,
        lastSeenAt: resource.last_seen_at ?? null,
        updatedAt: timestamp
      })
    })()

    return activationResultSchema.parse({
      deviceUuid: identity.deviceUuid,
      deviceName: resource.device_name,
      status: resource.status,
      isRegistered: true
    })
  }
}
