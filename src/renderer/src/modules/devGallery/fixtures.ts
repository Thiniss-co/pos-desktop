/**
 * Typed, immutable fixtures for the dev-only design gallery. Nothing here is read from or written
 * to IPC/HTTP/SQLite — every value is a hand-authored literal, frozen so a gallery section can
 * never accidentally mutate shared state between renders.
 */
import type {
  DisplayCartLine,
  DisplayCategory,
  DisplayCustomer,
  DisplayPaymentMethod,
  DisplayProduct,
  DisplaySplitPayment
} from '@renderer/shared/components/pos/types'

export const categoryFixtures: readonly DisplayCategory[] = Object.freeze([
  Object.freeze({ id: 'beverages', label: 'Beverages' }),
  Object.freeze({ id: 'bakery', label: 'Bakery' }),
  Object.freeze({ id: 'snacks', label: 'Snacks' })
])

export const productFixtures: readonly DisplayProduct[] = Object.freeze([
  Object.freeze({
    id: 'p1',
    name: 'House Blend Coffee, 250g',
    sku: '6291041500123',
    price: '$8.50',
    stock: 'in-stock',
    categoryId: 'beverages'
  }),
  Object.freeze({
    id: 'p2',
    name: 'Sourdough Loaf',
    sku: '6291041500456',
    price: '$4.25',
    stock: 'low-stock',
    categoryId: 'bakery'
  }),
  Object.freeze({
    id: 'p3',
    name: 'Sea Salt Pretzels',
    sku: '6291041500789',
    price: '$3.10',
    stock: 'out-of-stock',
    categoryId: 'snacks'
  })
])

export const emptyCartFixture: readonly DisplayCartLine[] = Object.freeze([])

export const populatedCartFixture: readonly DisplayCartLine[] = Object.freeze([
  Object.freeze({
    id: 'l1',
    name: 'House Blend Coffee, 250g',
    sku: '6291041500123',
    quantity: 2,
    unitPrice: '$8.50',
    lineTotal: '$17.00'
  }),
  Object.freeze({
    id: 'l2',
    name: 'Sourdough Loaf',
    sku: '6291041500456',
    quantity: 1,
    unitPrice: '$4.25',
    lineTotal: '$4.25'
  })
])

export const longCartFixture: readonly DisplayCartLine[] = Object.freeze(
  Array.from({ length: 14 }, (_, index) =>
    Object.freeze({
      id: `long-${index}`,
      name: `Catalog item ${index + 1}`,
      sku: `62910415${String(index).padStart(5, '0')}`,
      quantity: (index % 3) + 1,
      unitPrice: '$2.00',
      lineTotal: `$${(((index % 3) + 1) * 2).toFixed(2)}`
    })
  )
)

export const customerFixtures: readonly DisplayCustomer[] = Object.freeze([
  Object.freeze({ id: 'c1', name: 'Amina Hassan', detail: 'amina@example.com' }),
  Object.freeze({ id: 'c2', name: 'Omar Farouk', detail: '+20 100 555 0110' })
])

export const paymentMethodFixtures: readonly DisplayPaymentMethod[] = Object.freeze([
  Object.freeze({ id: 'cash', kind: 'cash', label: 'Cash' }),
  Object.freeze({ id: 'card', kind: 'card', label: 'Card' }),
  Object.freeze({ id: 'wallet', kind: 'wallet', label: 'Mobile wallet' })
])

export const splitPaymentFixtures: readonly DisplaySplitPayment[] = Object.freeze([
  Object.freeze({ id: 's1', methodLabel: 'Cash', amount: '$10.00' }),
  Object.freeze({ id: 's2', methodLabel: 'Card', amount: '$11.25' })
])
