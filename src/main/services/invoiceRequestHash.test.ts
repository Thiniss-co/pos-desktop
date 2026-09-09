import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

import {
  carbonJsonTimestamp,
  invoiceHashableJson,
  invoiceRequestHash,
  invoiceRequestHashFromPayloadJson,
  phpJsonEncode
} from './invoiceRequestHash'

interface RequestHashCase {
  readonly name: string
  readonly payload: Record<string, unknown>
  readonly hashableJson: string
  readonly hashableBytesHex: string
  readonly requestHash: string
}

const golden = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../tests/fixtures/desktop-invoice-request-hash-golden.json'),
    'utf8'
  )
) as { readonly cases: readonly RequestHashCase[] }

const byName = new Map(golden.cases.map((entry) => [entry.name, entry]))

describe('immutable invoice request hash cross-language golden vector', () => {
  it('covers every escaping and normalization case the backend pins', () => {
    expect([...byName.keys()]).toEqual([
      'minimal-tracked-line',
      'non-ascii-notes-and-barcode',
      'forward-slash-reference',
      'multi-line-multi-allocation-discounted',
      'positive-offset-sold-at'
    ])
  })

  it.each(golden.cases.map((entry) => entry.name))(
    'reproduces the backend hashable bytes and request hash for %s',
    (name) => {
      const testCase = byName.get(name) as RequestHashCase

      expect(invoiceHashableJson(testCase.payload)).toBe(testCase.hashableJson)
      expect(Buffer.from(invoiceHashableJson(testCase.payload), 'utf8').toString('hex')).toBe(
        testCase.hashableBytesHex
      )
      expect(invoiceRequestHash(testCase.payload)).toBe(testCase.requestHash)
      expect(invoiceRequestHashFromPayloadJson(JSON.stringify(testCase.payload))).toBe(
        testCase.requestHash
      )
    }
  )

  it('does not merely reproduce JSON.stringify', () => {
    const nonAscii = byName.get('non-ascii-notes-and-barcode') as RequestHashCase
    const slashes = byName.get('forward-slash-reference') as RequestHashCase

    expect(nonAscii.hashableJson).toContain('\\u0645\\u0644')
    expect(slashes.hashableJson).toContain('TERM\\/2026\\/09\\/06#A\\/B')
    expect(JSON.stringify(JSON.parse(nonAscii.hashableJson))).not.toBe(nonAscii.hashableJson)
  })

  it('is sensitive to any change in the committed payload', () => {
    const testCase = byName.get('multi-line-multi-allocation-discounted') as RequestHashCase
    const tampered = structuredClone(testCase.payload) as Record<string, unknown>
    const items = tampered.items as Record<string, unknown>[]
    const allocations = items[0].allocations as Record<string, unknown>[]

    allocations[0].quantity_milli = 1251

    expect(invoiceRequestHash(tampered)).not.toBe(testCase.requestHash)
  })
})

describe('php json_encode compatibility', () => {
  it('escapes slashes, controls and non-ascii the way PHP does', () => {
    expect(phpJsonEncode('a/b')).toBe('"a\\/b"')
    expect(phpJsonEncode('ص')).toBe('"\\u0635"')
    expect(phpJsonEncode('\n\t')).toBe('"\\n\\t"')
    expect(phpJsonEncode('\u0001')).toBe('"\\u0001"')
    // Non-BMP codepoints are emitted as the surrogate pair PHP emits.
    expect(phpJsonEncode('\u{1F600}')).toBe('"\\ud83d\\ude00"')
  })

  it('preserves object key insertion order rather than sorting', () => {
    expect(phpJsonEncode({ b: 1, a: 2 })).toBe('{"b":1,"a":2}')
  })

  it('refuses a non-integer number rather than guessing at PHP float formatting', () => {
    expect(() => phpJsonEncode(1.5)).toThrow(/non-integer number/)
  })
})

describe('carbon timestamp normalization', () => {
  it('converts any offset to UTC with six fractional digits', () => {
    expect(carbonJsonTimestamp('2026-09-06T07:08:09+00:00')).toBe('2026-09-06T07:08:09.000000Z')
    expect(carbonJsonTimestamp('2026-09-06T10:11:12+03:00')).toBe('2026-09-06T07:11:12.000000Z')
    expect(carbonJsonTimestamp('2026-09-06T01:11:12-05:30')).toBe('2026-09-06T06:41:12.000000Z')
    expect(carbonJsonTimestamp('2026-09-06T07:08:09Z')).toBe('2026-09-06T07:08:09.000000Z')
    expect(carbonJsonTimestamp('2026-09-06T07:08:09.123Z')).toBe('2026-09-06T07:08:09.123000Z')
  })

  it('refuses a timestamp shape it was not written for', () => {
    expect(() => carbonJsonTimestamp('2026-09-06 07:08:09')).toThrow(/Unsupported sold_at/)
  })
})
