import { publicAppErrorSchema, type PublicAppError } from '@shared/contracts/api.contract'
import type { SessionSummary } from '@shared/contracts/auth.contract'
import type { ConnectivitySnapshot } from '@shared/contracts/connectivity.contract'
import {
  COMMERCIAL_ACCESS_REASON_CLASSIFICATION,
  commercialAccessDecisionSchema,
  commercialAccessSnapshotSchema,
  type CommercialAccessAction,
  type CommercialAccessDecision,
  type CommercialAccessReason,
  type CommercialAccessSnapshot,
  type LicenseStatus
} from '@shared/contracts/license.contract'
import {
  CONNECTIVITY_PRECONDITION,
  meetsConnectivityPrecondition
} from '@shared/contracts/connectivityPolicy.contract'
import { canDevicePerformAction, isTerminalDeviceStatus } from '@shared/constants/deviceStatuses'
import { LICENSE_TRUSTED_TIME_ANCHOR_KEY } from '../repositories/licenseMetadata.repository'

const CLOCK_ROLLBACK_TOLERANCE_MS = 60_000
const VALIDATION_DUE_SOON_WINDOW_MS = 24 * 60 * 60 * 1_000

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

export interface CommercialAccessDeviceReader {
  get(): { readonly status: string } | null
}

export interface CommercialAccessCompanyReader {
  getCompany(): { readonly isActive: boolean } | null
}

export interface CommercialAccessFeatureReader {
  isFeatureEnabled(code: string): boolean
}

export interface CommercialAccessConnectivityReader {
  getSnapshot(): ConnectivitySnapshot
}

export interface CommercialAccessServiceOptions {
  readonly session: CommercialAccessSessionReader
  readonly licenseMetadata: CommercialAccessLicenseReader
  readonly permissions: CommercialAccessPermissionReader
  readonly settings: CommercialAccessSettingsReader
  readonly devices: CommercialAccessDeviceReader
  readonly company: CommercialAccessCompanyReader
  readonly features: CommercialAccessFeatureReader
  readonly connectivity: CommercialAccessConnectivityReader
  readonly now?: () => Date
}

interface ValidatedLicenseState {
  readonly status: LicenseStatus
  readonly trustedTimeAnchor: number
  readonly expiresAt: number | null
  readonly graceEndsAt: number | null
  readonly nextValidationDueAt: number
}

function timestamp(value: string): number | null {
  const result = Date.parse(value)
  return Number.isNaN(result) ? null : result
}

function messageForReason(reason: CommercialAccessReason): string {
  const messages: Record<CommercialAccessReason, string> = {
    'device-not-registered': 'This workstation is not registered to an active device.',
    'device-revoked': 'This workstation device has been revoked or retired.',
    'device-blocked': 'This workstation device is blocked for this action.',
    'session-invalid': 'Sign in with an active account to continue.',
    'clock-untrusted': 'This device clock must be corrected before commercial access can continue.',
    'license-state-invalid':
      'License validation is required before commercial access can continue.',
    'grace-ended': 'The subscription grace period has ended.',
    'validation-overdue':
      'License validation is overdue. Connect to the desktop service to continue.',
    'license-denied': 'This workstation is not permitted to perform that action.',
    'permission-denied': 'Your account does not have permission to sell.',
    'bootstrap-incomplete': 'Local workstation data has not completed bootstrap.',
    'company-inactive': 'This company is inactive.',
    'feature-not-enabled': 'The POS feature is not enabled for this subscription.',
    'connectivity-unavailable': 'An online connection to the desktop service is required to sync.'
  }

  return messages[reason]
}

function accessError(reason: CommercialAccessReason): PublicAppError {
  const classification = COMMERCIAL_ACCESS_REASON_CLASSIFICATION[reason]

  return publicAppErrorSchema.parse({
    category: classification.category,
    message: messageForReason(reason),
    backendCode: `COMMERCIAL_ACCESS_${reason.replaceAll('-', '_').toUpperCase()}`,
    retryable: classification.retryable
  })
}

/**
 * The main-process authority for offline commercial access. Its ordered, persisted-state checks
 * are intentionally fail-closed: a connectivity snapshot may deny a sync, but can never grant it.
 */
export class CommercialAccessService {
  private readonly now: () => Date

  constructor(private readonly options: CommercialAccessServiceOptions) {
    this.now = options.now ?? (() => new Date())
  }

  evaluate(action: CommercialAccessAction): CommercialAccessDecision {
    const evaluatedAt = this.now()
    const evaluatedAtIso = evaluatedAt.toISOString()
    const now = evaluatedAt.getTime()
    const device = this.options.devices.get()
    const deviceReason = this.deviceReason(device, action)

    if (deviceReason) {
      return this.denied(action, deviceReason, evaluatedAtIso)
    }

    if (!this.options.session.getSummary().isAuthenticated) {
      return this.denied(action, 'session-invalid', evaluatedAtIso)
    }

    const licenseState = this.licenseState()

    if (!licenseState) {
      return this.denied(action, 'license-state-invalid', evaluatedAtIso)
    }

    if (now < licenseState.trustedTimeAnchor - CLOCK_ROLLBACK_TOLERANCE_MS) {
      return this.denied(action, 'clock-untrusted', evaluatedAtIso, licenseState.status)
    }

    if (licenseState.expiresAt !== null && now >= licenseState.expiresAt) {
      if (licenseState.graceEndsAt === null || now >= licenseState.graceEndsAt) {
        return this.denied(action, 'grace-ended', evaluatedAtIso, licenseState.status)
      }
    }

    if (now >= licenseState.nextValidationDueAt) {
      return this.denied(action, 'validation-overdue', evaluatedAtIso, licenseState.status)
    }

    const company = this.options.company.getCompany()

    if (action === 'sell' && !company) {
      return this.denied(action, 'bootstrap-incomplete', evaluatedAtIso, licenseState.status)
    }

    if (company && !company.isActive) {
      return this.denied(action, 'company-inactive', evaluatedAtIso, licenseState.status)
    }

    if (action === 'sell' && !this.options.features.isFeatureEnabled('pos')) {
      return this.denied(action, 'feature-not-enabled', evaluatedAtIso, licenseState.status)
    }

    if (action === 'sell' ? !licenseState.status.canSell : !licenseState.status.canSync) {
      return this.denied(action, 'license-denied', evaluatedAtIso, licenseState.status)
    }

    if (action === 'sell' && !this.options.permissions.hasPermission('pos.sell')) {
      return this.denied(action, 'permission-denied', evaluatedAtIso, licenseState.status)
    }

    const connectivityReason = this.connectivityReason(action)

    if (connectivityReason) {
      return this.denied(action, connectivityReason, evaluatedAtIso, licenseState.status)
    }

    return this.allowed(action, evaluatedAtIso, licenseState, now)
  }

