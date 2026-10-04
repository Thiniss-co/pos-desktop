import { ZodError } from 'zod'
import { publicAppErrorSchema, type PublicAppError } from '@shared/contracts/api.contract'
import { bootstrapResultSchema, type BootstrapResult } from '@shared/contracts/bootstrap.contract'
import { DESKTOP_API_ROUTES } from '@shared/constants/apiRoutes'
import { redactSensitiveText } from '../http/apiError'
import { isApiTraceEnabled } from '../http/apiTrace'
import type { DesktopApiClient } from '../http/desktopApiClient'
import {
  desktopBootstrapResourceSchema,
  type DesktopBootstrapResource
} from '../http/desktopResources.contract'
import type { BootstrapPersistResult } from '../repositories/bootstrapSnapshot.repository'
import type { StoredDeviceIdentity } from './deviceIdentity.service'
import type { SessionContext } from '../repositories/sessionMetadata.repository'
import { isUnsupportedOfflineSaleVersion } from './license.service'
import { OwnerChangedError, sameRenewalOwner, type RenewalOwner } from './renewalOwner'

/** Just past the server's one-second `generated_at` resolution. */
const SAME_SECOND_RETRY_MS = 1_100

export interface BootstrapDeviceIdentityRepository {
  get(): StoredDeviceIdentity | null
}

export interface BootstrapCommercialAccessChecker {
  assertCanSync(): void
}

export interface BootstrapPersistOptions {
  /** Runs as the FIRST statement inside the persist transaction; a throw discards the snapshot. */
  readonly beforeWrite?: () => void
}

export interface BootstrapSnapshotWriter {
  persistSnapshot(
    resource: DesktopBootstrapResource,
    fetchedAt: string,
    options?: BootstrapPersistOptions
  ): BootstrapPersistResult
}

export interface BootstrapServiceOptions {
  /** Rev 4 §7.1: the renewal owner, captured before the request and re-checked inside the write. */
  readonly owner?: () => RenewalOwner | null
  /**
   * Rev 4 §8: the catalog-install lifecycle. `acquire()` runs after the fetch and before any write
   * (the renderer hold handshake); `beforeWrite()` is the synchronous final check inside the
   * persist transaction; `settle()` records the outcome and releases the hold.
   */
  readonly installGate?: {
    acquire(): Promise<void>
    beforeWrite(): void
    settle(installed: boolean, reason?: string): void
  }
}

let bootstrapOfflineSaleVersion: 1 | 2 = 2

/**
 * Rev 4 §6.3: request bootstrap negotiating the v2 authority representation, falling back once to
 * v1 against a backend that rejects the field (422, before any work). Shared by every caller that
 * reads bootstrap so the negotiation cannot diverge.
 */
export async function requestBootstrap(apiClient: DesktopApiClient): Promise<unknown> {
  for (;;) {
    try {
      return await apiClient.request(
        bootstrapOfflineSaleVersion === 2
          ? DESKTOP_API_ROUTES.bootstrap
          : DESKTOP_API_ROUTES.bootstrapOfflineSaleV1
      )
    } catch (error) {
      if (bootstrapOfflineSaleVersion === 2 && isUnsupportedOfflineSaleVersion(error)) {
        bootstrapOfflineSaleVersion = 1
        continue
      }
      throw error
    }
  }
}

/**
 * Receipt-printing plan §D-11 — optional so every existing bootstrap test/fake keeps working
 * unchanged. `ingestFromBootstrap` is synchronous and its own transaction; `fetchPendingAssets` is
 * fire-and-forget and MUST NOT be awaited here, so a slow or offline asset download can never delay
 * (or fail) an otherwise-successful bootstrap.
 */
export interface BootstrapReceiptProfileSync {
  ingestFromBootstrap(
    companyUuid: string,
    userUuid: string | null,
    block: DesktopBootstrapResource['receipt_profile']
  ): void
  fetchPendingAssets(companyUuid: string): Promise<void>
}

function authorizationError(message: string): PublicAppError {
  return publicAppErrorSchema.parse({
    category: 'authorization',
    message,
    retryable: false
  })
}

function contractInvalidError(): PublicAppError {
  return publicAppErrorSchema.parse({
    category: 'unexpected',
    message:
      'The service returned unsupported bootstrap data. Please update the desktop application or contact support.',
    backendCode: 'bootstrap_payload_contract_invalid',
    retryable: false
  })
}

const traceableBootstrapContractPaths = new Set(['loyalty.points_expire_after_days'])

function traceBootstrapContractError(error: ZodError): void {
  if (!isApiTraceEnabled()) {
    return
  }

  const issue = error.issues[0]
  const issuePath = issue?.path.join('.')
  const fieldPath =
    issuePath && traceableBootstrapContractPaths.has(issuePath) ? issuePath : '<redacted-path>'
  // A backend that adds a field the desktop build does not know about fails the strict parse with
  // no usable path, which is indistinguishable from a real contract break in the trace. The key
  // names are backend schema shape, never payload values, so they are safe to name here.
  const unknownKeys =
    issue?.code === 'unrecognized_keys' && issue.keys.length > 0
      ? ` unknown_keys=${[...issue.keys].sort().join(',')}`
      : ''

  console.error(
    redactSensitiveText(
      `[pos-api] category=bootstrap_payload_contract_invalid field_path=${fieldPath}${unknownKeys}`
    )
  )
}

