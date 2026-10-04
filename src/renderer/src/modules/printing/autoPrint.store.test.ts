// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { AutoPrintStatus } from '@shared/contracts/printing.contract'
import { useAutoPrintStore } from './autoPrint.store'

const SALE = '00000000-0000-4000-8000-000000000001'

function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data }
}

describe('useAutoPrintStore', () => {
  let statuses: AutoPrintStatus[]
  const printing = {
    autoPrintStatus: vi.fn(async () => ok(statuses.shift() ?? { state: 'pending', job: null })),
    autoPrintSetup: vi.fn(async () =>
      ok({ autoPrint: true, printerName: null, needsSetup: 'no_printer' as const })
    ),
    autoPrintNotices: vi.fn(async () =>
      ok([
        {
          invoiceLocalUuid: SALE,
          receiptNumber: 'POS-1',
          outcome: 'expired_unprinted' as const,
          decidedAt: 'x'
        }
      ])
    ),
    dismissAutoPrintNotices: vi.fn(async () => ok({ dismissed: true }))
  }

  beforeEach(() => {
    vi.useFakeTimers()
    ;(window as unknown as { posApi: unknown }).posApi = { printing }
    setActivePinia(createPinia())
    statuses = []
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('follows a sale until its automatic print is decided and finished, then stops', async () => {
    const job = {
      jobUuid: '00000000-0000-4000-8000-000000000009',
      status: 'in_progress' as const,
      phase: 'preparing' as const,
      failureCode: null,
      cancelOrigin: null,
      createdAt: 'x',
      dispatchedAt: null,
      finishedAt: null,
      isReprint: false
    }
    statuses = [
      { state: 'pending', job: null },
      { state: 'admitted', job },
      { state: 'admitted', job: { ...job, status: 'submitted', phase: null } }
    ]
    const store = useAutoPrintStore()

    await store.watchSale(SALE)
    expect(store.sale?.status.state).toBe('pending')
    await vi.advanceTimersByTimeAsync(600)
    expect(store.sale?.status.job?.status).toBe('in_progress')
    await vi.advanceTimersByTimeAsync(600)
    expect(store.sale?.status.job?.status).toBe('submitted')
    await vi.advanceTimersByTimeAsync(5000)
    expect(printing.autoPrintStatus).toHaveBeenCalledTimes(3)
  })

  it('a new signed-in user gets a fresh banner and no inherited notices', async () => {
    const store = useAutoPrintStore()
    store.ensureIdentity('in:a')
    await store.loadSetup()
    await store.loadNotices()
    store.dismissSetup()
    expect(store.setupDismissed).toBe(true)
    expect(store.notices).toHaveLength(1)

    store.ensureIdentity('in:b')
    expect(store.setupDismissed).toBe(false)
    expect(store.notices).toHaveLength(0)
    expect(store.setup).toBeNull()
  })

  it('dismissing notices clears them here and in main', async () => {
    const store = useAutoPrintStore()
    await store.loadNotices()
    await store.dismissNotices()
    expect(store.notices).toHaveLength(0)
    expect(printing.dismissAutoPrintNotices).toHaveBeenCalledTimes(1)
  })
})
