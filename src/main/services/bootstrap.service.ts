import { publicAppErrorSchema, type PublicAppError } from '@shared/contracts/api.contract'
import { bootstrapResultSchema, type BootstrapResult } from '@shared/contracts/bootstrap.contract'
import type { LicenseStatus } from '@shared/contracts/license.contract'
import { DESKTOP_API_ROUTES } from '@shared/constants/apiRoutes'
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

export interface BootstrapLicenseMetadataReader {
  getStatus(): LicenseStatus | null
}

export interface BootstrapStateWriter {
  markComplete(meta: {
    snapshotVersion: string
    serverTime: string
    counts: Record<string, number>
  }): void
}

export interface BootstrapSnapshotWriter {
  persistSnapshot(resource: DesktopBootstrapResource, fetchedAt: string): BootstrapPersistResult
}

function authorizationError(message: string, warningMessage?: string | null): PublicAppError {
  return publicAppErrorSchema.parse({
    category: 'authorization',
    message: warningMessage ?? message,
    retryable: false
  })
}

export class BootstrapService {
  constructor(
    private readonly apiClient: DesktopApiClient,
    private readonly deviceIdentityRepository: BootstrapDeviceIdentityRepository,
    private readonly licenseMetadataRepository: BootstrapLicenseMetadataReader,
    private readonly bootstrapStateRepository: BootstrapStateWriter,
    private readonly bootstrapSnapshotRepository: BootstrapSnapshotWriter
  ) {}

  async refresh(): Promise<BootstrapResult> {
    const identity = this.deviceIdentityRepository.get()

    if (!identity || !identity.isRegistered) {
      throw authorizationError('This workstation has not completed device activation')
    }

    const license = this.licenseMetadataRepository.getStatus()

    if (!license || !license.canSync) {
      throw authorizationError(
        'This workstation is not permitted to synchronize with the backend',
        license?.warningMessage
      )
    }

    const response = await this.apiClient.request(DESKTOP_API_ROUTES.bootstrap)
    const resource = desktopBootstrapResourceSchema.parse(response)
    const fetchedAt = new Date().toISOString()

    const persisted = this.bootstrapSnapshotRepository.persistSnapshot(resource, fetchedAt)

    this.bootstrapStateRepository.markComplete({
      snapshotVersion: persisted.snapshotVersion,
      serverTime: persisted.serverTime,
      counts: persisted.counts
    })

    return bootstrapResultSchema.parse({
      isComplete: true,
      snapshotVersion: persisted.snapshotVersion,
      serverTime: persisted.serverTime,
      fetchedAt,
      counts: persisted.counts
    })
  }
}
