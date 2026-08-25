import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { publicAppErrorSchema } from '@shared/contracts/api.contract'
import type { Shift } from '@shared/contracts/shift.contract'
import { ShiftRendererService } from './shift.service'
import { useShiftStore } from './shift.store'

const openShift: Shift = {
  uuid: '11111111-1111-4111-8111-111111111111',
  status: 'open',
  openingCashAmount: 1000,
  expectedCashAmount: 1000,
  actualCashAmount: null,
  cashDifferenceAmount: null,
  openedAt: '2026-01-01T00:00:00Z',
  closedAt: null,
  pausedAt: null,
  pauseCount: 0,
  totalPausedSeconds: 0,
  activePause: null,
  notes: null,
  closeNotes: null
}

function gateway(overrides: Partial<Window['posApi']['shifts']> = {}): Window['posApi']['shifts'] {
  return {
    current: async () => ({ ok: true, data: null }),
    get: async () => ({ ok: true, data: openShift }),
    open: async () => ({ ok: true, data: openShift }),
    pause: async () => ({ ok: true, data: { ...openShift, status: 'paused' } }),
    resume: async () => ({ ok: true, data: openShift }),
    close: async () => ({ ok: true, data: { ...openShift, status: 'closed' } }),
    ...overrides
  }
}

describe('useShiftStore', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('does not optimistically mutate before backend confirmation', async () => {
    let resolve!: (value: Awaited<ReturnType<Window['posApi']['shifts']['open']>>) => void
    const pending = new Promise<Awaited<ReturnType<Window['posApi']['shifts']['open']>>>((done) => {
      resolve = done
    })
    const service = new ShiftRendererService(gateway({ open: () => pending }))
    const store = useShiftStore()
    await store.loadCurrent(service)

    const operation = store.open({ openingCashAmount: 1000 }, service)
    expect(store.currentShift).toBeNull()
    expect(store.mutation).toBe('opening')
    resolve({ ok: true, data: openShift })
    await operation

    expect(store.currentShift).toEqual(openShift)
    expect(store.mutation).toBeNull()
  })

  it('keeps the newest current-state request when responses arrive out of order', async () => {
    const resolvers: Array<(value: Shift | null) => void> = []
    const service = {
      current: () => new Promise<Shift | null>((resolve) => resolvers.push(resolve))
    } as ShiftRendererService
    const store = useShiftStore()
    const first = store.loadCurrent(service)
    const second = store.loadCurrent(service)
    resolvers[1]({ ...openShift, status: 'paused' })
    await second
    resolvers[0](openShift)
    await first

    expect(store.currentShift?.status).toBe('paused')
  })

  it('never authorizes checkout when a defensive cancelled response reaches the store', async () => {
    const cancelledShift: Shift = { ...openShift, status: 'cancelled', expectedCashAmount: -250 }
    const store = useShiftStore()

    await store.loadCurrent(
      new ShiftRendererService(
        gateway({ current: async () => ({ ok: true, data: cancelledShift }) })
      )
    )

    expect(store.currentShift).toEqual(cancelledShift)
    expect(store.canSell).toBe(false)
  })

  it('reconciles signed expected cash from a successful close response', async () => {
    const closedShift: Shift = {
      ...openShift,
      status: 'closed',
      expectedCashAmount: -250,
      actualCashAmount: 0,
      cashDifferenceAmount: 250
    }
    const store = useShiftStore()
    const service = new ShiftRendererService(
      gateway({ close: async () => ({ ok: true, data: closedShift }) })
    )
    await store.loadCurrent(service)

    expect(await store.close({ uuid: openShift.uuid, actualCashAmount: 0 }, service)).toBe(true)
    expect(store.currentShift).toEqual(closedShift)
    expect(store.currentShift?.expectedCashAmount).toBe(-250)
  })

  it('reconciles an ambiguous transport failure before allowing another mutation', async () => {
    const transport = publicAppErrorSchema.parse({
      category: 'transport',
      message: 'Network failed',
      retryable: true
    })
    let currentCalls = 0
    const current = vi.fn(async () => {
      currentCalls += 1
      return { ok: true as const, data: currentCalls === 1 ? null : openShift }
    })
    const service = new ShiftRendererService(
      gateway({ current, open: async () => ({ ok: false, error: transport }) })
    )
    const store = useShiftStore()
    await store.loadCurrent(service)

    expect(await store.open({ openingCashAmount: 1000 }, service)).toBe(false)
    expect(current).toHaveBeenCalledTimes(2)
    expect(store.freshness).toBe('current')
    expect(store.currentShift).toEqual(openShift)
  })

  it('recovers a failed current-state read before issuing a shift mutation', async () => {
    const statusFailure = publicAppErrorSchema.parse({
      category: 'authorization',
      message: 'Desktop device branch and warehouse assignments are required.',
      backendCode: 'DESKTOP_SHIFT_ACCESS_DENIED',
      retryable: false
    })
    const current = vi
      .fn()
      .mockRejectedValueOnce(statusFailure)
      .mockResolvedValueOnce({ ok: true as const, data: null })
    const open = vi.fn(async () => ({ ok: true as const, data: openShift }))
    const service = new ShiftRendererService(gateway({ current, open }))
    const store = useShiftStore()

    await expect(store.loadCurrent(service)).resolves.toBe(false)
    expect(store.freshness).toBe('error')

    await expect(store.open({ openingCashAmount: 1000 }, service)).resolves.toBe(true)
    expect(current).toHaveBeenCalledTimes(2)
    expect(open).toHaveBeenCalledTimes(1)
    expect(store.freshness).toBe('current')
    expect(store.currentShift).toEqual(openShift)
  })

  it('refreshes a stable shift-state conflict while preserving its localized error', async () => {
    const conflict = publicAppErrorSchema.parse({
      category: 'conflict',
      message: 'A shift is already open',
      backendCode: 'DESKTOP_SHIFT_ALREADY_OPEN',
      retryable: false
    })
    let currentCalls = 0
    const service = new ShiftRendererService(
      gateway({
        current: async () => ({
          ok: true,
          data: ++currentCalls === 1 ? null : openShift
        }),
        open: async () => ({ ok: false, error: conflict })
      })
    )
    const store = useShiftStore()
    await store.loadCurrent(service)
    await store.open({ openingCashAmount: 1000 }, service)

    expect(store.currentShift).toEqual(openShift)
    expect(store.error).toBe('A shift is already open.')
  })
})
