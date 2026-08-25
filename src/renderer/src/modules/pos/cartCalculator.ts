import type { CatalogContract, CatalogProduct } from '@shared/contracts/catalog.contract'

const QUANTITY_SCALE = 1000n
const PERCENTAGE_SCALE = 10_000n

export type DiscountType = 'fixed' | 'percentage' | null

export interface CartCalculationInputLine {
  readonly id: string
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

export class CartDomainError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'CartDomainError'
  }
}

function quantityToMilli(quantity: string, maximum: string): bigint {
  const match = /^(?<whole>\d+)(?:\.(?<fraction>\d{1,3}))?$/.exec(quantity)

  if (!match?.groups) {
    throw new CartDomainError('CART_QUANTITY_INVALID')
  }

  const value =
    BigInt(match.groups.whole) * QUANTITY_SCALE +
    BigInt((match.groups.fraction ?? '').padEnd(3, '0'))
  const maximumValue = quantityToMilliUnchecked(maximum)

  if (value <= 0n || value > maximumValue) {
    throw new CartDomainError('CART_QUANTITY_OUT_OF_RANGE')
  }

  return value
}

function quantityToMilliUnchecked(quantity: string): bigint {
  const [whole, fraction = ''] = quantity.split('.')
  return BigInt(whole) * QUANTITY_SCALE + BigInt(fraction.padEnd(3, '0'))
}

export function formatQuantity(milli: bigint): string {
  const whole = milli / QUANTITY_SCALE
  const fraction = String(milli % QUANTITY_SCALE).padStart(3, '0')
  return `${whole}.${fraction}`
}

function halfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator
}

function checkedNumber(value: bigint, maximum: number, code: string): number {
  if (value < 0n || value > BigInt(maximum) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CartDomainError(code)
  }

  return Number(value)
}

function discount(amount: bigint, type: DiscountType, rawValue: number): bigint {
  const value = BigInt(rawValue)

  if (rawValue < 0 || !Number.isSafeInteger(rawValue) || (type === null && value !== 0n)) {
    throw new CartDomainError('CART_DISCOUNT_INVALID')
  }

  if (type === null) {
    return 0n
  }

  if (type === 'fixed') {
    if (value > amount) {
      throw new CartDomainError('CART_DISCOUNT_EXCEEDS_AMOUNT')
    }

    return value
  }

  if (value > PERCENTAGE_SCALE) {
    throw new CartDomainError('CART_DISCOUNT_INVALID')
  }

  return halfUp(amount * value, PERCENTAGE_SCALE)
}

function tax(amount: bigint, mode: CatalogProduct['tax']['mode'], rate: bigint): bigint {
  if (mode === 'none') {
    return 0n
  }

  if (mode === 'exclusive') {
    return halfUp(amount * rate, PERCENTAGE_SCALE)
  }

  return amount - halfUp(amount * PERCENTAGE_SCALE, PERCENTAGE_SCALE + rate)
}

