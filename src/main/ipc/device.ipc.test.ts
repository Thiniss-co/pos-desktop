import { describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import type { ApplicationServices } from '../app/applicationServices'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input: unknown) => Promise<unknown>>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(
      (channel: string, handler: (event: unknown, input: unknown) => Promise<unknown>) => {
        handlers.set(channel, handler)
      }
    )
  }
}))

import { registerDeviceIpcHandlers } from './device.ipc'

describe('device identity IPC', () => {
  it('projects the authoritative persisted registration status without changing device identity', async () => {
    const deviceIdentity = {
      getOrCreate: vi.fn(() => ({
        deviceUuid: '00000000-0000-4000-8000-000000000001',
        deviceName: 'Front Register',
        platform: 'linux',
        osVersion: '6.0',
        appVersion: '1.0.0',
        isRegistered: true
      }))
    }
    const deviceRegistration = { get: vi.fn(() => ({ status: 'revoked' })) }

    registerDeviceIpcHandlers({
      deviceIdentity,
      deviceRegistration
    } as unknown as ApplicationServices)
    const handler = handlers.get(IPC_CHANNELS.deviceGetIdentitySummary)

    await expect(handler?.({}, undefined)).resolves.toEqual({
      ok: true,
      data: {
        deviceUuid: '00000000-0000-4000-8000-000000000001',
        deviceName: 'Front Register',
        platform: 'linux',
        osVersion: '6.0',
        appVersion: '1.0.0',
        isRegistered: true,
        registrationStatus: 'revoked'
      }
    })
    expect(deviceIdentity.getOrCreate).toHaveBeenCalledOnce()
    expect(deviceRegistration.get).toHaveBeenCalledOnce()
  })
})
