import { ZodError } from 'zod'
import {
  licenseOfflineCoverageSchema,
  licenseStatusSchema,
  type LicenseOfflineCoverage,
  type LicenseStatus
} from '@shared/contracts/license.contract'
import { publicAppErrorSchema, type PublicAppError } from '@shared/contracts/api.contract'
import { DESKTOP_API_ROUTES } from '@shared/constants/apiRoutes'
import type { DesktopApiClient } from '../http/desktopApiClient'
import { licenseResourceSchema } from '../http/desktopResources.contract'
import type {
  OfflineSaleAuthorityRepository,
  PublishedOfflineSaleAuthority
} from '../repositories/offlineSaleAuthority.repository'
import {
  accessSequenceFromMeta,
  admitAccessAnswer,
  type AccessSequenceStore
} from './accessOrdering'
import { OwnerChangedError, sameRenewalOwner, type RenewalOwner } from './renewalOwner'

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

/** Rev 4 §10.1: one server-time sample, bracketed by monotonic readings taken around the request. */
export interface ServerTimeSample {
  readonly serverTime: string
  readonly sentAtMono: number
  readonly receivedAtMono: number
}

export interface LicenseServiceOptions {
  /** The SQLite handle that owns the token, license metadata and authority tables. */
  readonly database?: { transaction<T>(fn: () => T): () => T }
  /** Rev 4 §7.1: reads the current owner; captured before the request, re-checked before writes. */
  readonly owner?: () => RenewalOwner | null
  readonly offlineSaleAuthorities?: Pick<OfflineSaleAuthorityRepository, 'observe'>
  readonly monotonicNow?: () => number
  readonly onServerTimeSample?: (sample: ServerTimeSample) => void
  /**
   * Phase 6 (C3): orders this answer against every other access answer by the server's `meta.access_sequence`
   * (see accessOrdering.ts). `currentStatus` is the stored status, used only to tell whether an UNSEQUENCED answer
   * from an older backend would relax access.
   */
  readonly accessOrdering?: {
    readonly store: AccessSequenceStore
    readonly currentStatus: () => LicenseStatus | null
  }
}

/** A 422 that names `offline_sale_contract_version`: an older backend that supports only v1. */
export function isUnsupportedOfflineSaleVersion(error: unknown): boolean {
  const candidate = error as { httpStatus?: number; fieldErrors?: Record<string, unknown> } | null
  return Boolean(
    candidate &&
    typeof candidate === 'object' &&
    candidate.fieldErrors &&
    Object.hasOwn(candidate.fieldErrors, 'offline_sale_contract_version')
  )
}

function ownerUnchanged(captured: RenewalOwner | null, current: RenewalOwner | null): boolean {
  return captured === null && current === null ? true : sameRenewalOwner(captured, current)
}

/**
 * Phase 4 closeout (O-7): the server's covered renewal, or null. A malformed block is dropped rather than failing the
 * whole validation: without it the till keeps the current period's end (the fail-closed reading).
 */
function offlineCoverage(value: unknown): LicenseOfflineCoverage | null {
  if (value === null || value === undefined || typeof value !== 'object') {
    return null
  }
  const block = value as Record<string, unknown>
  const parsed = licenseOfflineCoverageSchema.safeParse({
    renewalId: block.renewal_id,
    startsAt: block.starts_at,
    expiresAt: block.expires_at,
    graceEndsAt: block.grace_ends_at ?? null
  })
  return parsed.success ? parsed.data : null
}

function timestampValue(value: string): number {
  const timestamp = Date.parse(value)

  if (Number.isNaN(timestamp)) {
    throw new Error('Expected an ISO-8601 timestamp')
  }

  return timestamp
}

export class LicenseService {
  /**
   * Rev 4 §6.3: negotiate the v2 authority representation. A backend that supports only v1 answers
   * 422 on the field before any write; this client then retries once with v1 and remembers it for
   * the rest of the process. A v1 authority carries no warehouse and is never selected for a sale.
   */
  private offlineSaleContractVersion: 1 | 2 = 2

  constructor(
    private readonly apiClient: DesktopApiClient,
    private readonly licenseMetadataRepository: LicenseMetadataWriter,
    private readonly secureStorage: LicenseSecureStorage,
    private readonly now: () => Date = () => new Date(),
    private readonly options: LicenseServiceOptions = {}
  ) {}

  private async requestValidation(): Promise<{
    response: unknown
    meta: Record<string, unknown>
    sentAtMono: number
    receivedAtMono: number
  }> {
    const monotonic = this.options.monotonicNow ?? (() => performance.now())

    for (;;) {
      const sentAtMono = monotonic()
      try {
        const answer = await this.apiClient.requestWithMeta(DESKTOP_API_ROUTES.licenseValidate, {
          offline_sale_contract_version: this.offlineSaleContractVersion,
          // Phase 4 closeout (O-7): this app understands `subscription.offline_coverage`. Without it the server extends
          // nothing (an older app's own access decision would otherwise sell through the current period's grace).
          offline_coverage_version: 1
        })
        return {
          response: answer.data,
          meta: answer.meta ?? {},
          sentAtMono,
          receivedAtMono: monotonic()
        }
      } catch (error) {
        if (this.offlineSaleContractVersion === 2 && isUnsupportedOfflineSaleVersion(error)) {
          this.offlineSaleContractVersion = 1
          continue
        }
        throw error
      }
    }
  }

  async validate(): Promise<LicenseStatus> {
    const capturedOwner = this.options.owner?.() ?? null
    const { response, meta, sentAtMono, receivedAtMono } = await this.requestValidation()
    const accessSequence = accessSequenceFromMeta(meta)
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
              graceEndsAt: resource.subscription.grace_ends_at,
              offlineCoverage: offlineCoverage(resource.subscription.offline_coverage)
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

    const published = (resource.offline_sale_authority ??
      null) as PublishedOfflineSaleAuthority | null
    const observedAtIso = currentTime.toISOString()

    // Rev 4 §7.1: every write of this leg in ONE synchronous transaction whose first statement
    // re-checks the owner. Logout, a different sign-in, a binding refresh or a reassignment that
    // happened while the request was in flight discards the result; nothing is written.
    const write = (): void => {
      if (this.options.owner && !ownerUnchanged(capturedOwner, this.options.owner())) {
        throw new OwnerChangedError()
      }

      // Phase 6 (C3): an older answer arriving after a newer one is discarded here, before anything is written.
      const ordering = this.options.accessOrdering
      if (ordering) {
        const stored = ordering.currentStatus()
        const relaxes =
          stored === null ||
          (status.canSell && !stored.canSell) ||
          (status.canSync && !stored.canSync)
        admitAccessAnswer(ordering.store, capturedOwner, accessSequence, relaxes)
      }

      this.secureStorage.setSecret(DESKTOP_LICENSE_JWT_KEY, resource.token)
      this.licenseMetadataRepository.setValidatedStatus(status, trustedTimeAnchor)

      if (published !== null && capturedOwner !== null && this.options.offlineSaleAuthorities) {
        this.options.offlineSaleAuthorities.observe(
          published,
          capturedOwner.companyUuid,
          capturedOwner.deviceUuid,
          observedAtIso
        )
      }
    }

    if (this.options.database) {
      this.options.database.transaction(write)()
    } else {
      write()
    }

    this.options.onServerTimeSample?.({
      serverTime: status.serverTime,
      sentAtMono,
      receivedAtMono
    })

    return status
  }
}