export function calculateCart(
  lines: readonly CartCalculationInputLine[],
  contract: CatalogContract,
  invoiceDiscountType: DiscountType = null,
  invoiceDiscountValue = 0
): CartCalculation {
  if (lines.length === 0) {
    return {
      lines: [],
      subtotalAmount: 0,
      discountTotalAmount: 0,
      taxTotalAmount: 0,
      grandTotalAmount: 0
    }
  }

  const modes = new Set(lines.map((line) => line.taxMode))
  const currencies = new Set(lines.map((line) => line.currency))

  if (contract.mixedTaxModePolicy === 'single_invoice_mode' && modes.size > 1) {
    throw new CartDomainError('CART_MIXED_TAX_MODE')
  }

  if (currencies.size > 1) {
    throw new CartDomainError('CART_MIXED_CURRENCY')
  }

  const prepared = lines.map((line) => {
    const unitPrice = BigInt(line.unitPriceAmount)
    const rate = BigInt(line.taxRateBasisPoints)

    if (
      !Number.isSafeInteger(line.unitPriceAmount) ||
      !/^[A-Z]{3}$/.test(line.currency) ||
      line.unitPriceAmount < 0 ||
      line.unitPriceAmount > contract.maximumUnitPrice ||
      !Number.isInteger(line.taxRateBasisPoints) ||
      line.taxRateBasisPoints < 0 ||
      line.taxRateBasisPoints > 10_000 ||
      (line.taxMode === 'none' && line.taxRateBasisPoints !== 0)
    ) {
      throw new CartDomainError('CART_PRODUCT_SNAPSHOT_INVALID')
    }

    const subtotal = halfUp(
      quantityToMilli(line.quantity, contract.maximumQuantity) * unitPrice,
      QUANTITY_SCALE
    )
    checkedNumber(subtotal, contract.maximumLineTotal, 'CART_LINE_TOTAL_LIMIT')
    const lineDiscount = discount(subtotal, line.discountType ?? null, line.discountValue ?? 0)

    return {
      input: line,
      subtotal,
      lineDiscount,
      taxable: subtotal - lineDiscount,
      rate
    }
  })
  const subtotal = prepared.reduce((sum, line) => sum + line.subtotal, 0n)
  checkedNumber(subtotal, contract.maximumInvoiceTotal, 'CART_INVOICE_TOTAL_LIMIT')
  const itemDiscountTotal = prepared.reduce((sum, line) => sum + line.lineDiscount, 0n)
  const taxableTotal = prepared.reduce((sum, line) => sum + line.taxable, 0n)
  const invoiceDiscount = discount(taxableTotal, invoiceDiscountType, invoiceDiscountValue)
  let remainingInvoiceDiscount = invoiceDiscount
  let remainingTaxable = taxableTotal
  let taxTotal = 0n
  let grandTotal = 0n

  const calculatedLines = prepared.map((line, index) => {
    let allocatedDiscount =
      index === prepared.length - 1
        ? remainingInvoiceDiscount
        : remainingTaxable === 0n
          ? 0n
          : halfUp(invoiceDiscount * line.taxable, taxableTotal)
    allocatedDiscount = [allocatedDiscount, remainingInvoiceDiscount, line.taxable].reduce(
      (minimum, value) => (value < minimum ? value : minimum)
    )
    remainingInvoiceDiscount -= allocatedDiscount
    remainingTaxable -= line.taxable
    const taxable = line.taxable - allocatedDiscount
    const taxAmount = tax(taxable, line.input.taxMode, line.rate)
    const totalAmount = line.input.taxMode === 'exclusive' ? taxable + taxAmount : taxable
    taxTotal += taxAmount
    grandTotal += totalAmount
    checkedNumber(grandTotal, contract.maximumInvoiceTotal, 'CART_INVOICE_TOTAL_LIMIT')

    return {
      id: line.input.id,
      subtotalAmount: checkedNumber(
        line.subtotal,
        contract.maximumLineTotal,
        'CART_LINE_TOTAL_LIMIT'
      ),
      discountAmount: checkedNumber(
        line.lineDiscount + allocatedDiscount,
        contract.maximumLineTotal,
        'CART_LINE_TOTAL_LIMIT'
      ),
      taxAmount: checkedNumber(taxAmount, contract.maximumLineTotal, 'CART_LINE_TOTAL_LIMIT'),
      totalAmount: checkedNumber(totalAmount, contract.maximumLineTotal, 'CART_LINE_TOTAL_LIMIT')
    }
  })

  return {
    lines: calculatedLines,
    subtotalAmount: checkedNumber(
      subtotal,
      contract.maximumInvoiceTotal,
      'CART_INVOICE_TOTAL_LIMIT'
    ),
    discountTotalAmount: checkedNumber(
      itemDiscountTotal + invoiceDiscount,
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
}

export function addQuantity(
  quantity: string,
  deltaMilli: bigint,
  contract: CatalogContract
): string {
  const next = quantityToMilli(quantity, contract.maximumQuantity) + deltaMilli
  const minimum = quantityToMilliUnchecked(contract.minimumQuantity)
  const maximum = quantityToMilliUnchecked(contract.maximumQuantity)

  if (next < minimum || next > maximum) {
    throw new CartDomainError('CART_QUANTITY_OUT_OF_RANGE')
  }

  return formatQuantity(next)
}
