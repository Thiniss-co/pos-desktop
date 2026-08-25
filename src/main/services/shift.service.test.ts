import { describe, expect, it, vi } from 'vitest'
import { publicAppErrorSchema } from '@shared/contracts/api.contract'
import type { DesktopApiClient } from '../http/desktopApiClient'
import { desktopShiftFixture } from '../testing/fixtures/desktopShift.fixture'
import type { CommercialAccessService } from './commercialAccess.service'
import type { ShiftPermissions } from './shiftPermissions'
import { ShiftService } from './shift.service'

const resource = desktopShiftFixture()

type Setup = {
  service: ShiftService
  events: string[]
  assertAllowed: ReturnType<typeof vi.fn>
  assertShiftPermission: ReturnType<typeof vi.fn>
  request: ReturnType<typeof vi.fn>
}

function setup(): Setup {
  const events: string[] = []
  const assertAllowed = vi.fn((action: string) => events.push(`commercial:${action}`))
  const assertShiftPermission = vi.fn((permission: string) =>
    events.push(`permission:${permission}`)
  )
  const request = vi.fn(async () => {
    events.push('request')
    return resource
  })
  const service = new ShiftService(
    { request } as unknown as DesktopApiClient,
    { assertAllowed } as unknown as CommercialAccessService,
    { assertShiftPermission } as unknown as ShiftPermissions
  )

  return { service, events, assertAllowed, assertShiftPermission, request }
}

describe('ShiftService', () => {
  it.each([
    ['current', (service: ShiftService) => service.current(), 'shifts.view', []],
    ['get', (service: ShiftService) => service.get(resource.uuid), 'shifts.view', []],
    [
      'open',
      (service: ShiftService) => service.open({ openingCashAmount: 1000 }),
      'shifts.manage',
      ['commercial:sell']
    ],
    [
      'pause',
      (service: ShiftService) => service.pause({ uuid: resource.uuid }),
      'shifts.manage',
      []
    ],
    [
      'resume',
      (service: ShiftService) => service.resume({ uuid: resource.uuid }),
      'shifts.manage',
      ['commercial:sell']
    ],
    [
      'close',
      (service: ShiftService) => service.close({ uuid: resource.uuid, actualCashAmount: 1000 }),
      'shifts.manage',
      []
    ]
  ] as const)(
    '%s requires its exact local permission before the request',
    async (_name, call, permission, guards) => {
      const test = setup()

      await call(test.service)

      expect(test.assertShiftPermission).toHaveBeenCalledWith(permission)
      expect(test.events).toEqual([`permission:${permission}`, ...guards, 'request'])
    }
  )

  it('does not request when a shift permission is denied locally', async () => {
    const permissionDenied = publicAppErrorSchema.parse({
      category: 'authorization',
      message: 'Your account does not have the shifts.manage permission.',
      backendCode: 'PERMISSION_DENIED',
      retryable: false
    })
    const test = setup()
    test.assertShiftPermission.mockImplementation(() => {
      throw permissionDenied
    })

    await expect(test.service.open({ openingCashAmount: 1000 })).rejects.toEqual(permissionDenied)

    expect(test.assertAllowed).not.toHaveBeenCalled()
    expect(test.request).not.toHaveBeenCalled()
  })

  it('does not request when the sell guard rejects open or resume after permission succeeds', async () => {
    const sellDenied = publicAppErrorSchema.parse({
      category: 'authorization',
      message: 'Selling is blocked.',
      backendCode: 'COMMERCIAL_ACCESS_DEVICE_BLOCKED',
      retryable: false
    })

    for (const call of [
      (service: ShiftService) => service.open({ openingCashAmount: 1000 }),
      (service: ShiftService) => service.resume({ uuid: resource.uuid })
    ]) {
      const test = setup()
      test.assertAllowed.mockImplementation((action: string) => {
        test.events.push(`commercial:${action}`)
        throw sellDenied
      })

      await expect(call(test.service)).rejects.toEqual(sellDenied)
      expect(test.events).toEqual(['permission:shifts.manage', 'commercial:sell'])
      expect(test.request).not.toHaveBeenCalled()
    }
  })

  it('allows manage-only pause and close without pos.sell', async () => {
    const test = setup()
    test.assertAllowed.mockImplementation(() => {
      throw new Error('pos.sell must not be checked for pause or close')
    })

    await test.service.pause({ uuid: resource.uuid })
    await test.service.close({ uuid: resource.uuid, actualCashAmount: 1000 })

    expect(test.assertAllowed).not.toHaveBeenCalled()
    expect(test.request).toHaveBeenCalledTimes(2)
  })

  it('prevents a sell-capable caller without shifts.manage from mutating a shift', async () => {
    const test = setup()
    test.assertShiftPermission.mockImplementation(() => {
      throw publicAppErrorSchema.parse({
        category: 'authorization',
        message: 'Your account does not have the shifts.manage permission.',
        backendCode: 'PERMISSION_DENIED',
        retryable: false
      })
    })

    await expect(test.service.resume({ uuid: resource.uuid })).rejects.toMatchObject({
      backendCode: 'PERMISSION_DENIED'
    })

    expect(test.assertAllowed).not.toHaveBeenCalled()
    expect(test.request).not.toHaveBeenCalled()
  })

  it('keeps a backend PERMISSION_DENIED error typed when local permissions are stale', async () => {
    const backendDenied = publicAppErrorSchema.parse({
      category: 'authorization',
      message: 'Permission denied by the desktop service.',
      backendCode: 'PERMISSION_DENIED',
      retryable: false
    })
    const test = setup()
    test.request.mockRejectedValue(backendDenied)

    await expect(test.service.pause({ uuid: resource.uuid })).rejects.toEqual(backendDenied)
  })

  it('maps a cancelled show response with negative expected cash', async () => {
    const test = setup()
    test.request.mockResolvedValue(
      desktopShiftFixture({ status: 'cancelled', expected_cash_amount: -250 })
    )

    await expect(test.service.get(resource.uuid)).resolves.toMatchObject({
      status: 'cancelled',
      expectedCashAmount: -250
    })
  })

  it('parses a successful close response with negative expected cash', async () => {
    const test = setup()
    test.request.mockResolvedValue(
      desktopShiftFixture({ status: 'closed', expected_cash_amount: -250, actual_cash_amount: 0 })
    )

    await expect(
      test.service.close({ uuid: resource.uuid, actualCashAmount: 0 })
    ).resolves.toMatchObject({ status: 'closed', expectedCashAmount: -250, actualCashAmount: 0 })
  })

  it('rejects a terminal shift from the current-shift endpoint', async () => {
    const test = setup()
    test.request.mockResolvedValue(desktopShiftFixture({ status: 'cancelled' }))

    await expect(test.service.current()).rejects.toThrow()
  })
})
