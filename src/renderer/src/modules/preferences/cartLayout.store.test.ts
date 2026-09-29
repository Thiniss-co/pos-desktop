// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { PosCartWidthPreference } from '@shared/contracts/preferences.contract'
import {
  CART_WIDTH_PERSIST_DEBOUNCE_MS,
  normalizeCartWidth,
  resolveInitialCartWidth,
  useCartLayoutStore,
  type CartWidthPreferencesService
} from './cartLayout.store'

function createService(initial: PosCartWidthPreference = null): {
  service: CartWidthPreferencesService
  saved: () => PosCartWidthPreference
  setPosCartWidth: ReturnType<typeof vi.fn>
} {
  let saved = initial
  const setPosCartWidth = vi.fn(async (width: PosCartWidthPreference) => {
    saved = width
    return width
  })

  return {
    service: { getPosCartWidth: async () => saved, setPosCartWidth },
    saved: () => saved,
    setPosCartWidth
  }
}

describe('cart layout preference store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('normalizes to whole pixels inside the storable range and ignores non-finite input', () => {
    expect(normalizeCartWidth(401.6)).toBe(402)
    expect(normalizeCartWidth(100)).toBe(320)
    expect(normalizeCartWidth(5000)).toBe(960)
    expect(normalizeCartWidth(Number.NaN)).toBeNull()
    expect(normalizeCartWidth(Number.POSITIVE_INFINITY)).toBeNull()
  })

  it('resolves the stored width, falling back to the design default when the read fails', async () => {
    await expect(resolveInitialCartWidth({ getPosCartWidth: async () => 448 })).resolves.toBe(448)
    await expect(resolveInitialCartWidth({ getPosCartWidth: async () => null })).resolves.toBeNull()
    await expect(
      resolveInitialCartWidth({
        getPosCartWidth: async () => {
          throw new Error('IPC unavailable')
        }
      })
    ).resolves.toBeNull()
  })

  it('initializes from the persisted width once, and never rejects', async () => {
    const getPosCartWidth = vi.fn(async () => 512)
    const store = useCartLayoutStore()

    await expect(store.initialize({ getPosCartWidth, setPosCartWidth: vi.fn() })).resolves.toBe(512)
    await store.initialize({ getPosCartWidth, setPosCartWidth: vi.fn() })

    expect(store.width).toBe(512)
    expect(getPosCartWidth).toHaveBeenCalledTimes(1)
  })

  it('initializes to the design default when the preload bridge is missing entirely', async () => {
    // No service injected and no window.posApi: constructing the default service throws, which
    // must degrade to "default width" rather than break startup.
    const store = useCartLayoutStore()

    await expect(store.initialize()).resolves.toBeNull()
    expect(store.width).toBeNull()
  })

  it('does not let a slow startup read overwrite a width the cashier already chose', async () => {
    let releaseRead: (value: PosCartWidthPreference) => void = () => undefined
    const { service } = createService()
    const slowService: CartWidthPreferencesService = {
      getPosCartWidth: () =>
        new Promise((resolve) => {
          releaseRead = resolve
        }),
      setPosCartWidth: service.setPosCartWidth
    }
    const store = useCartLayoutStore()

    const initialization = store.initialize(slowService)
    store.setWidth(480, slowService)
    releaseRead(600)

    await expect(initialization).resolves.toBe(480)
    expect(store.width).toBe(480)
  })

  it('applies a width immediately and persists it once, after the debounce, while dragging', async () => {
    vi.useFakeTimers()
    const { service, saved, setPosCartWidth } = createService()
    const store = useCartLayoutStore()

    store.setWidth(400, service)
    expect(store.width).toBe(400)
    await vi.advanceTimersByTimeAsync(CART_WIDTH_PERSIST_DEBOUNCE_MS - 50)
    store.setWidth(420, service)
    store.setWidth(441.4, service)
    expect(store.width).toBe(441)
    expect(setPosCartWidth).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(CART_WIDTH_PERSIST_DEBOUNCE_MS)

    expect(setPosCartWidth).toHaveBeenCalledTimes(1)
    expect(setPosCartWidth).toHaveBeenCalledWith(441)
    expect(saved()).toBe(441)
    expect(store.persistenceFailed).toBe(false)
    expect(store.isSaving).toBe(false)
  })

  it('clamps an out-of-range request to the storable range before applying it', async () => {
    vi.useFakeTimers()
    const { service, setPosCartWidth } = createService()
    const store = useCartLayoutStore()

    store.setWidth(2000, service)
    expect(store.width).toBe(960)
    await vi.advanceTimersByTimeAsync(CART_WIDTH_PERSIST_DEBOUNCE_MS)
    expect(setPosCartWidth).toHaveBeenCalledWith(960)
  })

  it('ignores non-finite widths without scheduling a write', async () => {
    vi.useFakeTimers()
    const { service, setPosCartWidth } = createService()
    const store = useCartLayoutStore()

    store.setWidth(Number.NaN, service)
    await vi.advanceTimersByTimeAsync(CART_WIDTH_PERSIST_DEBOUNCE_MS * 2)

    expect(store.width).toBeNull()
    expect(setPosCartWidth).not.toHaveBeenCalled()
  })

  it('flush() writes a pending width straight away (drag end)', async () => {
    vi.useFakeTimers()
    const { service, setPosCartWidth } = createService()
    const store = useCartLayoutStore()

    store.setWidth(500, service)
    await expect(store.flush()).resolves.toBe(true)
    expect(setPosCartWidth).toHaveBeenCalledWith(500)

    // Nothing left to write: the debounced timer was cancelled by the flush.
    await vi.advanceTimersByTimeAsync(CART_WIDTH_PERSIST_DEBOUNCE_MS * 2)
    expect(setPosCartWidth).toHaveBeenCalledTimes(1)
    await expect(store.flush()).resolves.toBe(true)
    expect(setPosCartWidth).toHaveBeenCalledTimes(1)
  })

  it('reset() restores the design default, cancels a pending write and persists null', async () => {
    vi.useFakeTimers()
    const { service, saved, setPosCartWidth } = createService(512)
    const store = useCartLayoutStore()
    await store.initialize(service)

    store.setWidth(600, service)
    await expect(store.reset(service)).resolves.toBe(true)

    expect(store.width).toBeNull()
    expect(saved()).toBeNull()
    await vi.advanceTimersByTimeAsync(CART_WIDTH_PERSIST_DEBOUNCE_MS * 2)
    // Only the reset was written; the superseded 600 never was.
    expect(setPosCartWidth.mock.calls).toEqual([[null]])
  })

  it('lets only the most recent write decide the saving/failed flags when writes overlap', async () => {
    const pending: Array<{
      width: PosCartWidthPreference
      resolve: () => void
      reject: () => void
    }> = []
    const service: CartWidthPreferencesService = {
      getPosCartWidth: async () => null,
      setPosCartWidth: (width) =>
        new Promise<PosCartWidthPreference>((resolve, reject) => {
          pending.push({
            width,
            resolve: () => resolve(width),
            reject: () => reject(new Error('disk full'))
          })
        })
    }
    const store = useCartLayoutStore()

    store.setWidth(500, service)
    const first = store.flush()
    const second = store.reset(service)
    expect(store.isSaving).toBe(true)

    // The newer reset succeeds first; the older width write then fails late. The stale failure
    // must neither flag persistenceFailed nor bring the old width back.
    pending[1].resolve()
    await expect(second).resolves.toBe(true)
    pending[0].reject()
    await expect(first).resolves.toBe(false)

    expect(store.width).toBeNull()
    expect(store.persistenceFailed).toBe(false)
    expect(store.isSaving).toBe(false)
  })

  it('keeps the width for this session and flags persistenceFailed when the write rejects', async () => {
    const service: CartWidthPreferencesService = {
      getPosCartWidth: async () => null,
      setPosCartWidth: async () => {
        throw new Error('disk full')
      }
    }
    const store = useCartLayoutStore()

    store.setWidth(456, service)
    await expect(store.flush()).resolves.toBe(false)

    expect(store.width).toBe(456)
    expect(store.persistenceFailed).toBe(true)
    expect(store.isSaving).toBe(false)

    // A later successful write clears the flag.
    const recovered = createService()
    store.setWidth(470, recovered.service)
    await expect(store.flush()).resolves.toBe(true)
    expect(store.persistenceFailed).toBe(false)
  })
})
