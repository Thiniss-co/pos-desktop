// @vitest-environment happy-dom

/**
 * E1 regression — the real POS page, the real stores and services, and the real preload call
 * shapes, driven by the exact runtime values captured from the user's own profile while the
 * backend was unreachable:
 *
 *   shifts:current  → { ok: false, error: { category: 'transport',
 *                       message: 'The desktop service refused the connection', retryable: true } }
 *   shift_observation → kind 'shift', status 'open', owner-scoped, session_epoch 2
 *
 * Before the fix the store had no path to that durable observation, so a renderer that had never
 * held a server DTO (every app restart) fell to freshness 'error' and disabled the whole till while
 * the main process would still have admitted the sale.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type {
  CatalogCategory,
  CatalogPaymentMethod,
  CatalogProduct,
  CatalogStatus
} from '@shared/contracts/catalog.contract'
import type { PublicAppError } from '@shared/contracts/api.contract'
import type { ShiftLocalAuthority } from '@shared/contracts/shiftAuthority.contract'
import type { Shift } from '@shared/contracts/shift.contract'
import type { IpcResult } from '@shared/contracts/ipc.contract'
import { i18n } from '@renderer/i18n'
import { useShiftStore } from '../shift.store'
import { useCartStore } from '../cart.store'
import PosPage from './PosPage.vue'

const REVISION = 'a'.repeat(64)
const SHIFT_UUID = 'f2673d4c-4f96-410b-ac19-1ca81c21c9f8'
const SERVICE_PRODUCT_UUID = '00000000-0000-4000-8000-0000000000s1'.replace('s1', '11')
const TRACKED_PRODUCT_UUID = '00000000-0000-4000-8000-000000000022'
const CATEGORY_UUID = '00000000-0000-4000-8000-000000000033'

/** The exact envelope `handleIpcRequest` produced for `shifts:current` with the API stopped. */
const REFUSED_CONNECTION: PublicAppError = {
  category: 'transport',
  message: 'The desktop service refused the connection',
  retryable: true
}

/** The exact verdict `ShiftAuthorityService.resolveForSell()` returned from the same profile. */
const OPEN_AUTHORITY: ShiftLocalAuthority = {
  kind: 'open',
  shiftUuid: SHIFT_UUID,
  observedAt: '2026-09-06T21:25:53.314Z'
}

/** The real successful `shifts:current` DTO the same device received while Laravel was up. */
const OPEN_SHIFT: Shift = {
  uuid: SHIFT_UUID,
  status: 'open',
  openingCashAmount: 20_000,
  expectedCashAmount: 20_000,
  actualCashAmount: null,
  cashDifferenceAmount: null,
  openedAt: '2026-09-06T21:11:46+00:00',
  closedAt: null,
  pausedAt: null,
  pauseCount: 0,
  totalPausedSeconds: 0,
  activePause: null,
  notes: null,
  closeNotes: null
}

const CONTRACT = {
  revision: REVISION,
  generatedAt: '2026-09-06T21:10:00.000Z',
  validUntil: '2099-01-01T00:00:00.000Z',
  currency: 'EGP',
  currencyExponent: 2,
  quantityScale: 3,
  minimumQuantity: '0.001',
  maximumQuantity: '999999.999',
  maximumUnitPrice: 1_000_000_000,
  maximumLineTotal: 900_000_000_000_000,
  maximumInvoiceTotal: 900_000_000_000_000,
  mixedTaxModePolicy: 'single_invoice_mode'
} as const

function product(uuid: string, name: string, trackStock: boolean): CatalogProduct {
  return {
    uuid,
    categoryUuid: CATEGORY_UUID,
    name,
    sku: name,
    barcode: null,
    description: null,
    unit: null,
    trackStock,
    // A service item carries no stock at all; the tracked item has an allocation behind it.
    availableQuantity: trackStock ? '5.000' : null,
    price: {
      amount: 5_000,
      currency: 'EGP',
      source: 'product_base',
      revision: REVISION,
      validFrom: '2026-09-06T21:10:00.000Z',
      validUntil: '2099-01-01T00:00:00.000Z'
    },
    tax: { id: null, mode: 'none', rateBasisPoints: 0, revision: REVISION }
  }
}

