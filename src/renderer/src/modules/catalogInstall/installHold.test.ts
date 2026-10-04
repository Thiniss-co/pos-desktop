// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia } from 'pinia'
import { reactive } from 'vue'

/*
 * Rev 4 §8.2 (review fix): the renderer keeps the install hold until it has applied exactly the
 * revision main installed. A catalog read that failed (reported through `catalog.error`, not thrown)
 * or that still shows the superseded revision keeps the hold armed and retries.
 */
const OLD = 'a'.repeat(64)
const NEW = 'b'.repeat(64)
const HOLD = '00000000-0000-4000-8000-000000000001'

const cart = reactive({ lines: [] as unknown[], heldDrafts: [] as unknown[], setContract: vi.fn() })
const payment = reactive({
  rows: [] as unknown[],
  attemptKey: null,
  blockingAttemptKey: null,
  completionPending: false,
  panelOpen: false,
  discoverPending: vi.fn()
})
const reads: Array<{ revision: string; error: unknown }> = []
const catalog = reactive({
  status: null as null | { catalogValid: boolean; contract: { revision: string } },
  error: null as unknown,
  recordInstall: vi.fn(),
  initialize: vi.fn(async () => {
    const next = reads.shift() ?? { revision: NEW, error: null }
    catalog.error = next.error
    catalog.status = { catalogValid: true, contract: { revision: next.revision } }
  })
})

vi.mock('../pos/cart.store', () => ({ useCartStore: () => cart }))
vi.mock('../pos/payment.store', () => ({ usePaymentStore: () => payment }))
vi.mock('../pos/catalog.store', () => ({ useCatalogStore: () => catalog }))

let onHold: (request: unknown) => void = () => undefined
let onRelease: (release: unknown) => void = () => undefined

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  reads.length = 0
  cart.setContract.mockClear()
  catalog.status = { catalogValid: true, contract: { revision: OLD } }
  catalog.error = null
  ;(window as unknown as { posApi: unknown }).posApi = {
    catalogInstall: {
      reportDraftState: vi.fn(async () => ({ ok: true, data: null })),
      replyHold: vi.fn(async () => ({ ok: true, data: null })),
      holdStatus: vi.fn(async () => ({ ok: true, data: { state: 'installing', revision: null } })),
      onHold: (listener: (request: unknown) => void) => (onHold = listener),
      onRelease: (listener: (release: unknown) => void) => (onRelease = listener)
    }
  }
})

afterEach(() => vi.useRealTimers())

async function armedClient(): Promise<typeof import('./installHold')> {
  const module = await import('./installHold')
  module.startCatalogInstallClient(createPinia())
  onHold({ holdId: HOLD, path: 'background', consentGeneration: null })
  expect(module.installHoldActive.value).toBe(true)

  return module
}

describe('catalog install hold (renderer)', () => {
  it('stays armed while the read still shows the superseded revision, then applies the installed one', async () => {
    const module = await armedClient()
    reads.push({ revision: OLD, error: null }, { revision: NEW, error: null })
    let released = false
    void module.waitForInstallHold().then(() => (released = true))

    onRelease({ holdId: HOLD, installed: true, revision: NEW })
    await vi.advanceTimersByTimeAsync(0)
    expect(released).toBe(false)
    expect(module.installHoldActive.value).toBe(true)
    // A new waiter during the retry still waits: the hold is not open before the contract is applied.
    let lateReleased = false
    void module.waitForInstallHold().then(() => (lateReleased = true))

    await vi.advanceTimersByTimeAsync(600)
    expect(released).toBe(true)
    expect(lateReleased).toBe(true)
    expect(cart.setContract).toHaveBeenCalledTimes(1)
    expect(cart.setContract).toHaveBeenCalledWith({ revision: NEW })
  })

  it('keeps holding when the catalog read failed without throwing', async () => {
    const module = await armedClient()
    reads.push(
      { revision: OLD, error: { key: 'pos.catalogUnavailable' } },
      { revision: NEW, error: null }
    )

    onRelease({ holdId: HOLD, installed: true, revision: NEW })
    await vi.advanceTimersByTimeAsync(0)
    expect(module.installHoldActive.value).toBe(true)
    expect(cart.setContract).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(600)
    expect(module.installHoldActive.value).toBe(false)
    expect(cart.setContract).toHaveBeenCalledWith({ revision: NEW })
  })
})
