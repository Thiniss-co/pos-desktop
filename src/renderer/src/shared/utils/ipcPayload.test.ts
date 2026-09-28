import { describe, expect, it } from 'vitest'
import { reactive, ref } from 'vue'
import { IpcPayloadError, toIpcPayload } from './ipcPayload'

describe('toIpcPayload', () => {
  it('turns reactive state into structured-clone-safe plain data', () => {
    const query = ref({ page: 2, perPage: 25, search: 'ana', roles: ['cashier'] })
    const nested = reactive({ document: { kind: 'sale', invoiceLocalUuid: 'i-1' }, copies: 1 })

    // A Vue Proxy itself cannot cross Electron's preload bridge.
    expect(() => structuredClone(query.value)).toThrow()

    const plainQuery = toIpcPayload(query.value)
    const plainNested = toIpcPayload(nested)

    expect(() => structuredClone(plainQuery)).not.toThrow()
    expect(() => structuredClone(plainNested)).not.toThrow()
    expect(plainQuery).toEqual({ page: 2, perPage: 25, search: 'ana', roles: ['cashier'] })
    expect(plainNested).toEqual({ document: { kind: 'sale', invoiceLocalUuid: 'i-1' }, copies: 1 })
  })

  it('preserves every contract value exactly, including null and undefined optionals', () => {
    const intent = reactive({
      lines: [
        { lineId: 'l-1', quantityMilli: 1500, unitPriceAmount: 900_000_000_000_000, note: 'شاي' },
        { lineId: 'l-2', quantityMilli: -1, unitPriceAmount: 0, note: '' }
      ],
      customerUuid: null,
      reference: undefined,
      stockReturned: false
    })

    const copy = toIpcPayload(intent)

    expect(copy).toStrictEqual({
      lines: [
        { lineId: 'l-1', quantityMilli: 1500, unitPriceAmount: 900_000_000_000_000, note: 'شاي' },
        { lineId: 'l-2', quantityMilli: -1, unitPriceAmount: 0, note: '' }
      ],
      customerUuid: null,
      reference: undefined,
      stockReturned: false
    })
    expect(Object.hasOwn(copy, 'reference')).toBe(true)
    expect(toIpcPayload(undefined)).toBeUndefined()
    expect(toIpcPayload('en')).toBe('en')
  })

  it('never mutates the source and never shares nested objects with it', () => {
    const source = { document: { kind: 'sale' }, rows: [{ amount: 1 }] }
    const copy = toIpcPayload(source)

    expect(copy.document).not.toBe(source.document)
    expect(copy.rows[0]).not.toBe(source.rows[0])
    expect(source).toEqual({ document: { kind: 'sale' }, rows: [{ amount: 1 }] })
  })

  class Money {
    constructor(readonly amount: number) {}
  }

  const circular: Record<string, unknown> = { name: 'loop' }
  circular.self = circular

  it.each([
    ['NaN', { amount: Number.NaN }, '$.amount', 'a non-finite number'],
    [
      'Infinity',
      { rows: [{ amount: Number.POSITIVE_INFINITY }] },
      '$.rows[0].amount',
      'a non-finite number'
    ],
    ['a Date', { soldAt: new Date(0) }, '$.soldAt', 'not a plain object'],
    ['a Map', { lines: new Map() }, '$.lines', 'not a plain object'],
    ['a class instance', { total: new Money(5) }, '$.total', 'not a plain object'],
    ['a function', { onDone: () => undefined }, '$.onDone', 'a function'],
    ['a bigint', { amount: 10n }, '$.amount', 'a bigint'],
    ['a symbol value', { kind: Symbol('sale') }, '$.kind', 'a symbol'],
    ['a symbol key', { [Symbol('hidden')]: 1, visible: 2 }, '$', 'a symbol-keyed property'],
    ['a circular reference', circular, '$.self', 'a circular reference']
  ])('refuses %s instead of silently converting it', (_label, payload, path, reason) => {
    let thrown: unknown = null

    try {
      toIpcPayload(payload)
    } catch (caught) {
      thrown = caught
    }

    expect(thrown).toBeInstanceOf(IpcPayloadError)
    expect((thrown as IpcPayloadError).path).toBe(path)
    expect((thrown as IpcPayloadError).reason).toBe(reason)
  })

  it('allows the same object twice when it is shared rather than circular', () => {
    const method = { uuid: 'pm-1' }

    expect(toIpcPayload({ first: method, second: method })).toEqual({
      first: { uuid: 'pm-1' },
      second: { uuid: 'pm-1' }
    })
  })
})