const SERVICE_ITEM = product(SERVICE_PRODUCT_UUID, 'Service Item', false)
const TRACKED_ITEM = product(TRACKED_PRODUCT_UUID, 'Tracked Item', true)

const CATEGORIES: CatalogCategory[] = [{ uuid: CATEGORY_UUID, name: 'General' }]
const PAYMENT_METHODS: CatalogPaymentMethod[] = [
  {
    uuid: '00000000-0000-4000-8000-000000000044',
    name: 'Cash',
    code: 'cash',
    type: 'cash',
    isActive: true,
    allowsChange: true,
    requiresReference: false,
    sortOrder: 1
  }
]

/** Catalog cached and valid — exactly what the screenshot showed alongside the disabled till. */
const CACHED_CATALOG: CatalogStatus = {
  status: 'cached',
  isReadable: true,
  catalogValid: true,
  lastSyncedAt: '2026-09-06T21:10:16.025Z',
  contract: CONTRACT
}

const ok = <T>(data: T): IpcResult<T> => ({ ok: true, data })
const failed = <T>(error: PublicAppError): IpcResult<T> => ({ ok: false, error })

interface Harness {
  readonly shiftsCurrent: ReturnType<typeof vi.fn>
  readonly shiftsLocalAuthority: ReturnType<typeof vi.fn>
  readonly checkoutComplete: ReturnType<typeof vi.fn>
  readonly checkoutValidate: ReturnType<typeof vi.fn>
}

function installPosApi(harness: Harness): void {
  const catalog = {
    getStatus: vi.fn(async () => ok(CACHED_CATALOG)),
    refresh: vi.fn(async () => failed(REFUSED_CONNECTION)),
    listCategories: vi.fn(async () => ok(CATEGORIES)),
    listPaymentMethods: vi.fn(async () => ok(PAYMENT_METHODS)),
    searchProducts: vi.fn(async () =>
      ok({
        items: [SERVICE_ITEM, TRACKED_ITEM],
        total: 2,
        page: 1,
        pageSize: 24,
        contract: CONTRACT
      })
    ),
    getProduct: vi.fn(async (input: { uuid: string }) =>
      ok(input.uuid === SERVICE_PRODUCT_UUID ? SERVICE_ITEM : TRACKED_ITEM)
    ),
    getProductForSale: vi.fn(async (input: { uuid: string }) =>
      ok({
        product: input.uuid === SERVICE_PRODUCT_UUID ? SERVICE_ITEM : TRACKED_ITEM,
        revision: CONTRACT.revision,
        stock: { kind: 'untracked' }
      })
    ),
    onChanged: vi.fn(() => () => undefined),
    findProductByBarcode: vi.fn(async () => ok({ outcome: 'not-found' as const })),
    searchCustomers: vi.fn(async () => ok({ items: [], total: 0, page: 1, pageSize: 24 })),
    getCustomer: vi.fn(async () => ok(null))
  }

  ;(globalThis as unknown as { window: Window }).window.posApi = {
    shifts: {
      current: harness.shiftsCurrent,
      localAuthority: harness.shiftsLocalAuthority,
      get: vi.fn(),
      open: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      close: vi.fn()
    },
    catalog,
    checkout: {
      validate: harness.checkoutValidate,
      complete: harness.checkoutComplete,
      retryAttempt: vi.fn(),
      abandonAttempt: vi.fn(),
      acknowledgeAttempt: vi.fn(),
      pendingAttempts: vi.fn(async () =>
        ok({ blockingAttempt: null, unacknowledgedResults: [], nextCursor: null })
      ),
      attemptStatus: vi.fn(async (input: { attemptKey: string }) =>
        ok({ attemptKey: input.attemptKey, state: 'unknown', failureCode: null })
      )
    },
    sync: {
      getStatus: vi.fn(async () =>
        ok({
          state: 'idle',
          pausedReason: null,
          counts: { pending: 0, uploading: 0, retryableError: 0, conflict: 0, rejected: 0 }
        })
      ),
      uploadNow: vi.fn(),
      listFailures: vi.fn(async () => ok({ items: [], nextCursor: null })),
      onChanged: vi.fn(() => () => undefined)
    }
  } as unknown as Window['posApi']
}

