/**
 * Offers on register lines (owner expansion Phase E), mirroring the backend's `OfferDiscountRule` and
 * `OfferSelector` exactly and pinned to `tests/fixtures/pos-offer-golden.json`.
 *
 * An offer becomes the line discount the calculator already understands. With the line subtotal
 * S = half-up(quantity × unit price):
 *   percentage  -> percentage discount of `value` basis points; amount = half-up(S × value / 10000)
 *   amount_off  -> fixed discount of min(S, half-up(quantity × value))
 *   fixed_price -> fixed discount of S − half-up(quantity × value), only when value < the unit price
 * An offer that takes nothing off does not apply. The best offer is the highest priority, then the
 * larger amount, then the lowest ordinal. Integers only (BigInt inside); the unit price never changes.
 */

export type OfferType = 'percentage' | 'amount_off' | 'fixed_price'

export interface OfferCandidate {
  readonly revisionUuid: string
  readonly type: OfferType
  readonly value: number
  readonly priority: number
  readonly ordinal: number
}

export interface OfferLineDiscount {
  readonly revisionUuid: string
  readonly discountType: 'fixed' | 'percentage'
  readonly discountValue: number
  readonly amount: number
}

const SCALE = 1000n

function milli(quantity: string): bigint | null {
  const match = /^(?<whole>\d+)(?:\.(?<fraction>\d{1,3}))?$/.exec(quantity)

  return match?.groups
    ? BigInt(match.groups.whole) * SCALE + BigInt((match.groups.fraction ?? '').padEnd(3, '0'))
    : null
}

function halfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator
}

export function offerDiscount(
  offer: OfferCandidate,
  quantity: string,
  unitPriceAmount: number
): OfferLineDiscount | null {
  const quantityMilli = milli(quantity)
  if (quantityMilli === null || quantityMilli <= 0n) {
    return null
  }

  const price = BigInt(unitPriceAmount)
  const value = BigInt(offer.value)
  const subtotal = halfUp(quantityMilli * price, SCALE)
  let discountType: 'fixed' | 'percentage'
  let discountValue: bigint
  let amount: bigint

  switch (offer.type) {
    case 'percentage': {
      const basisPoints = value > 10_000n ? 10_000n : value
      discountType = 'percentage'
      discountValue = basisPoints
      amount = halfUp(subtotal * basisPoints, 10_000n)
      break
    }
    case 'amount_off': {
      const off = halfUp(quantityMilli * value, SCALE)
      discountType = 'fixed'
      discountValue = off < subtotal ? off : subtotal
      amount = discountValue
      break
    }
    case 'fixed_price': {
      const remaining = subtotal - halfUp(quantityMilli * value, SCALE)
      discountType = 'fixed'
      discountValue = value >= price || remaining < 0n ? 0n : remaining
      amount = discountValue
      break
    }
  }

  return amount <= 0n
    ? null
    : {
        revisionUuid: offer.revisionUuid,
        discountType,
        discountValue: Number(discountValue),
        amount: Number(amount)
      }
}

export function bestOffer(
  candidates: readonly OfferCandidate[],
  quantity: string,
  unitPriceAmount: number
): OfferLineDiscount | null {
  let best: OfferLineDiscount | null = null
  let bestCandidate: OfferCandidate | null = null

  for (const candidate of candidates) {
    const discount = offerDiscount(candidate, quantity, unitPriceAmount)
    if (discount === null) {
      continue
    }

    if (
      best === null ||
      bestCandidate === null ||
      candidate.priority > bestCandidate.priority ||
      (candidate.priority === bestCandidate.priority && discount.amount > best.amount) ||
      (candidate.priority === bestCandidate.priority &&
        discount.amount === best.amount &&
        candidate.ordinal < bestCandidate.ordinal)
    ) {
      best = discount
      bestCandidate = candidate
    }
  }

  return best
}

/** One register offer revision as the installed catalog contract carries it. */
export interface CatalogOffer extends OfferCandidate {
  readonly name: string
  /** UTC instant, inclusive. */
  readonly startsAt: string
  /** UTC instant, exclusive; null = open-ended. */
  readonly endsAt: string | null
  readonly productUuids: readonly string[]
}

export interface OfferPricingLine {
  readonly id: string
  readonly productUuid: string
  readonly quantity: string
  readonly unitPriceAmount: number
  readonly discountType: 'fixed' | 'percentage' | null
  readonly discountValue: number
}

export interface AppliedOffer extends OfferLineDiscount {
  readonly name: string
}

/**
 * The offer each line is sold under at `at`. A line with a manual discount never gets one (the
 * manual discount replaces any offer); every other line gets the best offer that targets its product
 * and whose window `[startsAt, endsAt)` covers `at`, if any takes something off. The same function
 * runs in the renderer (display), the checkout preview and the commit (at the sale instant), so the
 * three can only disagree when the instant itself crosses a window edge.
 */
export function applyOffers(
  lines: readonly OfferPricingLine[],
  offers: readonly CatalogOffer[] | undefined,
  at: Date
): ReadonlyMap<string, AppliedOffer> {
  const applied = new Map<string, AppliedOffer>()
  if (!offers || offers.length === 0) {
    return applied
  }

  const instant = at.getTime()
  const live = offers.filter(
    (offer) =>
      Date.parse(offer.startsAt) <= instant &&
      (offer.endsAt === null || instant < Date.parse(offer.endsAt))
  )

  for (const line of lines) {
    if (line.discountType !== null || line.discountValue !== 0) {
      continue
    }

    const candidates = live.filter((offer) => offer.productUuids.includes(line.productUuid))
    const best = bestOffer(candidates, line.quantity, line.unitPriceAmount)
    if (best !== null) {
      const offer = candidates.find((candidate) => candidate.revisionUuid === best.revisionUuid)
      applied.set(line.id, { ...best, name: offer?.name ?? '' })
    }
  }

  return applied
}
