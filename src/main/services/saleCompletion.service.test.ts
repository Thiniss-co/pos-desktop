import { describe, expect, it, vi } from 'vitest'
import type { CheckoutIntent } from '@shared/contracts/checkout.contract'
import type { SaleAttemptRow } from '@shared/contracts/sale.contract'
import type { PreparedSale } from './localSale.service'
import { SaleCompletionService } from './saleCompletion.service'

const ATTEMPT_KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const claimed = {
  attemptKey: ATTEMPT_KEY,
  companyUuid: '11111111-1111-4111-8111-111111111111',
  deviceUuid: '33333333-3333-4333-8333-333333333333',
  userUuid: '44444444-4444-4444-8444-444444444444',
  originWarehouseUuid: '88888888-8888-4888-8888-888888888888'
} as SaleAttemptRow

const intent = { items: [], payments: [] } as unknown as CheckoutIntent
const ready: PreparedSale = { kind: 'ready', claimed, intent }
const committed = { outcome: 'committed', attemptKey: ATTEMPT_KEY } as never

type AnyMock = ReturnType<typeof vi.fn>

interface Harness {
  readonly service: SaleCompletionService
  readonly localSale: Record<'prepareCompletion' | 'prepareRetry' | 'trackedDemand', AnyMock> & {
    readonly runPrepared: AnyMock
  }
  readonly acquire: AnyMock
  readonly runPrepared: AnyMock
}

function build(overrides: {
  prepared?: PreparedSale
  trackedDemand?: readonly { lineId: string; productUuid: string; requiredMilli: number }[]
  acquire?: AnyMock
  runPrepared?: AnyMock
}): Harness {
  const acquire = overrides.acquire ?? vi.fn().mockResolvedValue({ kind: 'proceed' })
  const runPrepared = overrides.runPrepared ?? vi.fn().mockReturnValue(committed)
  const localSale = {
    prepareCompletion: vi.fn().mockReturnValue(overrides.prepared ?? ready),
    prepareRetry: vi.fn().mockReturnValue(overrides.prepared ?? ready),
    trackedDemand: vi.fn().mockReturnValue(overrides.trackedDemand ?? []),
    runPrepared
  }

  return {
    service: new SaleCompletionService({
      localSale,
      acquisition: { acquire }
    } as unknown as ConstructorParameters<typeof SaleCompletionService>[0]),
    localSale,
    acquire,
    runPrepared
  }
}

const trackedLine = {
  lineId: 'line-1',
  productUuid: '66666666-6666-4666-8666-666666666666',
  requiredMilli: 1000
}

describe('SaleCompletionService', () => {
  it('never touches the allocation endpoint for a cart with no tracked line', async () => {
    const { service, acquire, runPrepared } = build({})

    await service.complete(ATTEMPT_KEY, intent)

    expect(acquire).not.toHaveBeenCalled()
    expect(runPrepared).toHaveBeenCalledTimes(1)
  })

  it('acquires before the business transaction, never after it', async () => {
    const order: string[] = []
    const acquire = vi.fn().mockImplementation(async () => {
      order.push('acquire')
      return { kind: 'proceed' }
    })
    const runPrepared = vi.fn().mockImplementation(() => {
      order.push('run')
      return committed
    })
    const { service } = build({ trackedDemand: [trackedLine], acquire, runPrepared })

    await service.complete(ATTEMPT_KEY, intent)

    expect(order).toEqual(['acquire', 'run'])
  })

  it('passes only the attempt-owned immutable origin, never a renderer-supplied one', async () => {
    const { service, acquire } = build({ trackedDemand: [trackedLine] })

    await service.complete(ATTEMPT_KEY, intent)

    expect(acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptKey: ATTEMPT_KEY,
        owner: {
          companyUuid: claimed.companyUuid,
          deviceUuid: claimed.deviceUuid,
          warehouseUuid: claimed.originWarehouseUuid
        },
        trackedLines: [trackedLine]
      })
    )
  })

  it('stops before the business transaction when the acquisition is blocked', async () => {
    const acquire = vi
      .fn()
      .mockResolvedValue({ kind: 'blocked', code: 'allocation-acquisition-unresolved' })
    const { service, runPrepared } = build({ trackedDemand: [trackedLine], acquire })

    const outcome = await service.complete(ATTEMPT_KEY, intent)

    expect(outcome).toEqual({
      outcome: 'failed',
      code: 'allocation-acquisition-unresolved',
      attemptKey: ATTEMPT_KEY
    })
    expect(runPrepared).not.toHaveBeenCalled()
  })

  it('returns a settled preparation without preparing an acquisition', async () => {
    const settled: PreparedSale = {
      kind: 'settled',
      outcome: { outcome: 'failed', code: 'attempt-blocked', attemptKey: null }
    }
    const { service, acquire, runPrepared } = build({ prepared: settled })

    expect(await service.complete(ATTEMPT_KEY, intent)).toEqual(settled.outcome)
    expect(acquire).not.toHaveBeenCalled()
    expect(runPrepared).not.toHaveBeenCalled()
  })

  it('coalesces a double submit of one attempt into a single acquisition and transaction', async () => {
    const pending: (() => void)[] = []
    const acquire = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(() => resolve({ kind: 'proceed' }))
        })
    )
    const { service, localSale, runPrepared } = build({ trackedDemand: [trackedLine], acquire })

    const first = service.complete(ATTEMPT_KEY, intent)
    const second = service.complete(ATTEMPT_KEY, intent)
    for (const resolve of pending) {
      resolve()
    }

    expect(await first).toEqual(committed)
    expect(await second).toEqual(committed)
    expect(localSale.prepareCompletion).toHaveBeenCalledTimes(1)
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(runPrepared).toHaveBeenCalledTimes(1)
  })

  it('releases the single-flight slot so a later explicit retry of the same key still runs', async () => {
    const { service, acquire } = build({ trackedDemand: [trackedLine] })

    await service.complete(ATTEMPT_KEY, intent)
    await service.retry(ATTEMPT_KEY)

    expect(acquire).toHaveBeenCalledTimes(2)
  })
})
