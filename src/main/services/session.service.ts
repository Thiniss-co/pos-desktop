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
  /**
   * Fired after the session was started, ended, or successfully refreshed. A scheduling hint for
   * main-owned observers (the device heartbeat); it carries no data and grants nothing. It can
   * never break the session transition: a throwing listener is swallowed.
   */
  readonly onChanged?: () => void
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
    this.notifyChanged()
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
    this.notifyChanged()
  }

  endSession(): void {
    const wasAuthenticated = this.repository.getSummary().isAuthenticated

    try {
      this.secureStorage.deleteSecret(DESKTOP_ACCESS_TOKEN_KEY)
      this.runTransaction(() => {
        this.repository.clear()
        if (wasAuthenticated) {
          this.dependencies.epoch?.increment()
        }
        this.dependencies.observations?.clear()
      })
    } finally {
      // Even a partially failed teardown may already have deleted the token, so observers are told
      // to re-read state either way; the original error still propagates.
      this.notifyChanged()
    }
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

  private notifyChanged(): void {
    try {
      this.dependencies.onChanged?.()
    } catch {
      // An observer must never be able to fail a session transition.
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
