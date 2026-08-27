import type { CatalogContract, CatalogProduct } from '@shared/contracts/catalog.contract'

const QUANTITY_SCALE = 1000n
const PERCENTAGE_SCALE = 10_000n
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER)

export type DiscountType = 'fixed' | 'percentage' | null

export type CartCalculationErrorCode =
  | 'CART_CATALOG_REQUIRED'
  | 'CART_CATALOG_CHANGED'
  | 'CART_EMPTY'
  | 'CART_QUANTITY_INVALID'
  | 'CART_QUANTITY_OUT_OF_RANGE'
  | 'CART_PRODUCT_SNAPSHOT_INVALID'
  | 'CART_MIXED_TAX_MODE'
  | 'CART_MIXED_CURRENCY'
  | 'CART_DISCOUNT_INVALID'
  | 'CART_DISCOUNT_EXCEEDS_AMOUNT'
  | 'CART_LINE_TOTAL_LIMIT'
  | 'CART_INVOICE_TOTAL_LIMIT'
  | 'CART_INVALID'

export type CalculationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: CartCalculationErrorCode }

export interface CartCalculationInputLine {
  readonly id: string
  /** Stable product UUID used for deterministic allocation tie-breaking. */
  readonly productUuid: string
  readonly quantity: string
  readonly unitPriceAmount: number
  readonly currency: string
  readonly discountType?: DiscountType
  readonly discountValue?: number
  readonly taxMode: CatalogProduct['tax']['mode']
  readonly taxRateBasisPoints: number
}

export interface CartCalculationLine {
  readonly id: string
  readonly subtotalAmount: number
  readonly discountAmount: number
  readonly taxAmount: number
  readonly totalAmount: number
}

export interface CartCalculation {
  readonly lines: readonly CartCalculationLine[]
  readonly subtotalAmount: number
  readonly discountTotalAmount: number
  readonly taxTotalAmount: number
  readonly grandTotalAmount: number
}

interface PreparedLine {
  readonly input: CartCalculationInputLine
  readonly subtotal: bigint
  readonly lineDiscount: bigint
  readonly taxable: bigint
  readonly rate: bigint
}

function success<T>(value: T): CalculationResult<T> {
  return { ok: true, value }
}

function failure<T = never>(code: CartCalculationErrorCode): CalculationResult<T> {
  return { ok: false, code }
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isCurrency(value: string): boolean {
  return /^[A-Z]{3}$/.test(value)
}

function parseQuantityUnchecked(value: string): bigint | null {
  const match = /^(?<whole>\d+)(?:\.(?<fraction>\d{1,3}))?$/.exec(value)

  if (!match?.groups) {
    return null
  }

  return (
    BigInt(match.groups.whole) * QUANTITY_SCALE +
    BigInt((match.groups.fraction ?? '').padEnd(3, '0'))
  )
}

function parseQuantity(value: string, maximum: string): CalculationResult<bigint> {
  const parsed = parseQuantityUnchecked(value)
  const maximumValue = parseQuantityUnchecked(maximum)

  if (parsed === null || maximumValue === null) {
    return failure('CART_QUANTITY_INVALID')
  }

  if (parsed <= 0n || parsed > maximumValue) {
    return failure('CART_QUANTITY_OUT_OF_RANGE')
  }

  return success(parsed)
}

function milliToQuantity(value: bigint): string {
  const whole = value / QUANTITY_SCALE
  const fraction = String(value % QUANTITY_SCALE).padStart(3, '0')
  return `${whole}.${fraction}`
}

/** Formats a validated quantity in thousandths without exposing BigInt to callers. */
export function formatQuantity(milli: number): CalculationResult<string> {
  if (!isSafeNonNegativeInteger(milli)) {
    return failure('CART_QUANTITY_INVALID')
  }

  return success(milliToQuantity(BigInt(milli)))
}

function halfUp(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) {
    throw new RangeError('halfUp requires a non-negative numerator and positive denominator')
  }

  return (numerator + denominator / 2n) / denominator
}

function checkedNumber(
  value: bigint,
  maximum: number,
  code: CartCalculationErrorCode
): CalculationResult<number> {
  if (value < 0n || value > BigInt(maximum) || value > MAX_SAFE_BIGINT) {
    return failure(code)
  }

  return success(Number(value))
}

function calculateDiscount(
  amount: bigint,
  type: DiscountType,
  rawValue: number
): CalculationResult<bigint> {
  if (!isSafeNonNegativeInteger(rawValue) || (type === null && rawValue !== 0)) {
    return failure('CART_DISCOUNT_INVALID')
  }

  const value = BigInt(rawValue)

  if (type === null) {
    return success(0n)
  }

  if (type === 'fixed') {
    return value > amount ? failure('CART_DISCOUNT_EXCEEDS_AMOUNT') : success(value)
  }

  if (type !== 'percentage' || value > PERCENTAGE_SCALE) {
    return failure('CART_DISCOUNT_INVALID')
  }

  return success(halfUp(amount * value, PERCENTAGE_SCALE))
}

