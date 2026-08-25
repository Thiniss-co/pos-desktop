import { describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import type { ApplicationServices } from '../app/applicationServices'
import type { DesktopApiClient } from '../http/desktopApiClient'
import type { CommercialAccessService } from '../services/commercialAccess.service'
import { ShiftService } from '../services/shift.service'
import { ShiftPermissions } from '../services/shiftPermissions'

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

import { registerShiftIpcHandlers } from './shifts.ipc'

describe('shift IPC authorization', () => {
  it('enforces main-process permissions for a direct IPC invocation', async () => {
    const request = vi.fn()
    const commercialAccess = { assertAllowed: vi.fn() } as unknown as CommercialAccessService
    const shifts = new ShiftService(
      { request } as unknown as DesktopApiClient,
      commercialAccess,
      new ShiftPermissions({ hasPermission: () => false })
    )

    registerShiftIpcHandlers({ shifts } as ApplicationServices)
    const handler = handlers.get(IPC_CHANNELS.shiftsOpen)

    expect(handler).toBeDefined()
    await expect(handler?.({}, { openingCashAmount: 1000, allowed: true })).resolves.toMatchObject({
      ok: false,
      error: { category: 'validation' }
    })
    await expect(handler?.({}, { openingCashAmount: 1000 })).resolves.toMatchObject({
      ok: false,
      error: {
        category: 'authorization',
        backendCode: 'PERMISSION_DENIED',
        retryable: false
      }
    })

    expect(request).not.toHaveBeenCalled()
    expect(commercialAccess.assertAllowed).not.toHaveBeenCalled()
  })
})
