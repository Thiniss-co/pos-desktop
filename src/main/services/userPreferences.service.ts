import type {
  SetUserPreferenceInput,
  UserPreferences
} from '@shared/contracts/preferences.contract'
import { createPublicError } from '../http/apiError'
import type {
  PreferenceOwner,
  UserPreferencesRepository
} from '../repositories/userPreferences.repository'

export interface UserPreferencesDependencies {
  readonly session: {
    getContext(): {
      readonly isAuthenticated: boolean
      readonly companyUuid: string | null
      readonly userUuid: string | null
    }
  }
  readonly repository: Pick<UserPreferencesRepository, 'get' | 'set'>
  readonly now?: () => Date
}

/** Defaults when a user never chose: touch layout off, automatic printing ON (D3). */
export const USER_PREFERENCE_DEFAULTS: UserPreferences = { touchMode: false, autoPrint: true }

/**
 * POS improvements, Stage 5: per-user preferences for the signed-in user only. Reads before
 * sign-in return the defaults; writes require a signed-in user with a known company.
 */
export class UserPreferencesService {
  constructor(private readonly dependencies: UserPreferencesDependencies) {}

  current(): UserPreferences {
    const owner = this.owner()
    if (owner === null) {
      return USER_PREFERENCE_DEFAULTS
    }
    return this.read(owner)
  }

  /** The automatic-print preference of one specific user (Stage 7 records it at commit). */
  autoPrintFor(owner: PreferenceOwner): boolean {
    return (
      this.dependencies.repository.get(owner, 'printing.autoPrint') ??
      USER_PREFERENCE_DEFAULTS.autoPrint
    )
  }

  set(input: SetUserPreferenceInput): UserPreferences {
    const owner = this.owner()
    if (owner === null) {
      throw createPublicError('authentication', 'Sign in to change your preferences.', false)
    }
    this.dependencies.repository.set(
      owner,
      input.key,
      input.value,
      (this.dependencies.now?.() ?? new Date()).toISOString()
    )
    return this.read(owner)
  }

  private read(owner: PreferenceOwner): UserPreferences {
    return {
      touchMode:
        this.dependencies.repository.get(owner, 'ui.touchMode') ??
        USER_PREFERENCE_DEFAULTS.touchMode,
      autoPrint: this.autoPrintFor(owner)
    }
  }

  private owner(): PreferenceOwner | null {
    const context = this.dependencies.session.getContext()
    if (!context.isAuthenticated || context.companyUuid === null || context.userUuid === null) {
      return null
    }
    return { companyUuid: context.companyUuid, userUuid: context.userUuid }
  }
}