function calculateTax(amount: bigint, mode: CatalogProduct['tax']['mode'], rate: bigint): bigint {
  if (mode === 'none') {
    return 0n
  }

  if (mode === 'exclusive') {
    return halfUp(amount * rate, PERCENTAGE_SCALE)
  }

  return amount - halfUp(amount * PERCENTAGE_SCALE, PERCENTAGE_SCALE + rate)
}

function allocationFor(
  lines: readonly PreparedLine[],
  invoiceDiscount: bigint,
  taxableTotal: bigint
): CalculationResult<bigint[]> {
  if (taxableTotal === 0n) {
    return success(lines.map(() => 0n))
  }

  const allocations: bigint[] = []
  const ranked: Array<{
    readonly index: number
    readonly remainder: bigint
    readonly rate: bigint
    readonly taxable: bigint
    readonly productUuid: string
  }> = []
  let allocated = 0n

  for (const [index, line] of lines.entries()) {
    const numerator = invoiceDiscount * line.taxable
    const floor = numerator / taxableTotal
    const remainder = numerator % taxableTotal
    const allocation = floor > line.taxable ? line.taxable : floor
    allocations[index] = allocation
    allocated += allocation
    ranked.push({
      index,
      remainder,
      rate: line.rate,
      taxable: line.taxable,
      productUuid: line.input.productUuid
    })
  }

  ranked.sort(
    (left, right) =>
      (right.remainder > left.remainder ? 1 : right.remainder < left.remainder ? -1 : 0) ||
      (right.rate > left.rate ? 1 : right.rate < left.rate ? -1 : 0) ||
      (right.taxable > left.taxable ? 1 : right.taxable < left.taxable ? -1 : 0) ||
      left.productUuid.localeCompare(right.productUuid)
  )

  let remaining = invoiceDiscount - allocated

  for (const candidate of ranked) {
    if (remaining === 0n) {
      break
    }

    if (allocations[candidate.index]! < lines[candidate.index]!.taxable) {
      allocations[candidate.index] = allocations[candidate.index]! + 1n
      remaining -= 1n
    }
  }

  // This is defensive only: largest remainder leaves fewer units than there are lines. The
  // UUID ordering keeps the fallback deterministic if malformed data somehow reaches here.
  for (const candidate of [...ranked].sort((left, right) =>
    left.productUuid.localeCompare(right.productUuid)
  )) {
    if (remaining === 0n) {
      break
    }

    const capacity = lines[candidate.index]!.taxable - allocations[candidate.index]!
    if (capacity <= 0n) {
      continue
    }

    const applied = capacity < remaining ? capacity : remaining
    allocations[candidate.index] = allocations[candidate.index]! + applied
    remaining -= applied
  }

  return remaining === 0n ? success(allocations) : failure('CART_DISCOUNT_EXCEEDS_AMOUNT')
}

/**
 * Pure Phase 3D pricing function. It has no Vue, Pinia, Electron, Node, storage, or transport
 * dependencies and never throws for invalid user or catalog input.
 */
