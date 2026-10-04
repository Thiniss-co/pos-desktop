import { describe, expect, it, vi } from 'vitest'
import { EntityCreateWorker, entityCreateRetryDelay } from './entityCreateWorker'
import type { OutboxRow } from '../repositories/quickCreate.repository'
import { toMinorUnits } from '../services/quickCreate.service'

const row = (key: string): OutboxRow =>
  ({
    requestKey: key,
    entityType: 'customer',
    clientEntityUuid: key,
    dispatchCount: 1
  }) as OutboxRow

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- a local test fixture whose mocks are typed by inference
function worker(options: { claims: Array<OutboxRow | null>; online?: boolean }) {
  const settled: unknown[] = []
  const repository = {
    claimNext: vi.fn(() => options.claims.shift() ?? null),
    settle: vi.fn((key: string, _lease: string, outcome: unknown) => {
      settled.push([key, outcome])
      return true
    }),
    reclaimExpired: vi.fn(() => 0),
    nextRetryAt: vi.fn(() => null)
  }
  const dispatch = vi.fn(async () => ({
    kind: 'blocked_permission' as const,
    code: 'PERMISSION_DENIED',
    message: null,
    fields: null,
    traceId: null
  }))
  const instance = new EntityCreateWorker({
    repository,
    access: { access: () => ({ available: true, customer: true, supplier: true, product: true }) },
    session: {
      getContext: () => ({
        isAuthenticated: true,
        userUuid: 'u',
        companyUuid: 'c',
        deviceUuid: 'd'
      })
    },
    dispatch,
    isOnline: () => options.online ?? true,
    schedule: () => () => undefined
  })
  return { instance, repository, dispatch, settled }
}

describe('EntityCreateWorker', () => {
  it('never sends the same request twice in one drain, even if the repository offers it again', async () => {
    const { instance, dispatch, settled } = worker({ claims: [row('a'), row('a'), row('b')] })
    await instance.run()
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(settled[1]).toEqual([
      'a',
      expect.objectContaining({ state: 'unknown', code: 'RETRY_LATER' })
    ])
  })

  it('claims nothing while the service is unreachable (requests keep their never-sent proof)', async () => {
    const { instance, repository, dispatch } = worker({ claims: [row('a')], online: false })
    await instance.run()
    expect(repository.claimNext).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('backs off unknown outcomes up to five minutes', () => {
    expect(entityCreateRetryDelay(1)).toBe(5_000)
    expect(entityCreateRetryDelay(3)).toBe(20_000)
    expect(entityCreateRetryDelay(20)).toBe(300_000)
  })
})

describe('toMinorUnits', () => {
  it('converts in the catalog currency exponent and refuses extra precision', () => {
    expect(toMinorUnits('3.5', 2)).toBe(350)
    expect(toMinorUnits('4.25', 2)).toBe(425)
    expect(toMinorUnits('12', 3)).toBe(12_000)
    expect(toMinorUnits('1.50', 2)).toBe(150)
    expect(() => toMinorUnits('1.234', 2)).toThrow()
    expect(() => toMinorUnits('abc', 2)).toThrow()
  })
})
