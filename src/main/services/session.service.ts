import type { SessionSummary } from '@shared/contracts/auth.contract'
import type { PublicAppError } from '@shared/contracts/api.contract'
import { isDeviceTransitionError, isSessionEndingError } from '@shared/constants/sessionTransitions'
import type {
  SessionContext,
  SessionEstablishInput
} from '../repositories/sessionMetadata.repository'
import type { SessionEpochRepository } from '../repositories/sessionEpoch.repository'
import type { ShiftObservationRepository } from '../repositories/shiftObservation.repository'

export const DESKTOP_ACCESS_TOKEN_KEY = 'desktop_access_token'

export interface SessionMetadataRepository {
  getSummary(): SessionSummary
  getContext?(): SessionContext
  establish?(input: SessionEstablishInput): void
  clear(): void
}

export interface SessionSecureStorage {
  deleteSecret(key: string): void
}

export interface SessionTransactionRunner {
  transaction<T>(fn: () => T): () => T
}

export interface SessionLifecycleDependencies {
  readonly database?: SessionTransactionRunner
  readonly epoch?: Pick<SessionEpochRepository, 'increment'>
  readonly observations?: Pick<ShiftObservationRepository, 'clear'>
}

export class SessionService {
  constructor(
    private readonly repository: SessionMetadataRepository,
    private readonly secureStorage: SessionSecureStorage,
    private readonly dependencies: SessionLifecycleDependencies = {}
  ) {}

  getSummary(): SessionSummary {
    return this.repository.getSummary()
  }

  startSession(input: SessionEstablishInput): void {
    if (!this.repository.establish) {
      throw new Error('The session metadata repository cannot establish a session')
    }

    this.runTransaction(() => {
      this.repository.establish?.(input)
      this.dependencies.epoch?.increment()
      this.dependencies.observations?.clear()
    })
  }

  refreshSession(input: SessionEstablishInput): void {
    if (!this.repository.establish) {
      throw new Error('The session metadata repository cannot refresh a session')
    }

    const previous = this.repository.getContext?.()
    this.runTransaction(() => {
      this.repository.establish?.(input)
      if (previous && this.sessionBindingChanged(previous, input)) {
        this.dependencies.observations?.clear()
      }
    })
  }

  endSession(): void {
    const wasAuthenticated = this.repository.getSummary().isAuthenticated
    this.secureStorage.deleteSecret(DESKTOP_ACCESS_TOKEN_KEY)
    this.runTransaction(() => {
      this.repository.clear()
      if (wasAuthenticated) {
        this.dependencies.epoch?.increment()
      }
      this.dependencies.observations?.clear()
    })
  }

  applyApiFailure(error: PublicAppError): void {
    if (isSessionEndingError(error.backendCode)) {
      this.endSession()
      return
    }

    if (isDeviceTransitionError(error.backendCode)) {
      this.runTransaction(() => this.dependencies.observations?.clear())
    }
  }

  private runTransaction(action: () => void): void {
    if (this.dependencies.database) {
      this.dependencies.database.transaction(action)()
      return
    }

    action()
  }

  private sessionBindingChanged(previous: SessionContext, next: SessionEstablishInput): boolean {
    return (
      previous.userUuid !== (next.userUuid ?? null) ||
      previous.userIsActive !== (next.userIsActive === true) ||
      previous.companyUuid !== (next.companyUuid ?? null) ||
      previous.deviceUuid !== (next.deviceUuid ?? null) ||
      previous.serverDeviceId !== (next.serverDeviceId ?? null)
    )
  }
}