export class BootstrapService {
  constructor(
    private readonly apiClient: DesktopApiClient,
    private readonly deviceIdentityRepository: BootstrapDeviceIdentityRepository,
    private readonly commercialAccess: BootstrapCommercialAccessChecker,
    private readonly bootstrapSnapshotRepository: BootstrapSnapshotWriter,
    private readonly onSnapshotPersisted?: (result: BootstrapPersistResult) => void,
    private readonly now: () => Date = () => new Date(),
    private readonly sessionMetadata?: { getContext(): SessionContext },
    private readonly receiptProfileSync?: BootstrapReceiptProfileSync,
    private readonly options: BootstrapServiceOptions = {}
  ) {}

  refresh(): Promise<BootstrapResult> {
    if (this.refreshInFlight) {
      return this.refreshInFlight
    }

    const refresh = this.refreshOnce().catch(async (error: unknown) => {
      // The server stamps `generated_at` to the second. Two snapshots with different content in the
      // SAME second (e.g. a refresh straight after a device assignment, while a session install of
      // the previous content landed in that second) are refused as a conflict; nothing was written.
      // Once the server's second has moved on, a fresh fetch carries a later `generated_at`.
      if (
        (error as { backendCode?: unknown } | null)?.backendCode !== 'CATALOG_REVISION_CONFLICT'
      ) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, SAME_SECOND_RETRY_MS))
      return this.refreshOnce()
    })
    this.refreshInFlight = refresh
    void refresh.then(
      () => this.clearRefresh(refresh),
      () => this.clearRefresh(refresh)
    )
    return refresh
  }

  private refreshInFlight: Promise<BootstrapResult> | null = null

  private clearRefresh(refresh: Promise<BootstrapResult>): void {
    if (this.refreshInFlight === refresh) {
      this.refreshInFlight = null
    }
  }

  private persistGuarded(
    resource: DesktopBootstrapResource,
    fetchedAt: string,
    capturedOwner: RenewalOwner | null
  ): BootstrapPersistResult {
    return this.bootstrapSnapshotRepository.persistSnapshot(resource, fetchedAt, {
      beforeWrite: () => {
        if (this.options.owner) {
          const current = this.options.owner()
          const unchanged =
            capturedOwner === null && current === null
              ? true
              : sameRenewalOwner(capturedOwner, current)
          if (!unchanged) {
            throw new OwnerChangedError()
          }
          if (
            current !== null &&
            (resource.company.id !== current.companyUuid ||
              resource.device.device_uuid !== current.deviceUuid)
          ) {
            throw new OwnerChangedError()
          }
        }
        this.options.installGate?.beforeWrite()
      }
    })
  }

  private async refreshOnce(): Promise<BootstrapResult> {
    const identity = this.deviceIdentityRepository.get()

    if (!identity || !identity.isRegistered) {
      throw authorizationError('This workstation has not completed device activation')
    }

    this.commercialAccess.assertCanSync()

    const capturedOwner = this.options.owner?.() ?? null
    const response = await requestBootstrap(this.apiClient)
    let resource: DesktopBootstrapResource

    try {
      resource = desktopBootstrapResourceSchema.parse(response)
    } catch (error) {
      if (error instanceof ZodError) {
        traceBootstrapContractError(error)
        throw contractInvalidError()
      }

      throw error
    }

    const fetchedAt = this.now().toISOString()

    // Rev 4 §8: hold the renderer (adds, scans, recalls, claims wait) before anything is written.
    // A deferral throws here with nothing persisted; the downloaded payload is discarded.
    const gate = this.options.installGate
    if (gate) {
      await gate.acquire()
    }

    // Rev 4 §7.1/§7.2: the first statements of the persist transaction re-check that the owner is
    // unchanged since the request was sent, and that the response describes THIS session's company
    // and device; then the install gate's final synchronous check. Anything else discards the
    // snapshot; nothing is written.
    let persisted: BootstrapPersistResult
    try {
      persisted = this.persistGuarded(resource, fetchedAt, capturedOwner)
      gate?.settle(true)
    } catch (error) {
      // The code only (never a message or payload): it names why the install was discarded.
      const code = (error as { code?: unknown; backendCode?: unknown } | null) ?? null
      gate?.settle(false, String(code?.code ?? code?.backendCode ?? 'error').slice(0, 64))
      throw error
    }
    this.onSnapshotPersisted?.(persisted)

    if (this.receiptProfileSync) {
      try {
        const userUuid = this.sessionMetadata?.getContext().userUuid ?? null
        this.receiptProfileSync.ingestFromBootstrap(
          resource.company.id,
          userUuid,
          resource.receipt_profile
        )
        // Fire-and-forget: never awaited, and never allowed to delay or fail bootstrap itself.
        void this.receiptProfileSync.fetchPendingAssets(resource.company.id).catch(() => undefined)
      } catch {
        // A receipt-profile sync failure must never fail an otherwise-successful bootstrap.
      }
    }

    return bootstrapResultSchema.parse({
      isComplete: true,
      snapshotVersion: persisted.snapshotVersion,
      serverTime: persisted.serverTime,
      fetchedAt,
      counts: persisted.counts,
      catalog: {
        revision: resource.catalog_contract.revision,
        generatedAt: resource.catalog_contract.generated_at,
        validUntil: resource.catalog_contract.valid_until
      }
    })
  }
}
