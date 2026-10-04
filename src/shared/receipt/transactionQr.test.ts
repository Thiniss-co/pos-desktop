import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  canonicalJson,
  decodeTransactionReferenceQr,
  encodeTransactionReferenceQr,
  type TransactionReferenceFacts
} from './transactionQr'

/** Byte-identical with the backend's tests/Fixtures/transaction-qr-golden.json (its PHP twin's vectors). */
const golden = JSON.parse(
  readFileSync(resolve(__dirname, '../../../tests/fixtures/transaction-qr-golden.json'), 'utf8')
) as {
  transaction_reference: { name: string; facts: TransactionReferenceFacts; payload: string }[]
  canonical_json: { name: string; value: unknown; canonical: string; sha256: string }[]
  invalid_payloads: string[]
}

describe('txn-ref-v1 transaction reference', () => {
  it.each(golden.transaction_reference.map((c) => [c.name, c] as const))(
    'encodes %s to the golden payload',
    (_name, c) => {
      const payload = encodeTransactionReferenceQr(c.facts)
      expect(payload).toBe(c.payload)
      expect(payload.length).toBeLessThanOrEqual(255)
      expect(/^[\x20-\x7e]+$/.test(payload)).toBe(true)
      expect(decodeTransactionReferenceQr(payload)).toMatchObject({
        co: c.facts.companyUuid,
        doc: c.facts.documentKind,
        id: c.facts.documentUuid,
        cur: c.facts.currency
      })
    }
  )

  it('matches the golden canonical JSON and sha256', () => {
    for (const c of golden.canonical_json) {
      const canonical = canonicalJson(c.value)
      expect(canonical, c.name).toBe(c.canonical)
      expect(createHash('sha256').update(canonical, 'utf8').digest('hex')).toBe(c.sha256)
    }
  })

  it('never decodes other versions, key orders, precisions, cases or URLs', () => {
    for (const payload of golden.invalid_payloads) {
      expect(decodeTransactionReferenceQr(payload)).toBeNull()
    }
  })

  it('refuses identities, currencies and amounts outside the format', () => {
    const facts = golden.transaction_reference[0].facts
    expect(() =>
      encodeTransactionReferenceQr({ ...facts, companyUuid: facts.companyUuid.toUpperCase() })
    ).toThrow(RangeError)
    expect(() => encodeTransactionReferenceQr({ ...facts, currency: 'sar' })).toThrow(RangeError)
    expect(() => encodeTransactionReferenceQr({ ...facts, totalMinor: -1 })).toThrow(RangeError)
    expect(() => encodeTransactionReferenceQr({ ...facts, currencyExponent: 4 })).toThrow(
      RangeError
    )
    expect(() => encodeTransactionReferenceQr({ ...facts, instant: 'not a time' })).toThrow(
      RangeError
    )
  })
})
