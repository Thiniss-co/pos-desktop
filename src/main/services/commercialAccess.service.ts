import { publicAppErrorSchema, type PublicAppError } from '@shared/contracts/api.contract'
import type { SessionSummary } from '@shared/contracts/auth.contract'
import {
  commercialAccessDecisionSchema,
  commercialAccessSnapshotSchema,
  type CommercialAccessDecision,
  type CommercialAccessReason,
  type CommercialAccessSnapshot,
  type LicenseStatus
} from '@shared/contracts/license.contract'
import { LICENSE_TRUSTED_TIME_ANCHOR_KEY } from '../repositories/licenseMetadata.repository'

const CLOCK_ROLLBACK_TOLERANCE_MS = 60_000
const VALIDATION_DUE_SOON_WINDOW_MS = 24 * 60 * 60 * 1_000

type CommercialAction = 'sell' | 'sync'

export interface CommercialAccessSessionReader {
  getSummary(): SessionSummary
}

export interface CommercialAccessLicenseReader {
  getStatus(): LicenseStatus | null
}

export interface CommercialAccessPermissionReader {
  hasPermission(permission: string): boolean
}

export interface CommercialAccessSettingsReader {
  get(key: string): string | null
}

function timestamp(value: string): number | null {
  const result = Date.parse(value)
  return Number.isNaN(result) ? null : result
}

function denied(reason: CommercialAccessReason): CommercialAccessDecision {
  return commercialAccessDecisionSchema.parse({
    allowed: false,
    reason,
    warning: null
  })
}

function allowed(warning: CommercialAccessDecision['warning'] = null): CommercialAccessDecision {
  return commercialAccessDecisionSchema.parse({
    allowed: true,
    reason: null,
    warning
  })
}

function messageForReason(reason: CommercialAccessReason): string {
  const messages: Record<CommercialAccessReason, string> = {
    'session-invalid': 'Sign in with an active account to continue.',
    'clock-untrusted': 'This device clock must be corrected before commercial access can continue.',
    'license-state-invalid':
      'License validation is required before commercial access can continue.',
    'grace-ended': 'The subscription grace period has ended.',
    'validation-overdue':
      'License validation is overdue. Connect to the desktop service to continue.',
    'license-denied': 'This workstation is not permitted to perform that action.',
    'permission-denied': 'Your account does not have permission to sell.'
  }

  return messages[reason]
}

function accessError(reason: CommercialAccessReason): PublicAppError {
  return publicAppErrorSchema.parse({
    category: reason === 'session-invalid' ? 'authentication' : 'authorization',
    message: messageForReason(reason),
    backendCode: `commercial_access_${reason}`,
    retryable: false
  })
}

/**
 * The main-process authority for offline commercial access. A stored license never broadens an
 * explicit backend denial, and moving the workstation clock backwards cannot extend access.
 */
export class CommercialAccessService {
  constructor(
    private readonly session: CommercialAccessSessionReader,
    private readonly licenseMetadata: CommercialAccessLicenseReader,
    private readonly permissions: CommercialAccessPermissionReader,
    private readonly settings: CommercialAccessSettingsReader,
    private readonly now: () => Date = () => new Date()
  ) {}

  assertCanSell(): void {
    this.assert('sell')
  }

  assertCanSync(): void {
    this.assert('sync')
  }

  describe(): CommercialAccessSnapshot {
    return commercialAccessSnapshotSchema.parse({
      sell: this.decisionFor('sell'),
      sync: this.decisionFor('sync')
    })
  }

  private assert(action: CommercialAction): void {
    const decision = this.decisionFor(action)

    if (!decision.allowed) {
      throw accessError(decision.reason ?? 'license-state-invalid')
    }
  }

  private decisionFor(action: CommercialAction): CommercialAccessDecision {
    if (!this.session.getSummary().isAuthenticated) {
      return denied('session-invalid')
    }

    const license = this.licenseMetadata.getStatus()

    if (!license) {
      return denied('license-state-invalid')
    }

    const now = this.now().getTime()
    const serverTime = timestamp(license.serverTime)
    const validatedAt = timestamp(license.validatedAt)
    const nextValidationDueAt = timestamp(license.nextValidationDueAt)
    const trustedTimeAnchor = this.settings.get(LICENSE_TRUSTED_TIME_ANCHOR_KEY)
    const anchor = trustedTimeAnchor ? timestamp(trustedTimeAnchor) : null

    if (
      serverTime === null ||
      validatedAt === null ||
      nextValidationDueAt === null ||
      nextValidationDueAt < validatedAt ||
      anchor === null
    ) {
      return denied('license-state-invalid')
    }

    if (now < anchor - CLOCK_ROLLBACK_TOLERANCE_MS) {
      return denied('clock-untrusted')
    }

    const subscriptionDecision = this.subscriptionDecision(license, now)

    if (subscriptionDecision) {
      return subscriptionDecision
    }

    if (now >= nextValidationDueAt) {
      return denied('validation-overdue')
    }

    if (action === 'sell' ? !license.canSell : !license.canSync) {
      return denied('license-denied')
    }

    if (action === 'sell' && !this.permissions.hasPermission('pos.sell')) {
      return denied('permission-denied')
    }

    const subscription = license.subscription
    const expiry = subscription?.expiresAt ? timestamp(subscription.expiresAt) : null

    if (expiry !== null && now >= expiry) {
      return allowed('grace')
    }

    if (nextValidationDueAt - now <= VALIDATION_DUE_SOON_WINDOW_MS) {
      return allowed('validation-due-soon')
    }

    return allowed()
  }

  private subscriptionDecision(
    license: LicenseStatus,
    now: number
  ): CommercialAccessDecision | null {
    const subscription = license.subscription

    if (!subscription?.expiresAt) {
      return null
    }

    const expiresAt = timestamp(subscription.expiresAt)
    const graceEndsAt = subscription.graceEndsAt ? timestamp(subscription.graceEndsAt) : null

    if (
      expiresAt === null ||
      (subscription.graceEndsAt !== null && graceEndsAt === null) ||
      (graceEndsAt !== null && graceEndsAt < expiresAt)
    ) {
      return denied('license-state-invalid')
    }

    if (now < expiresAt) {
      return null
    }

    if (graceEndsAt === null || now >= graceEndsAt) {
      return denied('grace-ended')
    }

    return null
  }
}
