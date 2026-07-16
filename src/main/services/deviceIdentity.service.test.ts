import { describe, expect, it } from 'vitest'
import { DeviceIdentityService, type StoredDeviceIdentity } from './deviceIdentity.service'

describe('DeviceIdentityService', () => {
  it('persists one installation UUID and reuses it across reads', () => {
    let storedIdentity: StoredDeviceIdentity | null = null
    const service = new DeviceIdentityService(
      {
        get: () => storedIdentity,
        create: (identity) => {
          storedIdentity = identity
        }
      },
      {
        deviceName: 'Register One',
        platform: 'linux',
        osVersion: '6.0',
        appVersion: '1.0.0'
      },
      () => '00000000-0000-4000-8000-000000000001'
    )

    expect(service.getOrCreate().deviceUuid).toBe('00000000-0000-4000-8000-000000000001')
    expect(service.getOrCreate().deviceUuid).toBe('00000000-0000-4000-8000-000000000001')
  })
})