function harness(overrides: Partial<Harness> = {}): Harness {
  return {
    shiftsCurrent: vi.fn(async () => failed(REFUSED_CONNECTION)),
    shiftsLocalAuthority: vi.fn(async () => ok(OPEN_AUTHORITY)),
    checkoutValidate: vi.fn(async () =>
      ok({ outcome: 'valid', calculation: null, snapshotRevision: REVISION })
    ),
    checkoutComplete: vi.fn(),
    ...overrides
  }
}

type PosWrapper = ReturnType<typeof mount<typeof PosPage>>

async function renderPos(bus: Harness): Promise<PosWrapper> {
  installPosApi(bus)
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(PosPage, { global: { plugins: [pinia, i18n] } })
  await flushPromises()
  await flushPromises()
  return wrapper
}

/** The real rendered bindings — not store internals. */
interface TillState {
  readonly checkoutLabel: string | null
  readonly checkoutDisabled: boolean
  readonly productsDisabled: readonly boolean[]
  readonly showsShiftUnavailableChip: boolean
  readonly showsRefreshUnavailableNote: boolean
  readonly showsOpenShiftGuard: boolean
}

function tillState(wrapper: PosWrapper): TillState {
  const html = wrapper.html()
  const checkout = wrapper
    .findAll('button')
    .find((button) => button.classes('pos-page__future-action'))

  return {
    checkoutLabel: checkout?.text() ?? null,
    checkoutDisabled: checkout?.attributes('disabled') !== undefined,
    productsDisabled: wrapper
      .findAllComponents({ name: 'ProductCard' })
      .map((card) => card.props('disabled') as boolean),
    showsShiftUnavailableChip: html.includes('Shift status is unavailable.'),
    showsRefreshUnavailableNote: html.includes('The shift could not be refreshed.'),
    showsOpenShiftGuard: html.includes('Open an active shift to add products.')
  }
}

