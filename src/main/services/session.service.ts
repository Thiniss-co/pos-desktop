import type { SessionSummary } from '@shared/contracts/auth.contract'
import type { PublicAppError } from '@shared/contracts/api.contract'
import { isSessionEndingError } from '@shared/constants/sessionTransitions'

export const DESKTOP_ACCESS_TOKEN_KEY = 'desktop_access_token'

export interface SessionMetadataRepository {
  getSummary(): SessionSummary
  clear(): void
}

export interface SessionSecureStorage {
  deleteSecret(key: string): void
}

export class SessionService {
  constructor(
    private readonly repository: SessionMetadataRepository,
    private readonly secureStorage: SessionSecureStorage
  ) {}

  getSummary(): SessionSummary {
    return this.repository.getSummary()
  }

  endSession(): void {
    this.secureStorage.deleteSecret(DESKTOP_ACCESS_TOKEN_KEY)
    this.repository.clear()
  }

  applyApiFailure(error: PublicAppError): void {
    if (isSessionEndingError(error.backendCode)) {
      this.endSession()
    }
  }
}
