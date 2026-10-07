// @vitest-environment happy-dom

/**
 * The two cart/checkout behaviours the V3 redesign introduced, driven through the real POS page and
 * the real stores:
 *
 *  - **Clear cart is confirmed.** Cancelling the confirmation must leave every line in place; only
 *    confirming clears.
 *  - **"New sale" ends the sale, it does not undo it.** It acknowledges the committed attempt
 *    (the invoice stays committed and queued in main) and closes the payment panel. It never
 *    abandons the attempt, and acknowledging an unrelated recovery result never closes the panel
 *    the cashier is working in.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type {
  CatalogPaymentMethod,
  CatalogProduct,
  CatalogStatus
} from '@shared/contracts/catalog.contract'
import type { CheckoutCompletionOutcome } from '@shared/contracts/checkout.contract'
import type { IpcResult } from '@shared/contracts/ipc.contract'
import type { Shift } from '@shared/contracts/shift.contract'
import { i18n } from '@renderer/i18n'
import AppConfirmDialog from '@renderer/shared/components/common/AppConfirmDialog.vue'
import PaymentPanel from '@renderer/shared/components/pos/PaymentPanel.vue'
import CatalogRefreshPanel from '@renderer/shared/components/pos/CatalogRefreshPanel.vue'
import SaleRecoveryBanner from '@renderer/shared/components/pos/SaleRecoveryBanner.vue'
import ScanEntry from '@renderer/shared/components/pos/ScanEntry.vue'
import { useCartStore } from '../cart.store'
import { useCatalogStore } from '../catalog.store'
import { usePaymentStore } from '../payment.store'
import PosPage from './PosPage.vue'

const REVISION = 'b'.repeat(64)
const CATEGORY_UUID = '00000000-0000-4000-8000-000000000033'
const INVOICE_UUID = '00000000-0000-4000-8000-0000000000aa'

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

function product(n: number): CatalogProduct {
  return {
    uuid: `00000000-0000-4000-8000-00000000001${n}`,
    categoryUuid: CATEGORY_UUID,
    name: `Item ${n}`,
    sku: `ITEM-${n}`,
    barcode: null,
    description: null,
    unit: null,
    trackStock: false,
    availableQuantity: null,
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

const PRODUCTS = [product(1), product(2)]

const OPEN_SHIFT: Shift = {
  uuid: 'f2673d4c-4f96-410b-ac19-1ca81c21c9f8',
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

const CATALOG: CatalogStatus = {
  status: 'fresh',
  isReadable: true,
  catalogValid: true,
  lastSyncedAt: '2026-09-06T21:10:16.025Z',
  contract: CONTRACT
}

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

const ok = <T>(data: T): IpcResult<T> => ({ ok: true, data })

function installPosApi(): { abandonAttempt: ReturnType<typeof vi.fn> } {
  const abandonAttempt = vi.fn()
  ;(globalThis as unknown as { window: Window }).window.posApi = {
    shifts: {
      current: vi.fn(async () => ok(OPEN_SHIFT)),
      localAuthority: vi.fn(),
      get: vi.fn(),
      open: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      close: vi.fn()
    },
    catalog: {
      getStatus: vi.fn(async () => ok(CATALOG)),
      refresh: vi.fn(),
      listCategories: vi.fn(async () => ok([{ uuid: CATEGORY_UUID, name: 'General' }])),
      listPaymentMethods: vi.fn(async () => ok(PAYMENT_METHODS)),
      searchProducts: vi.fn(async () =>
        ok({ items: PRODUCTS, total: 2, limit: 24, offset: 0, contract: CONTRACT })
      ),
      getProduct: vi.fn(async (input: { uuid: string }) =>
        ok(PRODUCTS.find((item) => item.uuid === input.uuid))
      ),
      getProductForSale: vi.fn(async (input: { uuid: string }) =>
        ok({
          product: PRODUCTS.find((item) => item.uuid === input.uuid),
          revision: CONTRACT.revision,
          stock: { kind: 'untracked' }
        })
      ),
      onChanged: vi.fn(() => () => undefined),
      findProductByBarcode: vi.fn(async () => ok({ outcome: 'not-found' as const })),
      searchCustomers: vi.fn(async () => ok({ items: [], total: 0, limit: 24, offset: 0 })),
      getCustomer: vi.fn(async () => ok(null))
    },
    checkout: {
      validate: vi.fn(async () =>
        ok({ outcome: 'valid', calculation: null, snapshotRevision: REVISION })
      ),
      complete: vi.fn(),
      retryAttempt: vi.fn(),
      abandonAttempt,
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

  return { abandonAttempt }
}

type PosWrapper = ReturnType<typeof mount<typeof PosPage>>

async function renderPos(): Promise<{
  wrapper: PosWrapper
  abandonAttempt: ReturnType<typeof vi.fn>
}> {
  const { abandonAttempt } = installPosApi()
  i18n.global.locale.value = 'en'
  const wrapper = mount(PosPage, { global: { plugins: [createPinia(), i18n] } })
  await flushPromises()
  await flushPromises()

  return { wrapper, abandonAttempt }
}

async function addBothProducts(wrapper: PosWrapper): Promise<void> {
  for (const card of wrapper.findAllComponents({ name: 'ProductCard' })) {
    await card.vm.$emit('select')
  }
  await flushPromises()
}

function committed(
  outcome: 'committed' | 'acknowledged',
  attemptKey: string
): CheckoutCompletionOutcome {
  return {
    outcome,
    attemptKey,
    replay: false,
    invoice: {
      localUuid: INVOICE_UUID,
      attemptKey,
      offlineNumber: 'POS-000001',
      grandTotalAmount: 10_000
    } as never,
    items: [],
    payments: []
  }
}

describe('POS page V3 cart and checkout behaviour', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  /** POS workspace: Clear cart lives in the toolbar's More menu (still a labelled button). */
  async function openClearCart(
    wrapper: Awaited<ReturnType<typeof renderPos>>['wrapper']
  ): Promise<void> {
    await wrapper.get('.quick-actions [data-action="more"]').trigger('click')
    await flushPromises()
    const clear = wrapper.get('.quick-actions [data-action="clear"]')
    expect(clear.text()).toContain(String(i18n.global.t('pos.cart.clear')))
    await clear.trigger('click')
    await flushPromises()
  }

  it('clears the last scan line together with the cart it described', async () => {
    // Live finding: after a confirmed Clear the cart read "0 items" but the scan strip still said
    // "<code> Added to sale".
    const { wrapper } = await renderPos()
    await addBothProducts(wrapper)
    const scanEntry = wrapper.getComponent(ScanEntry)
    scanEntry.vm.$emit('update:modelValue', 'UNKNOWN-CODE')
    scanEntry.vm.$emit('submit', 'UNKNOWN-CODE')
    await flushPromises()
    expect(scanEntry.props('result')).not.toBeNull()

    await openClearCart(wrapper)
    wrapper.getComponent(AppConfirmDialog).vm.$emit('confirm')
    await flushPromises()

    expect(useCartStore().lines).toHaveLength(0)
    expect(scanEntry.props('result')).toBeNull()
  })

  it('asks for a rebuild only while the open cart is frozen on an older catalog', async () => {
    // Live finding: after a refresh that changed the revision, a NEW cart (which adopted the
    // installed contract) still showed "The refreshed catalog changed. Rebuild or clear…".
    const { wrapper } = await renderPos()
    useCatalogStore().lastRefreshRevisionChanged = true
    await addBothProducts(wrapper)
    const panel = wrapper.getComponent(CatalogRefreshPanel)
    expect(useCartStore().lines).toHaveLength(2)
    expect(panel.props('revisionChangedMessage')).toBeNull()

    useCartStore().setContract({ ...CONTRACT, revision: 'c'.repeat(64) })
    await flushPromises()
    expect(useCartStore().catalogChanged).toBe(true)
    expect(panel.props('revisionChangedMessage')).toBe(
      String(i18n.global.t('pos.catalogRefresh.revisionChanged'))
    )
  })

  it('keeps the cart when the clear confirmation is cancelled, and clears only on confirm', async () => {
    const { wrapper } = await renderPos()
    await addBothProducts(wrapper)
    const cart = useCartStore()
    expect(cart.lines).toHaveLength(2)

    await openClearCart(wrapper)

    const confirm = wrapper.getComponent(AppConfirmDialog)
    expect(confirm.props('open')).toBe(true)
    // The count label already carries its noun ("2 items"), so it is never doubled.
    expect(confirm.props('message')).toBe('2 items will be removed from this cart.')
    // Asking does not clear anything.
    expect(cart.lines).toHaveLength(2)

    confirm.vm.$emit('cancel')
    await flushPromises()
    expect(confirm.props('open')).toBe(false)
    expect(cart.lines.map((line) => line.product.uuid)).toEqual(PRODUCTS.map((item) => item.uuid))

    await openClearCart(wrapper)
    confirm.vm.$emit('confirm')
    await flushPromises()
    expect(confirm.props('open')).toBe(false)
    expect(cart.lines).toHaveLength(0)
  })

  it('"New sale" acknowledges the committed attempt and closes the panel without abandoning it', async () => {
    const { wrapper, abandonAttempt } = await renderPos()
    await addBothProducts(wrapper)

    await wrapper.get('.pos-page__future-action').trigger('click')
    await flushPromises()
    const panel = wrapper.getComponent(PaymentPanel)
    expect(panel.props('open')).toBe(true)

    // The sale committed (main has already cleared the cart through the commit callback).
    const payment = usePaymentStore()
    payment.attemptKey = 'attempt-1'
    payment.completionOutcome = committed('committed', 'attempt-1')
    useCartStore().clear()
    await flushPromises()
    expect(panel.props('completedTotal')).toBeDefined()

    const acknowledge = vi
      .spyOn(payment, 'acknowledgeAttempt')
      .mockResolvedValue(committed('acknowledged', 'attempt-1'))

    panel.vm.$emit('acknowledge')
    await flushPromises()

    expect(acknowledge).toHaveBeenCalledWith('attempt-1')
    expect(abandonAttempt).not.toHaveBeenCalled()
    expect(panel.props('open')).toBe(false)
  })

  it('a refused, never-claimed sale leaves the draft usable: dismiss, Clear (cancel), then exact cash pays it again', async () => {
    // Phase 4 closeout (lapsed subscription): main refused before claiming anything (`attemptKey: null`) and the
    // status re-check is unavailable. The draft must not stay locked, and Shift+F9 / Exact cash must submit again with
    // the one exact-cash row the refused press left — never silently do nothing, never add a second row.
    const { wrapper } = await renderPos()
    await addBothProducts(wrapper)
    const checkout = window.posApi.checkout as unknown as Record<string, ReturnType<typeof vi.fn>>
    checkout.attemptStatus.mockImplementation(async () => {
      throw new Error('status unavailable')
    })
    const submitted: { attemptKey: string; payments: number }[] = []
    checkout.complete.mockImplementation(
      async (input: { attemptKey: string; intent: { payments: unknown[] } }) => {
        submitted.push({ attemptKey: input.attemptKey, payments: input.intent.payments.length })
        return ok({ outcome: 'failed', code: 'access-denied', attemptKey: null })
      }
    )
    const payment = usePaymentStore()

    await wrapper.get('[data-testid="exact-cash"]').trigger('click')
    await flushPromises()
    expect(submitted).toHaveLength(1)
    expect(payment.attemptProtected).toBe(false)
    expect(payment.rows).toHaveLength(1)
    const panel = wrapper.getComponent(PaymentPanel)
    expect(panel.props('open')).toBe(true)

    // Dismissing the dialog drops the stale refusal (it is not state of the draft).
    panel.vm.$emit('close')
    await flushPromises()
    expect(payment.completionOutcome).toBeNull()

    // Clear cart opens its confirmation; Cancel keeps the draft and its tender.
    await openClearCart(wrapper)
    const confirm = wrapper.getComponent(AppConfirmDialog)
    expect(confirm.props('open')).toBe(true)
    confirm.vm.$emit('cancel')
    await flushPromises()
    expect(useCartStore().lines).toHaveLength(2)

    // Exact cash again: a new submission of the same draft with the same single row.
    const exactCash = wrapper.get('[data-testid="exact-cash"]')
    expect(exactCash.attributes('disabled')).toBeUndefined()
    await exactCash.trigger('click')
    await flushPromises()
    expect(submitted).toHaveLength(2)
    expect(submitted[1].payments).toBe(1)
    expect(submitted[1].attemptKey).not.toBe(submitted[0].attemptKey)
    expect(payment.rows).toHaveLength(1)
  })

  it('acknowledging an unrelated recovery result leaves the open payment panel alone', async () => {
    const { wrapper } = await renderPos()
    await addBothProducts(wrapper)

    await wrapper.get('.pos-page__future-action').trigger('click')
    await flushPromises()
    const panel = wrapper.getComponent(PaymentPanel)
    expect(panel.props('open')).toBe(true)

    const payment = usePaymentStore()
    const acknowledge = vi
      .spyOn(payment, 'acknowledgeAttempt')
      .mockResolvedValue(committed('acknowledged', 'older-attempt'))

    wrapper.getComponent(SaleRecoveryBanner).vm.$emit('acknowledge', 'older-attempt')
    await flushPromises()

    expect(acknowledge).toHaveBeenCalledWith('older-attempt')
    expect(panel.props('open')).toBe(true)
    expect(useCartStore().lines).toHaveLength(2)
  })
})