describe('POS page after the backend becomes unreachable', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('keeps selling on the durable local open-shift authority when no server DTO was ever held', async () => {
    const bus = harness()
    const wrapper = await renderPos(bus)
    const state = tillState(wrapper)

    // The renderer asked the main process for its durable verdict rather than concluding "no shift"
    // from a refused connection.
    expect(bus.shiftsLocalAuthority).toHaveBeenCalledTimes(1)

    const shift = useShiftStore()
    expect(shift.freshness).toBe('cached')
    expect(shift.canSell).toBe(true)
    expect(shift.activeShiftUuid).toBe(SHIFT_UUID)

    expect(state.showsShiftUnavailableChip).toBe(false)
    expect(state.showsOpenShiftGuard).toBe(false)
    expect(state.showsRefreshUnavailableNote).toBe(true)
    expect(state.productsDisabled).toEqual([false, false])
    expect(state.checkoutLabel).not.toBe('Open an active shift to continue')
  })

  it('accepts an eligible service item and an allocated tracked item, and reaches checkout', async () => {
    const bus = harness()
    const wrapper = await renderPos(bus)
    const cards = wrapper.findAllComponents({ name: 'ProductCard' })

    // The real click path: ProductCard @select → addSelectedProduct → catalog.getProduct → cart.
    await cards[0].vm.$emit('select')
    await cards[1].vm.$emit('select')
    await flushPromises()

    const cart = useCartStore()
    expect(cart.lines.map((line) => line.product.uuid)).toEqual([
      SERVICE_PRODUCT_UUID,
      TRACKED_PRODUCT_UUID
    ])
    // Service-item eligibility never consults a stock allocation.
    expect(cart.lines[0].product.trackStock).toBe(false)
    expect(cart.cartState.kind).toBe('valid')

    await wrapper.vm.$nextTick()
    const state = tillState(wrapper)
    expect(state.checkoutDisabled).toBe(false)
    // V3: the ready checkout control names the amount it will take ("Pay …"), not a generic verb.
    expect(state.checkoutLabel).toBe('Pay EGP\u00a0100.00')
  })

  it('denies the till when local authority reports no open shift', async () => {
    const bus = harness({
      shiftsLocalAuthority: vi.fn(async () =>
        ok({ kind: 'none', observedAt: '2026-09-06T21:25:53.314Z' })
      )
    })
    const wrapper = await renderPos(bus)
    const state = tillState(wrapper)

    expect(useShiftStore().canSell).toBe(false)
    expect(state.showsShiftUnavailableChip).toBe(true)
    expect(state.productsDisabled).toEqual([true, true])
    expect(state.checkoutLabel).toBe('Open an active shift to continue')
  })

  it.each([
    ['paused', { kind: 'not-open', status: 'paused' }],
    ['closed', { kind: 'not-open', status: 'closed' }],
    [
      'reconciliation-required',
      { kind: 'reconciliation-required', since: '2026-09-06T21:25:53.314Z' }
    ],
    ['unknown', { kind: 'unknown' }],
    ['a foreign owner/session', { kind: 'foreign' }]
  ])('denies the till for %s local authority', async (_label, authority) => {
    const bus = harness({
      shiftsLocalAuthority: vi.fn(async () => ok(authority as ShiftLocalAuthority))
    })
    const wrapper = await renderPos(bus)

    expect(useShiftStore().canSell).toBe(false)
    expect(tillState(wrapper).productsDisabled).toEqual([true, true])
  })

  it('denies the till when the local authority read itself is refused', async () => {
    const bus = harness({
      shiftsLocalAuthority: vi.fn(async () =>
        failed({
          category: 'authorization',
          message: 'Your account does not have the shifts.view permission.',
          backendCode: 'PERMISSION_DENIED',
          retryable: false
        })
      )
    })
    const wrapper = await renderPos(bus)

    expect(useShiftStore().freshness).toBe('error')
    expect(useShiftStore().canSell).toBe(false)
    expect(tillState(wrapper).productsDisabled).toEqual([true, true])
  })

  it('never consults local authority for a non-transport failure', async () => {
    const bus = harness({
      shiftsCurrent: vi.fn(async () =>
        failed({
          category: 'authorization',
          message: 'Access is not allowed',
          backendCode: 'DESKTOP_ACCESS_FORBIDDEN',
          retryable: false
        })
      )
    })
    const wrapper = await renderPos(bus)

    expect(bus.shiftsLocalAuthority).not.toHaveBeenCalled()
    expect(useShiftStore().freshness).toBe('error')
    expect(tillState(wrapper).productsDisabled).toEqual([true, true])
  })

  it('replaces the hydrated authority with the server answer on reconnect, keeping the same shift', async () => {
    const bus = harness()
    const wrapper = await renderPos(bus)
    const shift = useShiftStore()
    expect(shift.freshness).toBe('cached')

    const cards = wrapper.findAllComponents({ name: 'ProductCard' })
    await cards[0].vm.$emit('select')
    await flushPromises()
    expect(useCartStore().lines).toHaveLength(1)

    bus.shiftsCurrent.mockResolvedValueOnce(ok(OPEN_SHIFT))
    await shift.loadCurrent()
    await flushPromises()

    expect(shift.freshness).toBe('current')
    expect(shift.localAuthority).toBeNull()
    expect(shift.currentShift?.uuid).toBe(SHIFT_UUID)
    expect(shift.activeShiftUuid).toBe(SHIFT_UUID)
    // The shift identity did not change, so the offline draft is not discarded on reconnect.
    expect(useCartStore().lines).toHaveLength(1)
    expect(tillState(wrapper).showsRefreshUnavailableNote).toBe(false)
  })

  it('refuses a lifecycle change while running on local authority', async () => {
    const bus = harness()
    await renderPos(bus)
    const shift = useShiftStore()

    expect(await shift.pause({ uuid: SHIFT_UUID, reason: null, notes: null })).toBe(false)
    expect(window.posApi.shifts.pause).not.toHaveBeenCalled()
  })
})

