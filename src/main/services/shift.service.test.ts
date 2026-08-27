import { describe, expect, it, vi } from 'vitest'
import { publicAppErrorSchema } from '@shared/contracts/api.contract'
import type { DesktopApiClient } from '../http/desktopApiClient'
import { desktopShiftFixture } from '../testing/fixtures/desktopShift.fixture'
import type { CommercialAccessService } from './commercialAccess.service'
import type { ShiftObservationAuthority } from './shiftAuthority.service'
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
  const service = new ShiftService(
    { request } as unknown as DesktopApiClient,
    { assertAllowed } as unknown as CommercialAccessService,
    { assertShiftPermission } as unknown as ShiftPermissions,
    authority
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

  it('persists reconciliation_required before dispatching a shift mutation', async () => {
    const events: string[] = []
    const authority: ShiftObservationAuthority = {
      captureContext: () => ({
        companyUuid: '11111111-1111-4111-8111-111111111111',
        deviceUuid: '22222222-2222-4222-8222-222222222222',
        userUuid: '33333333-3333-4333-8333-333333333333',
        sessionEpoch: 1
      }),
      markReconciliationRequired: (_context, source) => events.push(`mark:${source}`),
      recordMutation: (_context, source) => events.push(`record:${source}`),
      recordCurrent: () => events.push('record:current')
    }
    const service = new ShiftService(
      {
        request: async () => {
          events.push('request')
          return resource
        }
      } as unknown as DesktopApiClient,
      { assertAllowed: () => undefined } as unknown as CommercialAccessService,
      { assertShiftPermission: () => undefined } as unknown as ShiftPermissions,
      authority
    )

    await service.close({ uuid: resource.uuid, actualCashAmount: 1000 })

    expect(events).toEqual(['mark:close', 'request', 'record:close'])
  })

  it('does not pre-write recovery state for a local dispatch precondition failure', async () => {
    const markReconciliationRequired = vi.fn()
    const request = vi.fn()
    const authority: ShiftObservationAuthority = {
      captureContext: () => ({
        companyUuid: '11111111-1111-4111-8111-111111111111',
        deviceUuid: '22222222-2222-4222-8222-222222222222',
        userUuid: '33333333-3333-4333-8333-333333333333',
        sessionEpoch: 1
      }),
      markReconciliationRequired,
      recordMutation: () => undefined,
      recordCurrent: () => undefined
    }
    const service = new ShiftService(
      {
        assertRequestPreconditions: () => {
          throw publicAppErrorSchema.parse({
            category: 'configuration',
            message: 'Backend is not configured',
            retryable: false
          })
        },
        request
      } as unknown as DesktopApiClient,
      { assertAllowed: () => undefined } as unknown as CommercialAccessService,
      { assertShiftPermission: () => undefined } as unknown as ShiftPermissions,
      authority
    )

    await expect(service.open({ openingCashAmount: 1000 })).rejects.toMatchObject({
      category: 'configuration'
    })

    expect(markReconciliationRequired).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it.each([
    'DESKTOP_SHIFT_ALREADY_OPEN',
    'DESKTOP_SHIFT_NOT_OPEN',
    'DESKTOP_SHIFT_ALREADY_PAUSED',
    'DESKTOP_SHIFT_NOT_PAUSED',
    'DESKTOP_SHIFT_ACTIVE_PAUSE_NOT_FOUND'
  ])('retains reconciliation_required when %s cannot reconcile', async (backendCode) => {
    let authorityState = 'open'
    const request = vi.fn().mockRejectedValue(
      publicAppErrorSchema.parse({
        category: 'conflict',
        message: 'The shift state changed.',
        backendCode,
        retryable: false
      })
    )
    const authority: ShiftObservationAuthority = {
      captureContext: () => ({
        companyUuid: '11111111-1111-4111-8111-111111111111',
        deviceUuid: '22222222-2222-4222-8222-222222222222',
        userUuid: '33333333-3333-4333-8333-333333333333',
        sessionEpoch: 1
      }),
      markReconciliationRequired: () => {
        authorityState = 'reconciliation_required'
      },
      recordMutation: () => {
        authorityState = 'shift'
      },
      recordCurrent: () => {
        authorityState = 'current'
      }
    }
    const service = new ShiftService(
      { request } as unknown as DesktopApiClient,
      { assertAllowed: () => undefined } as unknown as CommercialAccessService,
      { assertShiftPermission: () => undefined } as unknown as ShiftPermissions,
      authority
    )

    await expect(
      service.close({ uuid: resource.uuid, actualCashAmount: 1000 })
    ).rejects.toMatchObject({
      backendCode
    })

    expect(request).toHaveBeenCalledTimes(2)
    expect(authorityState).toBe('reconciliation_required')
  })

  it('replaces reconciliation_required only after a successful current reconciliation', async () => {
    const conflict = publicAppErrorSchema.parse({
      category: 'conflict',
      message: 'The shift is not open.',
      backendCode: 'DESKTOP_SHIFT_NOT_OPEN',
      retryable: false
    })
    const request = vi.fn().mockRejectedValueOnce(conflict).mockResolvedValueOnce(resource)
    const recorded: string[] = []
    const authority: ShiftObservationAuthority = {
      captureContext: () => ({
        companyUuid: '11111111-1111-4111-8111-111111111111',
        deviceUuid: '22222222-2222-4222-8222-222222222222',
        userUuid: '33333333-3333-4333-8333-333333333333',
        sessionEpoch: 1
      }),
      markReconciliationRequired: () => recorded.push('reconciliation_required'),
      recordMutation: () => recorded.push('mutation'),
      recordCurrent: () => recorded.push('current')
    }
    const service = new ShiftService(
      { request } as unknown as DesktopApiClient,
      { assertAllowed: () => undefined } as unknown as CommercialAccessService,
      { assertShiftPermission: () => undefined } as unknown as ShiftPermissions,
      authority
    )

    await expect(service.close({ uuid: resource.uuid, actualCashAmount: 1000 })).rejects.toEqual(
      conflict
    )

    expect(recorded).toEqual(['reconciliation_required', 'current'])
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('retains reconciliation_required when shifts.view is absent during reconciliation', async () => {
    const request = vi.fn().mockRejectedValue(
      publicAppErrorSchema.parse({
        category: 'conflict',
        message: 'The shift is not open.',
        backendCode: 'DESKTOP_SHIFT_NOT_OPEN',
        retryable: false
      })
    )
    const recorded: string[] = []
    const authority: ShiftObservationAuthority = {
      captureContext: () => ({
        companyUuid: '11111111-1111-4111-8111-111111111111',
        deviceUuid: '22222222-2222-4222-8222-222222222222',
        userUuid: '33333333-3333-4333-8333-333333333333',
        sessionEpoch: 1
      }),
      markReconciliationRequired: () => recorded.push('reconciliation_required'),
      recordMutation: () => recorded.push('mutation'),
      recordCurrent: () => recorded.push('current')
    }
    const service = new ShiftService(
      { request } as unknown as DesktopApiClient,
      { assertAllowed: () => undefined } as unknown as CommercialAccessService,
      {
        assertShiftPermission: (permission) => {
          if (permission === 'shifts.view') {
            throw publicAppErrorSchema.parse({
              category: 'authorization',
              message: 'Missing shifts.view',
              retryable: false
            })
          }
        }
      } as unknown as ShiftPermissions,
      authority
    )

    await expect(
      service.close({ uuid: resource.uuid, actualCashAmount: 1000 })
    ).rejects.toMatchObject({
      backendCode: 'DESKTOP_SHIFT_NOT_OPEN'
    })

    expect(request).toHaveBeenCalledTimes(1)
    expect(recorded).toEqual(['reconciliation_required'])
  })

  it.each([
    publicAppErrorSchema.parse({
      category: 'transport',
      message: 'Timed out',
      retryable: true
    }),
    publicAppErrorSchema.parse({
      category: 'transport',
      message: 'Server failure',
      backendCode: 'SERVER_ERROR',
      retryable: true
    }),
    publicAppErrorSchema.parse({
      category: 'unexpected',
      message: 'Invalid envelope',
      backendCode: 'response_envelope_invalid',
      retryable: false
    }),
    new Error('Malformed successful shift response')
  ])('retains reconciliation_required for ambiguous outcomes', async (failure) => {
    const request = vi.fn().mockRejectedValue(failure)
    const recorded: string[] = []
    const authority: ShiftObservationAuthority = {
      captureContext: () => ({
        companyUuid: '11111111-1111-4111-8111-111111111111',
        deviceUuid: '22222222-2222-4222-8222-222222222222',
        userUuid: '33333333-3333-4333-8333-333333333333',
        sessionEpoch: 1
      }),
      markReconciliationRequired: () => recorded.push('reconciliation_required'),
      recordMutation: () => recorded.push('mutation'),
      recordCurrent: () => recorded.push('current')
    }
    const service = new ShiftService(
      { request } as unknown as DesktopApiClient,
      { assertAllowed: () => undefined } as unknown as CommercialAccessService,
      { assertShiftPermission: () => undefined } as unknown as ShiftPermissions,
      authority
    )

    await expect(service.close({ uuid: resource.uuid, actualCashAmount: 1000 })).rejects.toBe(
      failure
    )

    expect(request).toHaveBeenCalledTimes(1)
    expect(recorded).toEqual(['reconciliation_required'])
  })
})
