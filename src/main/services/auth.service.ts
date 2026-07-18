import { publicAppErrorSchema, type PublicAppError } from '@shared/contracts/api.contract'
import {
  loginInputSchema,
  sessionSummarySchema,
  type LoginInput,
  type SessionSummary
} from '@shared/contracts/auth.contract'
import { DESKTOP_API_ROUTES } from '@shared/constants/apiRoutes'
import { isPublicAppError } from '../http/apiError'
import type { DesktopApiClient } from '../http/desktopApiClient'
import { desktopSessionResourceSchema } from '../http/desktopResources.contract'
import type { SessionEstablishInput } from '../repositories/sessionMetadata.repository'
import type { StoredDeviceIdentity } from './deviceIdentity.service'

export const DESKTOP_ACCESS_TOKEN_KEY = 'desktop_access_token'

export interface AuthDeviceIdentityRepository {
  get(): StoredDeviceIdentity | null
}

export interface AuthSessionMetadataRepository {
  getSummary(): SessionSummary
  establish(input: SessionEstablishInput): void
  clear(): void
}

export interface AuthSecureStorage {
  getStatus(): { encryptionAvailable: boolean }
  getSecret(key: string): string | null
  setSecret(key: string, value: string): void
  deleteSecret(key: string): void
}

function configurationError(message: string): PublicAppError {
  return publicAppErrorSchema.parse({ category: 'configuration', message, retryable: false })
}

export class AuthService {
  constructor(
    private readonly apiClient: DesktopApiClient,
    private readonly deviceIdentityRepository: AuthDeviceIdentityRepository,
    private readonly sessionMetadataRepository: AuthSessionMetadataRepository,
    private readonly secureStorage: AuthSecureStorage
  ) {}

  async login(rawInput: LoginInput): Promise<SessionSummary> {
    const input = loginInputSchema.parse(rawInput)
    const identity = this.deviceIdentityRepository.get()

    if (!identity || !identity.isRegistered) {
      throw configurationError('This workstation has not completed device activation')
    }

    if (!this.secureStorage.getStatus().encryptionAvailable) {
      throw configurationError('Encrypted secret storage is unavailable on this device')
    }

    const response = await this.apiClient.request(DESKTOP_API_ROUTES.authLogin, {
      email: input.email,
      password: input.password,
      device_uuid: identity.deviceUuid,
      device_name: identity.deviceName
    })

    const resource = desktopSessionResourceSchema.parse(response)

    this.secureStorage.setSecret(DESKTOP_ACCESS_TOKEN_KEY, resource.token)

    try {
      this.sessionMetadataRepository.establish({
        userName: resource.user.name,
        userEmail: resource.user.email
      })
    } catch (error) {
      this.secureStorage.deleteSecret(DESKTOP_ACCESS_TOKEN_KEY)
      throw error
    }

    return sessionSummarySchema.parse(this.sessionMetadataRepository.getSummary())
  }

  async refreshSession(): Promise<SessionSummary> {
    const existing = this.sessionMetadataRepository.getSummary()

    if (!existing.isAuthenticated) {
      return existing
    }

    const token = this.secureStorage.getSecret(DESKTOP_ACCESS_TOKEN_KEY)

    if (!token) {
      this.sessionMetadataRepository.clear()
      return this.sessionMetadataRepository.getSummary()
    }

    try {
      await this.apiClient.request(DESKTOP_API_ROUTES.authMe)
      return existing
    } catch (error) {
      if (isPublicAppError(error) && error.category === 'authentication') {
        this.secureStorage.deleteSecret(DESKTOP_ACCESS_TOKEN_KEY)
        this.sessionMetadataRepository.clear()
        return this.sessionMetadataRepository.getSummary()
      }

      throw error
    }
  }

  async logout(): Promise<void> {
    try {
      await this.apiClient.request(DESKTOP_API_ROUTES.authLogout)
    } finally {
      this.secureStorage.deleteSecret(DESKTOP_ACCESS_TOKEN_KEY)
      this.sessionMetadataRepository.clear()
    }
  }
}