describe('POS quick-sale column', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  async function renderWithBarcode(): Promise<PosWrapper> {
    const bus = harness()
    const wrapper = await renderPos(bus)
    window.posApi.catalog.findProductByBarcode = vi.fn(async () =>
      ok({ outcome: 'found' as const, product: SERVICE_ITEM })
    ) as unknown as Window['posApi']['catalog']['findProductByBarcode']
    return wrapper
  }

  async function scan(wrapper: PosWrapper, text: string): Promise<void> {
    const entry = wrapper.findComponent({ name: 'ScanEntry' })
    await entry.find('input').setValue(text)
    await entry.find('form').trigger('submit')
    await flushPromises()
  }

  function quickAction(wrapper: PosWrapper, id: string): ReturnType<PosWrapper['find']> {
    return wrapper.find(`.quick-actions__tile[data-action="${id}"]`)
  }

  it('adds a scanned code with a typed quantity straight to the cart', async () => {
    const wrapper = await renderWithBarcode()
    await scan(wrapper, '3*SVC-1')

    const cart = useCartStore()
    expect(cart.lines).toHaveLength(1)
    expect(cart.lines[0].quantity).toBe('3.000')
    expect(wrapper.find('.scan-entry__result--success').text()).toContain('Service Item')
    // The field clears itself for the next scan.
    expect((wrapper.find('#scan-entry-input').element as HTMLInputElement).value).toBe('')
  })

  it('holds the sale, frees the till, and recalls it from the held list', async () => {
    const wrapper = await renderWithBarcode()
    await scan(wrapper, 'SVC-1')

    await quickAction(wrapper, 'hold').trigger('click')
    const cart = useCartStore()
    expect(cart.lines).toHaveLength(0)
    expect(cart.heldDrafts).toHaveLength(1)
    expect(quickAction(wrapper, 'recall').text()).toContain('1')

    await quickAction(wrapper, 'recall').trigger('click')
    await flushPromises()
    const list = wrapper.findComponent({ name: 'HeldSalesList' })
    expect(list.exists()).toBe(true)
    list.vm.$emit('recall', cart.heldDrafts[0].id)
    await flushPromises()

    expect(cart.heldDrafts).toHaveLength(0)
    expect(cart.lines.map((line) => line.product.uuid)).toEqual([SERVICE_PRODUCT_UUID])
  })

  it('opens payment as a focused modal dialog (rev 3), with quick cash and exact-cash actions', async () => {
    const wrapper = await renderWithBarcode()
    await scan(wrapper, 'SVC-1')

    await wrapper.find('.pos-page__future-action').trigger('click')
    await flushPromises()

    // The dialog is teleported to <body>: the cart column holds no tender form any more.
    expect(wrapper.find('.pos-page__cart-spine .payment-panel').exists()).toBe(false)
    const dialog = document.querySelector('[aria-modal="true"]')
    expect(dialog).not.toBeNull()
    const tenders = document.querySelectorAll<HTMLButtonElement>('.payment-panel__quick-tender')
    expect(tenders.length).toBeGreaterThan(0)
    // One eligible cash method with no reference: the explicit "Complete · Exact cash" action.
    expect(document.querySelector('[data-commit-action="exact-cash"]')).not.toBeNull()
    expect(dialog?.querySelector('form')).toBeNull()

    tenders[0].click()
    await flushPromises()
    expect(document.querySelectorAll('.payment-panel__row')).toHaveLength(1)
    wrapper.unmount()
  })
})
