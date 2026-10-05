import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { CatalogContract, CatalogProduct } from '@shared/contracts/catalog.contract'
import {
  addQuantity,
  calculateCart,
  formatQuantity,
  type CartCalculation,
  type CartCalculationErrorCode,
  type DiscountType
} from '@shared/pos/posCalculator'
import { applyOffers, type AppliedOffer } from '@shared/pos/offerRule'
import { i18n } from '@renderer/i18n'

export interface CartLineSnapshot {
  readonly id: string
  readonly mergeKey: string
  readonly catalogRevision: string
  readonly product: CatalogProduct
  readonly quantity: string
  readonly discountType: DiscountType
  readonly discountValue: number
}

/**
 * A parked (held) draft. In-memory only, like the live draft itself: it is never a sale, never
 * persisted, and is discarded by `resetDraft` (logout, session end, device recovery, shift change)
 * exactly as the live draft is. Line snapshots stay frozen; recalling a draft held under an older
 * catalog revision surfaces the existing rebuild-or-clear resolution instead of repricing it.
 */
export interface HeldDraft {
  readonly id: string
  readonly heldAt: string
  readonly lines: readonly CartLineSnapshot[]
  readonly invoiceDiscountType: DiscountType
  readonly invoiceDiscountValue: number
  readonly customerUuid: string | null
  readonly customerName: string | null
  readonly itemCount: number
  readonly grandTotalAmount: number | null
}

export const MAX_HELD_DRAFTS = 20

export type CartErrorCode = CartCalculationErrorCode | 'CART_HOLD_LIMIT' | 'CART_ATTEMPT_LOCKED'

export type CartState =
  | { readonly kind: 'empty' }
  | { readonly kind: 'valid'; readonly totals: CartCalculation }
  | {
      readonly kind: 'invalid'
      readonly code: CartCalculationErrorCode
      readonly lastValid?: CartCalculation
    }

function mergeKey(product: CatalogProduct, catalogRevision: string): string {
  return [
    catalogRevision,
    product.uuid,
    product.price.currency,
    product.price.amount,
    product.price.revision,
    product.tax.id ?? '',
    product.tax.mode,
    product.tax.rateBasisPoints,
    product.tax.revision
  ].join('|')
}

function immutableProductSnapshot(product: CatalogProduct): CatalogProduct {
  // P8: a product image is display-only and never part of a cart line (or anything sent to checkout).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { image: _image, ...rest } = product
  return Object.freeze({
    ...rest,
    price: Object.freeze({ ...product.price }),
    tax: Object.freeze({ ...product.tax })
  })
}

