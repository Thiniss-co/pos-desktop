import { ref } from 'vue'
import { defineStore } from 'pinia'
import {
  POS_CART_WIDTH_MAX,
  POS_CART_WIDTH_MIN,
  type PosCartWidthPreference
} from '@shared/contracts/preferences.contract'
import { PreferencesService } from './service'

/** How long a width must stay still before it is written (a drag emits a width per frame). */
export const CART_WIDTH_PERSIST_DEBOUNCE_MS = 300

export type CartWidthPreferencesService = Pick<
  PreferencesService,
  'getPosCartWidth' | 'setPosCartWidth'
>

/**
 * Rounds to whole pixels and clamps to the storable range. This is the *storage* range only; the
 * workspace shell further clamps the applied width to what the current window can fit.
 */
export function normalizeCartWidth(px: number): number | null {
  if (!Number.isFinite(px)) {
    return null
  }

  return Math.min(POS_CART_WIDTH_MAX, Math.max(POS_CART_WIDTH_MIN, Math.round(px)))
}

export async function resolveInitialCartWidth(
  service: Pick<CartWidthPreferencesService, 'getPosCartWidth'>
): Promise<PosCartWidthPreference> {
  try {
    return await service.getPosCartWidth()
  } catch {
    return null
  }
}

/**
 * The POS cart column width — a LAYOUT-ONLY preference persisted in main (`ui.posCartWidth`),
 * never in browser storage, and never carrying any sale/cart state. `width === null` means the
 * design's per-breakpoint default.
 *
 * Mirrors theme.store.ts: the visible value changes immediately, persistence is best-effort
 * (`persistenceFailed` flags a write that may not survive a restart, but the session keeps the
 * width), and only the most recent write decides the saving/failed flags.
 */
export const useCartLayoutStore = defineStore('cartLayout', () => {
  const width = ref<PosCartWidthPreference>(null)
  const isSaving = ref(false)
  const persistenceFailed = ref(false)
  let initialization: Promise<PosCartWidthPreference> | null = null
  // A width the cashier sets while the startup read is still in flight must not be overwritten by
  // that (older) stored value when it lands.
  let changedLocally = false
  let latestRequest = 0
  let pendingTimer: ReturnType<typeof setTimeout> | null = null
  let pendingPersist: {
    value: PosCartWidthPreference
    service: CartWidthPreferencesService | undefined
  } | null = null
  let defaultService: PreferencesService | null = null

  // Built lazily (and inside the callers' try blocks): constructing the service reads
  // `window.posApi`, and a missing bridge must degrade to "not persisted", never to a throw from
  // a drag handler.
  function resolveService(service?: CartWidthPreferencesService): CartWidthPreferencesService {
    if (service) {
      return service
    }

    defaultService ??= new PreferencesService()
    return defaultService
  }

  async function initialize(
    service?: CartWidthPreferencesService
  ): Promise<PosCartWidthPreference> {
    if (initialization) {
      return initialization
    }

    initialization = (async () => {
      let stored: PosCartWidthPreference = null

      try {
        stored = await resolveInitialCartWidth(resolveService(service))
      } catch {
        stored = null
      }

      if (!changedLocally) {
        width.value = stored
      }

      return width.value
    })()

    return initialization
  }

  async function persist(
    value: PosCartWidthPreference,
    service?: CartWidthPreferencesService
  ): Promise<boolean> {
    const request = ++latestRequest
    isSaving.value = true

    try {
      await resolveService(service).setPosCartWidth(value)

      if (request !== latestRequest) {
        // A newer write superseded this one while it was in flight.
        return false
      }

      persistenceFailed.value = false
      return true
    } catch {
      if (request !== latestRequest) {
        return false
      }

      // The width still applies for this session; it just may not survive a restart.
      persistenceFailed.value = true
      return false
    } finally {
      if (request === latestRequest) {
        isSaving.value = false
      }
    }
  }

  function cancelPendingPersist(): void {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer)
    }
    pendingTimer = null
    pendingPersist = null
  }

  /**
   * Applies a width immediately and schedules its persistence once it has been stable for
   * {@link CART_WIDTH_PERSIST_DEBOUNCE_MS}. Non-finite input is ignored.
   */
  function setWidth(px: number, service?: CartWidthPreferencesService): void {
    const next = normalizeCartWidth(px)

    if (next === null) {
      return
    }

    changedLocally = true

    if (next === width.value && pendingPersist === null) {
      return
    }

    width.value = next
    cancelPendingPersist()
    pendingPersist = { value: next, service }
    pendingTimer = setTimeout(() => {
      void flush()
    }, CART_WIDTH_PERSIST_DEBOUNCE_MS)
  }

  /** Writes a debounced width now (e.g. when a drag ends). Resolves `true` if nothing was pending. */
  async function flush(): Promise<boolean> {
    const pending = pendingPersist
    cancelPendingPersist()

    if (!pending) {
      return true
    }

    return persist(pending.value, pending.service)
  }

  /** Restores the design default and persists `null` straight away. */
  async function reset(service?: CartWidthPreferencesService): Promise<boolean> {
    changedLocally = true
    cancelPendingPersist()
    width.value = null
    return persist(null, service)
  }

  return { width, isSaving, persistenceFailed, initialize, setWidth, flush, reset }
})
