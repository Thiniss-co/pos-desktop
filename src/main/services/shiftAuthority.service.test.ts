import { describe, expect, it } from 'vitest'
import type { SessionContext } from '../repositories/sessionMetadata.repository'
import type { StoredShiftObservation } from '../repositories/shiftObservation.repository'
import { ShiftAuthorityService } from './shiftAuthority.service'

const identity = {
  companyUuid: '11111111-1111-4111-8111-111111111111',
  deviceUuid: '22222222-2222-4222-8222-222222222222',
  userUuid: '33333333-3333-4333-8333-333333333333',
  sessionEpoch: 7
} as const

function openObservation(
  overrides: Partial<Extract<StoredShiftObservation, { kind: 'shift' }>> = {}
): Extract<StoredShiftObservation, { kind: 'shift' }> {
  return {
    kind: 'shift',
    ...identity,
    shiftUuid: '44444444-4444-4444-8444-444444444444',
    status: 'open',
    openedAt: '2026-01-01T00:00:00.000Z',
    observedAt: '2026-01-01T01:00:00.000Z',
    source: 'current',
    ...overrides
  }
}

interface AuthorityTestSetup {
  readonly service: ShiftAuthorityService
  stored(): StoredShiftObservation | null
  setCompanyUuid(value: string): void
  setDeviceUuid(value: string): void
  setUserUuid(value: string): void
  setEpoch(value: number): void
}

function setup(observation: StoredShiftObservation | null): AuthorityTestSetup {
  let stored = observation
  let session: SessionContext = {
    isAuthenticated: true,
    userUuid: identity.userUuid,
    userIsActive: true,
    companyUuid: identity.companyUuid,
    deviceUuid: identity.deviceUuid,
    serverDeviceId: '55555555-5555-4555-8555-555555555555'
  }
  let companyUuid: string = identity.companyUuid
  let deviceUuid: string = identity.deviceUuid
  let epoch: number = identity.sessionEpoch

  const service = new ShiftAuthorityService({
    observations: {
      get: () => stored,
      write: (value) => {
        stored = value
      }
    },
    session: { getContext: () => session },
    company: {
      getCompany: () => ({
        companyUuid,
        name: 'Example Company',
        isActive: true,
        updatedAt: '2026-01-01T00:00:00.000Z'
      })
    },
    device: {
      getOrCreate: () => ({
        deviceUuid,
        deviceName: 'Register',
        platform: 'linux',
        osVersion: '6.0',
        appVersion: '1.0.0',
        isRegistered: true
      })
    },
    epoch: { current: () => epoch },
    now: () => new Date('2026-01-01T02:00:00.000Z')
  })

  return {
    service,
    stored: () => stored,
    setCompanyUuid: (value: string) => {
      companyUuid = value
      session = { ...session, companyUuid: value }
    },
    setDeviceUuid: (value: string) => {
      deviceUuid = value
      session = { ...session, deviceUuid: value }
    },
    setUserUuid: (value: string) => {
      session = { ...session, userUuid: value }
    },
    setEpoch: (value: number) => {
      epoch = value
    }
  }
}

describe('ShiftAuthorityService.resolveForSell', () => {
  it.each([
    ['open', openObservation(), { kind: 'open' }],
    ['paused', openObservation({ status: 'paused' }), { kind: 'not-open', status: 'paused' }],
    ['closed', openObservation({ status: 'closed' }), { kind: 'not-open', status: 'closed' }],
    [
      'cancelled',
      openObservation({ status: 'cancelled' }),
      { kind: 'not-open', status: 'cancelled' }
    ],
    [
      'none',
      {
        kind: 'none',
        ...identity,
        observedAt: '2026-01-01T01:00:00.000Z',
        source: 'current'
      } satisfies StoredShiftObservation,
      { kind: 'none' }
    ],
    [
      'reconciliation required',
      {
        kind: 'reconciliation_required',
        ...identity,
        observedAt: '2026-01-01T01:00:00.000Z',
        source: 'close'
      } satisfies StoredShiftObservation,
      { kind: 'reconciliation-required' }
    ]
  ] as const)('resolves %s fail-closed except for open', (_name, observation, expected) => {
    expect(setup(observation).service.resolveForSell()).toMatchObject(expected)
  })

  it('returns unknown when no observation has been recorded', () => {
    expect(setup(null).service.resolveForSell()).toEqual({ kind: 'unknown' })
  })

  it('returns foreign when any authority identity field moves', () => {
    const changes = [
      (test: ReturnType<typeof setup>) =>
        test.setCompanyUuid('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      (test: ReturnType<typeof setup>) =>
        test.setDeviceUuid('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
      (test: ReturnType<typeof setup>) => test.setUserUuid('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
      (test: ReturnType<typeof setup>) => test.setEpoch(identity.sessionEpoch + 1)
    ]

    for (const change of changes) {
      const test = setup(openObservation())
      change(test)
      expect(test.service.resolveForSell()).toEqual({ kind: 'foreign' })
    }
  })
})

describe('ShiftAuthorityService writes', () => {
  it('records current null as none without fabricating shift fields', () => {
    const test = setup(null)
    const context = test.service.captureContext()
    test.service.recordCurrent(context, null)

    expect(test.stored()).toEqual({
      kind: 'none',
      ...identity,
      observedAt: '2026-01-01T02:00:00.000Z',
      source: 'current'
    })
  })

  it('requires an observed open shift before it can assert sell authority', () => {
    const service = setup(openObservation({ status: 'paused' })).service

    expect(() => service.assertOpenForSell()).toThrow('An observed open shift is required')
  })
})
