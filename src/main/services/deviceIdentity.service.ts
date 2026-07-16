import { randomUUID } from 'crypto'
import type { DeviceIdentitySummary } from '@shared/contracts/device.contract'

export interface StoredDeviceIdentity extends DeviceIdentitySummary {}

export interface DeviceIdentityRepository {
  get(): StoredDeviceIdentity | null
  create(identity: StoredDeviceIdentity): void
}

export interface DeviceIdentityMetadata {
  readonly deviceName: string
  readonly platform: string
  readonly osVersion: string
  readonly appVersion: string
}

export class DeviceIdentityService {
  constructor(
    private readonly repository: DeviceIdentityRepository,
    private readonly metadata: DeviceIdentityMetadata,
    private readonly createUuid: () => string = randomUUID
  ) {}

  getOrCreate(): StoredDeviceIdentity {
    const existingIdentity = this.repository.get()

    if (existingIdentity) {
      return existingIdentity
    }

    const identity: StoredDeviceIdentity = {
      deviceUuid: this.createUuid(),
      ...this.metadata,
      isRegistered: false
    }

    this.repository.create(identity)
    return identity
  }
}