  assertAllowed(action: CommercialAccessAction): void {
    const decision = this.evaluate(action)

    if (!decision.allowed) {
      throw accessError(decision.reason ?? 'license-state-invalid')
    }
  }

  assertCanSell(): void {
    this.assertAllowed('sell')
  }

  assertCanSync(): void {
    this.assertAllowed('sync')
  }

  describe(): CommercialAccessSnapshot {
    return commercialAccessSnapshotSchema.parse({
      sell: this.evaluate('sell'),
      sync: this.evaluate('sync')
    })
  }

  private deviceReason(
    device: { readonly status: string } | null,
    action: CommercialAccessAction
  ): CommercialAccessReason | null {
    if (!device) {
      return 'device-not-registered'
    }

    if (isTerminalDeviceStatus(device.status)) {
      return 'device-revoked'
    }

    return canDevicePerformAction(device.status, action) ? null : 'device-blocked'
  }

  private licenseState(): ValidatedLicenseState | null {
    const status = this.options.licenseMetadata.getStatus()

    if (!status) {
      return null
    }

    const serverTime = timestamp(status.serverTime)
    const validatedAt = timestamp(status.validatedAt)
    const nextValidationDueAt = timestamp(status.nextValidationDueAt)
    const anchorText = this.options.settings.get(LICENSE_TRUSTED_TIME_ANCHOR_KEY)
    const trustedTimeAnchor = anchorText ? timestamp(anchorText) : null
    const expiresAt = status.subscription?.expiresAt
      ? timestamp(status.subscription.expiresAt)
      : null
    const graceEndsAt = status.subscription?.graceEndsAt
      ? timestamp(status.subscription.graceEndsAt)
      : null

    if (
      serverTime === null ||
      validatedAt === null ||
      nextValidationDueAt === null ||
      nextValidationDueAt < validatedAt ||
      trustedTimeAnchor === null ||
      (status.subscription?.expiresAt !== null &&
        status.subscription?.expiresAt !== undefined &&
        expiresAt === null) ||
      (status.subscription?.graceEndsAt !== null &&
        status.subscription?.graceEndsAt !== undefined &&
        graceEndsAt === null) ||
      (expiresAt !== null && graceEndsAt !== null && graceEndsAt < expiresAt)
    ) {
      return null
    }

    return { status, trustedTimeAnchor, expiresAt, graceEndsAt, nextValidationDueAt }
  }

  private connectivityReason(action: CommercialAccessAction): CommercialAccessReason | null {
    const snapshot = this.options.connectivity.getSnapshot()

    // Startup's initial probe must not block first-time bootstrap. For a real online-required
    // operation the request itself still reports an honest transport failure if it cannot connect.
    if (snapshot.status === 'checking') {
      return null
    }

    const policy =
      action === 'sell'
        ? CONNECTIVITY_PRECONDITION.localCheckout
        : CONNECTIVITY_PRECONDITION.invoiceSync

    return meetsConnectivityPrecondition(policy, snapshot) ? null : 'connectivity-unavailable'
  }

  private denied(
    action: CommercialAccessAction,
    reason: CommercialAccessReason,
    evaluatedAt: string,
    status: LicenseStatus | null = null
  ): CommercialAccessDecision {
    return commercialAccessDecisionSchema.parse({
      allowed: false,
      reason,
      warning: null,
      action,
      retryable: COMMERCIAL_ACCESS_REASON_CLASSIFICATION[reason].retryable,
      evaluatedAt,
      nextValidationDueAt: status?.nextValidationDueAt ?? null,
      restrictionLevel: status?.restrictionLevel ?? null,
      warningMessage: status?.warningMessage ?? null
    })
  }

  private allowed(
    action: CommercialAccessAction,
    evaluatedAt: string,
    licenseState: ValidatedLicenseState,
    now: number
  ): CommercialAccessDecision {
    const warning =
      licenseState.expiresAt !== null && now >= licenseState.expiresAt
        ? 'grace'
        : licenseState.nextValidationDueAt - now <= VALIDATION_DUE_SOON_WINDOW_MS
          ? 'validation-due-soon'
          : null

    return commercialAccessDecisionSchema.parse({
      allowed: true,
      reason: null,
      warning,
      action,
      retryable: false,
      evaluatedAt,
      nextValidationDueAt: licenseState.status.nextValidationDueAt,
      restrictionLevel: licenseState.status.restrictionLevel,
      warningMessage: licenseState.status.warningMessage
    })
  }
}