export function calculateCart(
  lines: readonly CartCalculationInputLine[],
  contract: CatalogContract,
  invoiceDiscountType: DiscountType = null,
  invoiceDiscountValue = 0
): CalculationResult<CartCalculation> {
  if (lines.length === 0) {
    return failure('CART_EMPTY')
  }

  const modes = new Set(lines.map((line) => line.taxMode))
  const currencies = new Set(lines.map((line) => line.currency))

  if (contract.mixedTaxModePolicy === 'single_invoice_mode' && modes.size > 1) {
    return failure('CART_MIXED_TAX_MODE')
  }

  if (currencies.size > 1 || currencies.has(contract.currency) === false) {
    return failure('CART_MIXED_CURRENCY')
  }

  const prepared: PreparedLine[] = []
  let subtotal = 0n

  for (const line of lines) {
    if (
      !isSafeNonNegativeInteger(line.unitPriceAmount) ||
      !isCurrency(line.currency) ||
      line.unitPriceAmount > contract.maximumUnitPrice ||
      !Number.isSafeInteger(line.taxRateBasisPoints) ||
      line.taxRateBasisPoints < 0 ||
      line.taxRateBasisPoints > 10_000 ||
      !['none', 'inclusive', 'exclusive'].includes(line.taxMode) ||
      (line.taxMode === 'none' && line.taxRateBasisPoints !== 0) ||
      !line.id ||
      !line.productUuid
    ) {
      return failure('CART_PRODUCT_SNAPSHOT_INVALID')
    }

    const quantity = parseQuantity(line.quantity, contract.maximumQuantity)
    if (!quantity.ok) {
      return quantity
    }

    const lineSubtotal = halfUp(quantity.value * BigInt(line.unitPriceAmount), QUANTITY_SCALE)
    const checkedSubtotal = checkedNumber(
      lineSubtotal,
      contract.maximumLineTotal,
      'CART_LINE_TOTAL_LIMIT'
    )
    if (!checkedSubtotal.ok) {
      return checkedSubtotal
    }

    const lineDiscount = calculateDiscount(
      lineSubtotal,
      line.discountType ?? null,
      line.discountValue ?? 0
    )
    if (!lineDiscount.ok) {
      return lineDiscount
    }

    subtotal += lineSubtotal
    const checkedInvoiceSubtotal = checkedNumber(
      subtotal,
      contract.maximumInvoiceTotal,
      'CART_INVOICE_TOTAL_LIMIT'
    )
    if (!checkedInvoiceSubtotal.ok) {
      return checkedInvoiceSubtotal
    }

    prepared.push({
      input: line,
      subtotal: lineSubtotal,
      lineDiscount: lineDiscount.value,
      taxable: lineSubtotal - lineDiscount.value,
      rate: BigInt(line.taxRateBasisPoints)
    })
  }

  const itemDiscountTotal = prepared.reduce((sum, line) => sum + line.lineDiscount, 0n)
  const taxableTotal = prepared.reduce((sum, line) => sum + line.taxable, 0n)
  const invoiceDiscount = calculateDiscount(taxableTotal, invoiceDiscountType, invoiceDiscountValue)
  if (!invoiceDiscount.ok) {
    return invoiceDiscount
  }

  const allocations = allocationFor(prepared, invoiceDiscount.value, taxableTotal)
  if (!allocations.ok) {
    return allocations
  }

  let taxTotal = 0n
  let grandTotal = 0n
  const calculatedLines: CartCalculationLine[] = []

  for (const [index, line] of prepared.entries()) {
    const taxable = line.taxable - allocations.value[index]!
    const taxAmount = calculateTax(taxable, line.input.taxMode, line.rate)
    const totalAmount = line.input.taxMode === 'exclusive' ? taxable + taxAmount : taxable
    taxTotal += taxAmount
    grandTotal += totalAmount

    const checkedGrandTotal = checkedNumber(
      grandTotal,
      contract.maximumInvoiceTotal,
      'CART_INVOICE_TOTAL_LIMIT'
    )
    const checkedSubtotal = checkedNumber(
      line.subtotal,
      contract.maximumLineTotal,
      'CART_LINE_TOTAL_LIMIT'
    )
    const checkedDiscount = checkedNumber(
      line.lineDiscount + allocations.value[index]!,
      contract.maximumLineTotal,
      'CART_LINE_TOTAL_LIMIT'
    )
    const checkedTax = checkedNumber(taxAmount, contract.maximumLineTotal, 'CART_LINE_TOTAL_LIMIT')
    const checkedTotal = checkedNumber(
      totalAmount,
      contract.maximumLineTotal,
      'CART_LINE_TOTAL_LIMIT'
    )

    if (
      !checkedGrandTotal.ok ||
      !checkedSubtotal.ok ||
      !checkedDiscount.ok ||
      !checkedTax.ok ||
      !checkedTotal.ok
    ) {
      return failure('CART_INVOICE_TOTAL_LIMIT')
    }

    calculatedLines.push({
      id: line.input.id,
      subtotalAmount: checkedSubtotal.value,
      discountAmount: checkedDiscount.value,
      taxAmount: checkedTax.value,
      totalAmount: checkedTotal.value
    })
  }

  const result = {
    lines: calculatedLines,
    subtotalAmount: checkedNumber(
      subtotal,
      contract.maximumInvoiceTotal,
      'CART_INVOICE_TOTAL_LIMIT'
    ),
    discountTotalAmount: checkedNumber(
      itemDiscountTotal + invoiceDiscount.value,
      contract.maximumInvoiceTotal,
      'CART_INVOICE_TOTAL_LIMIT'
    ),
    taxTotalAmount: checkedNumber(
      taxTotal,
      contract.maximumInvoiceTotal,
      'CART_INVOICE_TOTAL_LIMIT'
    ),
    grandTotalAmount: checkedNumber(
      grandTotal,
      contract.maximumInvoiceTotal,
      'CART_INVOICE_TOTAL_LIMIT'
    )
  }

  if (
    !result.subtotalAmount.ok ||
    !result.discountTotalAmount.ok ||
    !result.taxTotalAmount.ok ||
    !result.grandTotalAmount.ok
  ) {
    return failure('CART_INVOICE_TOTAL_LIMIT')
  }

  return success({
    lines: calculatedLines,
    subtotalAmount: result.subtotalAmount.value,
    discountTotalAmount: result.discountTotalAmount.value,
    taxTotalAmount: result.taxTotalAmount.value,
    grandTotalAmount: result.grandTotalAmount.value
  })
}

export function addQuantity(
  quantity: string,
  deltaMilli: number,
  contract: CatalogContract
): CalculationResult<string> {
  if (!Number.isSafeInteger(deltaMilli)) {
    return failure('CART_QUANTITY_INVALID')
  }

  const current = parseQuantity(quantity, contract.maximumQuantity)
  const minimum = parseQuantityUnchecked(contract.minimumQuantity)
  const maximum = parseQuantityUnchecked(contract.maximumQuantity)
  if (!current.ok) {
    return current
  }

  if (minimum === null || maximum === null) {
    return failure('CART_QUANTITY_INVALID')
  }

  const next = current.value + BigInt(deltaMilli)
  if (next < minimum || next > maximum) {
    return failure('CART_QUANTITY_OUT_OF_RANGE')
  }

  return success(milliToQuantity(next))
}
