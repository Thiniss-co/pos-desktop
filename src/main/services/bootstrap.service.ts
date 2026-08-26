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

export interface BootstrapDeviceIdentityRepository {
  get(): StoredDeviceIdentity | null
}

export interface BootstrapCommercialAccessChecker {
  assertCanSync(): void
}

export interface BootstrapSnapshotWriter {
  persistSnapshot(resource: DesktopBootstrapResource, fetchedAt: string): BootstrapPersistResult
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

  const issuePath = error.issues[0]?.path.join('.')
  const fieldPath =
    issuePath && traceableBootstrapContractPaths.has(issuePath) ? issuePath : '<redacted-path>'

  console.error(
    redactSensitiveText(
      `[pos-api] category=bootstrap_payload_contract_invalid field_path=${fieldPath}`
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
    private readonly now: () => Date = () => new Date()
  ) {}

  refresh(): Promise<BootstrapResult> {
    if (this.refreshInFlight) {
      return this.refreshInFlight
    }

    const refresh = this.refreshOnce()
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

  private async refreshOnce(): Promise<BootstrapResult> {
    const identity = this.deviceIdentityRepository.get()

    if (!identity || !identity.isRegistered) {
      throw authorizationError('This workstation has not completed device activation')
    }

    this.commercialAccess.assertCanSync()

    const response = await this.apiClient.request(DESKTOP_API_ROUTES.bootstrap)
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

    const persisted = this.bootstrapSnapshotRepository.persistSnapshot(resource, fetchedAt)
    this.onSnapshotPersisted?.(persisted)

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