export const useCartStore = defineStore('cart', () => {
  const lines = ref<CartLineSnapshot[]>([])
  const contract = ref<CatalogContract | null>(null)
  const cartState = ref<CartState>({ kind: 'empty' })
  const invoiceDiscountType = ref<DiscountType>(null)
  const invoiceDiscountValue = ref(0)
  const catalogValid = ref(false)
  const catalogChanged = ref(false)
  const contextGeneration = ref(0)
  const draftRevision = ref(0)
  const catalogGeneration = ref(0)
  const lastValid = ref<CartCalculation | null>(null)
  const rejectionCode = ref<CartErrorCode | null>(null)
  const heldDrafts = ref<HeldDraft[]>([])
  /**
   * POS reliability rev 3: the identity of the current sale draft. Re-minted whenever the draft is
   * replaced (clear — including removing the last line and the post-commit clear —, recall, reset),
   * so editable tender state can be bound to exactly one draft.
   */
  const saleId = ref<string>(crypto.randomUUID())
  /**
   * True while a protected payment attempt (in flight, claimed, uncertain, or committed but not yet
   * acknowledged) is bound to this draft. Every draft mutation is refused meanwhile, so the cart on
   * screen can never diverge from the frozen intent main holds for that attempt.
   */
  const locked = ref(false)
  /**
   * Owner expansion Phase E: the offer each line is shown with, evaluated from the installed
   * contract's offers whenever the cart is (re)calculated. Main re-evaluates them on preview and at
   * the sale instant; the intent only names what was shown here.
   */
  const appliedOffers = ref<ReadonlyMap<string, AppliedOffer>>(new Map())
  let candidateOffers: ReadonlyMap<string, AppliedOffer> = new Map()

  const error = computed(() =>
    rejectionCode.value ? String(i18n.global.t(`pos.errors.${rejectionCode.value}`)) : null
  )
  const calculation = computed(() => {
    if (cartState.value.kind === 'valid') {
      return cartState.value.totals
    }

    return cartState.value.kind === 'invalid' ? (cartState.value.lastValid ?? null) : null
  })
  const canEdit = computed(
    () => contract.value !== null && catalogValid.value && catalogChanged.value === false
  )

  function setLocked(value: boolean): void {
    locked.value = value
  }

  function lockedRejection(): boolean {
    if (locked.value) {
      reject('CART_ATTEMPT_LOCKED')
      return true
    }
    return false
  }

  function reject(code: CartErrorCode): false {
    rejectionCode.value = code
    return false
  }

  function markInvalid(code: CartCalculationErrorCode): void {
    cartState.value = {
      kind: 'invalid',
      code,
      ...(lastValid.value ? { lastValid: lastValid.value } : {})
    }
    rejectionCode.value = code
  }

  function candidate(
    nextLines: readonly CartLineSnapshot[],
    nextInvoiceDiscountType = invoiceDiscountType.value,
    nextInvoiceDiscountValue = invoiceDiscountValue.value
  ): CartState {
    if (!contract.value) {
      return { kind: 'invalid', code: 'CART_CATALOG_REQUIRED' }
    }

    if (nextLines.length === 0) {
      return { kind: 'empty' }
    }

    candidateOffers = applyOffers(
      nextLines.map((line) => ({
        id: line.id,
        productUuid: line.product.uuid,
        quantity: line.quantity,
        unitPriceAmount: line.product.price.amount,
        discountType: line.discountType,
        discountValue: line.discountValue
      })),
      contract.value.offers,
      new Date()
    )
    const result = calculateCart(
      nextLines.map((line) => ({
        id: line.id,
        productUuid: line.product.uuid,
        quantity: line.quantity,
        unitPriceAmount: line.product.price.amount,
        currency: line.product.price.currency,
        discountType: candidateOffers.get(line.id)?.discountType ?? line.discountType,
        discountValue: candidateOffers.get(line.id)?.discountValue ?? line.discountValue,
        taxMode: line.product.tax.mode,
        taxRateBasisPoints: line.product.tax.rateBasisPoints
      })),
      contract.value,
      nextInvoiceDiscountType,
      nextInvoiceDiscountValue
    )

    return result.ok
      ? { kind: 'valid', totals: result.value }
      : { kind: 'invalid', code: result.code }
  }

  function commit(
    nextLines: CartLineSnapshot[],
    nextInvoiceDiscountType = invoiceDiscountType.value,
    nextInvoiceDiscountValue = invoiceDiscountValue.value
  ): boolean {
    const next = candidate(nextLines, nextInvoiceDiscountType, nextInvoiceDiscountValue)

    if (next.kind === 'invalid') {
      return reject(next.code)
    }

    lines.value = nextLines
    invoiceDiscountType.value = nextInvoiceDiscountType
    invoiceDiscountValue.value = nextInvoiceDiscountValue
    cartState.value = next
    appliedOffers.value = next.kind === 'valid' ? candidateOffers : new Map()
    if (next.kind === 'valid') {
      lastValid.value = next.totals
    }
    rejectionCode.value = null
    draftRevision.value += 1
    return true
  }

  function setContract(nextContract: CatalogContract): void {
    const revisionChanged =
      contract.value?.revision !== undefined && contract.value.revision !== nextContract.revision
    contract.value = nextContract
    catalogValid.value = true

    if (revisionChanged) {
      catalogGeneration.value += 1
    }

    // A line frozen under another revision keeps the draft flagged however often the same contract
    // is re-applied (Rev 4 §13 H2: the refresh may happen on another page, and returning to the POS
    // page re-applies the contract it already holds — that must never un-flag the draft).
    const frozenUnderOther = lines.value.some(
      (line) => line.catalogRevision !== nextContract.revision
    )
    if ((revisionChanged || frozenUnderOther) && lines.value.length > 0) {
      // Frozen snapshots remain visible until the cashier explicitly clears, removes, or rebuilds.
      // Repricing a draft on catalog refresh would silently change a commercial transaction.
      catalogChanged.value = true
      markInvalid('CART_CATALOG_CHANGED')
      return
    }

    catalogChanged.value = false
    if (lines.value.length === 0) {
      cartState.value = { kind: 'empty' }
      rejectionCode.value = null
      return
    }

    const evaluated = candidate(lines.value)
    if (evaluated.kind === 'valid') {
      cartState.value = evaluated
      appliedOffers.value = candidateOffers
      lastValid.value = evaluated.totals
      rejectionCode.value = null
    } else if (evaluated.kind === 'invalid') {
      markInvalid(evaluated.code)
    }
  }

  /**
   * Catalog reads remain available while stale, but commercial draft mutations do not. This is
   * deliberately distinct from a revision change: stale drafts may still be removed or cleared.
   */
  function setCatalogValidity(isValid: boolean): void {
    catalogValid.value = isValid
  }

  function addProduct(
    product: CatalogProduct,
    quantityMilli = 1000,
    readUnderRevision?: string
  ): boolean {
    if (lockedRejection()) {
      return false
    }
    if (!contract.value || !catalogValid.value) {
      return reject('CART_CATALOG_REQUIRED')
    }
    if (catalogChanged.value) {
      return reject('CART_CATALOG_CHANGED')
    }
    // Rev 3: a product read under a different catalog install than this draft's contract is never
    // stamped with this contract's revision (no mixed snapshots).
    if (readUnderRevision !== undefined && readUnderRevision !== contract.value.revision) {
      return reject('CART_CATALOG_CHANGED')
    }
    if (product.price.currency !== contract.value.currency) {
      return reject('CART_MIXED_CURRENCY')
    }

    if (!Number.isSafeInteger(quantityMilli) || quantityMilli <= 0) {
      return reject('CART_QUANTITY_INVALID')
    }

    const key = mergeKey(product, contract.value.revision)
    const existing = lines.value.find((line) => line.mergeKey === key)

    if (existing) {
      const nextQuantity = addQuantity(existing.quantity, quantityMilli, contract.value)
      if (!nextQuantity.ok) {
        return reject(nextQuantity.code)
      }

      return commit(
        lines.value.map((line) =>
          line.id === existing.id ? { ...line, quantity: nextQuantity.value } : line
        )
      )
    }

    const initialQuantity = formatQuantity(quantityMilli)
    if (!initialQuantity.ok) {
      return reject(initialQuantity.code)
    }

    return commit([
      ...lines.value,
      {
        id: crypto.randomUUID(),
        mergeKey: key,
        catalogRevision: contract.value.revision,
        product: immutableProductSnapshot(product),
        quantity: initialQuantity.value,
        discountType: null,
        discountValue: 0
      }
    ])
  }

  function changeQuantity(id: string, deltaMilli: number): boolean {
    if (lockedRejection()) {
      return false
    }
    if (!contract.value || !catalogValid.value) {
      return reject('CART_CATALOG_REQUIRED')
    }
    if (catalogChanged.value) {
      return reject('CART_CATALOG_CHANGED')
    }

    const current = lines.value.find((line) => line.id === id)
    if (!current) {
      return reject('CART_INVALID')
    }

    const nextQuantity = addQuantity(current.quantity, deltaMilli, contract.value)
    if (!nextQuantity.ok) {
      return reject(nextQuantity.code)
    }

    return commit(
      lines.value.map((line) => (line.id === id ? { ...line, quantity: nextQuantity.value } : line))
    )
  }

  function incrementQuantity(id: string): boolean {
    return changeQuantity(id, 1000)
  }

  function decrementQuantity(id: string): boolean {
    return changeQuantity(id, -1000)
  }

  function setQuantity(id: string, quantity: string): boolean {
    if (lockedRejection()) {
      return false
    }
    if (!contract.value || !catalogValid.value) {
      return reject('CART_CATALOG_REQUIRED')
    }
    if (catalogChanged.value) {
      return reject('CART_CATALOG_CHANGED')
    }
    if (!lines.value.some((line) => line.id === id)) {
      return reject('CART_INVALID')
    }

    return commit(lines.value.map((line) => (line.id === id ? { ...line, quantity } : line)))
  }

  function setLineDiscount(id: string, type: DiscountType, value: number): boolean {
    if (lockedRejection()) {
      return false
    }
    if (!canEdit.value) {
      return reject(catalogChanged.value ? 'CART_CATALOG_CHANGED' : 'CART_CATALOG_REQUIRED')
    }

    if (!Number.isSafeInteger(value) || value < 0) {
      return reject('CART_DISCOUNT_INVALID')
    }

    return commit(
      lines.value.map((line) =>
        line.id === id ? { ...line, discountType: type, discountValue: value } : line
      )
    )
  }

  function setInvoiceDiscount(type: DiscountType, value: number): boolean {
    if (lockedRejection()) {
      return false
    }
    if (!canEdit.value) {
      return reject(catalogChanged.value ? 'CART_CATALOG_CHANGED' : 'CART_CATALOG_REQUIRED')
    }

    if (!Number.isSafeInteger(value) || value < 0) {
      return reject('CART_DISCOUNT_INVALID')
    }

    return commit([...lines.value], type, value)
  }

  function remove(id: string): boolean {
    if (lockedRejection()) {
      return false
    }
    const nextLines = lines.value.filter((line) => line.id !== id)
    if (nextLines.length === lines.value.length) {
      return false
    }

    if (nextLines.length === 0) {
      clear()
      return true
    }

    if (catalogChanged.value) {
      // Do not calculate old snapshots against the new contract. The draft stays blocked until
      // the cashier has explicitly rebuilt it, even after removing an obsolete line.
      lines.value = nextLines
      if (nextLines.length === 0) {
        clear()
      } else {
        markInvalid('CART_CATALOG_CHANGED')
        draftRevision.value += 1
      }
      return true
    }

    // Candidate validation leaves an invalid fixed-discount draft untouched for explicit
    // resolution through the line or invoice discount actions.
    return commit(nextLines)
  }

  function clear(): void {
    lines.value = []
    invoiceDiscountType.value = null
    invoiceDiscountValue.value = 0
    catalogChanged.value = false
    lastValid.value = null
    cartState.value = { kind: 'empty' }
    appliedOffers.value = new Map()
    rejectionCode.value = null
    draftRevision.value += 1
    saleId.value = crypto.randomUUID()
  }

  /** Phase E: the offer a line is currently shown with, if any. */
  function offerFor(lineId: string): AppliedOffer | null {
    return appliedOffers.value.get(lineId) ?? null
  }

  /**
   * Phase E: re-evaluates the offers now (main reported that its own evaluation differs, e.g. an
   * offer window opened or closed while the cart sat). Recalculates — and so starts a new draft
   * revision — only when the shown offers actually change, so a disagreement it cannot resolve is
   * left visible instead of looping.
   */
  function repriceOffers(): boolean {
    if (locked.value || lines.value.length === 0 || catalogChanged.value || !contract.value) {
      return false
    }
    const before = appliedOffers.value
    const next = candidate(lines.value)
    const same =
      next.kind === 'valid' &&
      before.size === candidateOffers.size &&
      [...candidateOffers].every(
        ([lineId, offer]) => before.get(lineId)?.revisionUuid === offer.revisionUuid
      )
    return same ? false : commit([...lines.value])
  }

  /** Reset transient draft state on logout, session revocation, device recovery, or shift/company change. */
  function resetDraft(reason?: string): void {
    void reason
    contextGeneration.value += 1
    heldDrafts.value = []
    locked.value = false
    clear()
  }

  /**
   * Parks the live draft so the cashier can serve the next customer. The draft is moved, never
   * copied: the live cart is cleared afterwards. Returns the held draft, or `null` when there is
   * nothing to hold or the held list is full.
   */
  function holdDraft(
    customer: { readonly uuid: string; readonly name: string | null } | null = null
  ): HeldDraft | null {
    if (lines.value.length === 0 || lockedRejection()) {
      return null
    }
    if (heldDrafts.value.length >= MAX_HELD_DRAFTS) {
      reject('CART_HOLD_LIMIT')
      return null
    }

    const held: HeldDraft = Object.freeze({
      id: crypto.randomUUID(),
      heldAt: new Date().toISOString(),
      lines: Object.freeze([...lines.value]),
      invoiceDiscountType: invoiceDiscountType.value,
      invoiceDiscountValue: invoiceDiscountValue.value,
      customerUuid: customer?.uuid ?? null,
      customerName: customer?.name ?? null,
      itemCount: lines.value.length,
      grandTotalAmount: calculation.value?.grandTotalAmount ?? null
    })

    heldDrafts.value = [...heldDrafts.value, held]
    clear()
    return held
  }

  /**
   * Restores a held draft into the (empty) live cart and removes it from the held list. The caller
   * must hold or clear a non-empty live draft first — recall never merges two drafts. A draft held
   * under another catalog revision comes back blocked with `CART_CATALOG_CHANGED`, so the cashier
   * gets the usual explicit rebuild-or-clear choice instead of a silent reprice.
   */
  function recallDraft(id: string): HeldDraft | null {
    const held = heldDrafts.value.find((candidate) => candidate.id === id)
    if (!held || lines.value.length > 0 || lockedRejection()) {
      return null
    }
    // A recalled draft is a different sale: it never inherits the previous draft's tender state.
    saleId.value = crypto.randomUUID()

    const restoredLines = [...held.lines]
    const revision = contract.value?.revision
    const outdated =
      revision === undefined || restoredLines.some((line) => line.catalogRevision !== revision)

    if (outdated) {
      lines.value = restoredLines
      invoiceDiscountType.value = held.invoiceDiscountType
      invoiceDiscountValue.value = held.invoiceDiscountValue
      lastValid.value = null
      catalogChanged.value = true
      markInvalid('CART_CATALOG_CHANGED')
      draftRevision.value += 1
    } else if (!commit(restoredLines, held.invoiceDiscountType, held.invoiceDiscountValue)) {
      return null
    }

    heldDrafts.value = heldDrafts.value.filter((candidate) => candidate.id !== id)
    return held
  }

  function discardHeldDraft(id: string): boolean {
    const next = heldDrafts.value.filter((candidate) => candidate.id !== id)
    if (next.length === heldDrafts.value.length) {
      return false
    }

    heldDrafts.value = next
    return true
  }

  function captureContext(): string {
    return `${contextGeneration.value}:${draftRevision.value}:${catalogGeneration.value}`
  }

  function isCurrentContext(token: string): boolean {
    return token === captureContext()
  }

  /**
   * Explicit cashier action only. The caller resolves every frozen product against the newly
   * installed catalog; a missing or invalid replacement leaves the old snapshot untouched.
   */
  function rebuildFromCatalog(
    products: readonly CatalogProduct[],
    options: { readonly dropLineIds?: readonly string[] } = {}
  ): boolean {
    if (lockedRejection()) {
      return false
    }
    if (!contract.value || !catalogValid.value) {
      return reject('CART_CATALOG_REQUIRED')
    }
    if (!catalogChanged.value) {
      return false
    }

    const byUuid = new Map(products.map((product) => [product.uuid, product]))
    const replacements: CartLineSnapshot[] = []

    const dropped = new Set(options.dropLineIds ?? [])
    for (const line of lines.value) {
      if (dropped.has(line.id)) {
        // Explicitly confirmed by the cashier in the review: a product the new catalog no longer
        // offers is removed, never silently kept at its old price.
        continue
      }
      const product = byUuid.get(line.product.uuid)
      if (!product || product.price.currency !== contract.value.currency) {
        return reject('CART_CATALOG_CHANGED')
      }

      replacements.push({
        ...line,
        mergeKey: mergeKey(product, contract.value.revision),
        catalogRevision: contract.value.revision,
        product: immutableProductSnapshot(product)
      })
    }

    catalogChanged.value = false
    if (replacements.length === 0) {
      clear()
      return true
    }
    const committed = commit(replacements)
    if (!committed) {
      catalogChanged.value = true
    }
    return committed
  }

  return {
    lines,
    heldDrafts,
    saleId,
    locked,
    setLocked,
    contract,
    cartState,
    calculation,
    error,
    canEdit,
    catalogChanged,
    invoiceDiscountType,
    invoiceDiscountValue,
    catalogValid,
    contextGeneration,
    draftRevision,
    catalogGeneration,
    setContract,
    setCatalogValidity,
    addProduct,
    changeQuantity,
    incrementQuantity,
    decrementQuantity,
    setQuantity,
    setLineDiscount,
    setInvoiceDiscount,
    remove,
    clear,
    resetDraft,
    holdDraft,
    recallDraft,
    discardHeldDraft,
    captureContext,
    isCurrentContext,
    rebuildFromCatalog,
    appliedOffers,
    offerFor,
    repriceOffers
  }
})
