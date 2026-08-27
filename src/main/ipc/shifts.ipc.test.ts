import { describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import type { ApplicationServices } from '../app/applicationServices'
import type { DesktopApiClient } from '../http/desktopApiClient'
import type { CommercialAccessService } from '../services/commercialAccess.service'
import { ShiftService } from '../services/shift.service'
import type { ShiftObservationAuthority } from '../services/shiftAuthority.service'
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
    const authority: ShiftObservationAuthority = {
      captureContext: () => ({
        companyUuid: '11111111-1111-4111-8111-111111111111',
        deviceUuid: '22222222-2222-4222-8222-222222222222',
        userUuid: '33333333-3333-4333-8333-333333333333',
        sessionEpoch: 1
      }),
      recordCurrent: () => undefined,
      markReconciliationRequired: () => undefined,
      recordMutation: () => undefined
    }
    const shifts = new ShiftService(
      { request } as unknown as DesktopApiClient,
      commercialAccess,
      new ShiftPermissions({ hasPermission: () => false }),
      authority
    )

    registerShiftIpcHandlers({ shifts } as ApplicationServices)
    const handler = handlers.get(IPC_CHANNELS.shiftsOpen)

    expect(handler).toBeDefined()
    await expect(
      handler?.(
        {},
        {
          openingCashAmount: 1000,
          shiftUuid: '11111111-1111-4111-8111-111111111111',
          status: 'open',
          sessionEpoch: 999
        }
      )
    ).resolves.toMatchObject({
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
