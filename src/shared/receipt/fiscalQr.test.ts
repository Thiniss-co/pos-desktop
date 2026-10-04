import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  decodeZatcaPhase1Qr,
  encodeZatcaPhase1Qr,
  encodeZatcaPhase1QrFields,
  zatcaAmount,
  zatcaTimestamp
} from './fiscalQr'
import {
  canonicalJson,
  decodeTransactionReferenceQr,
  encodeTransactionReferenceQr
} from './transactionQr'

interface GoldenCase {
  readonly name: string
  readonly input: {
    readonly sellerName: string
    readonly vatNumber: string
    readonly timestamp: string
    readonly totalMinor: number
    readonly vatMinor: number
    readonly currencyExponent: number
  }
  readonly amounts: { readonly total: string; readonly vatTotal: string }
  readonly tlvHex: string
  readonly base64: string
}

const golden = JSON.parse(
  readFileSync(
    new URL('../../../tests/fixtures/zatca-phase1-qr-golden.json', import.meta.url),
    'utf8'
  )
) as {
  readonly cases: readonly GoldenCase[]
  readonly rejects: ReadonlyArray<{
    readonly name: string
    readonly input: {
      sellerName: string
      vatNumber: string
      timestamp: string
      total: string
      vatTotal: string
    }
  }>
}

describe('ZATCA Phase 1 QR (shared golden with the backend)', () => {
  it('reproduces the official ZATCA example', () => {
    expect(
      encodeZatcaPhase1Qr({
        sellerName: 'Bobs Records',
        vatNumber: '310122393500003',
        timestamp: '2022-04-25T15:30:00Z',
        totalMinor: 100000,
        vatMinor: 15000,
        currencyExponent: 2
      })
    ).toEqual({
      ok: true,
      payload:
        'AQxCb2JzIFJlY29yZHMCDzMxMDEyMjM5MzUwMDAwMwMUMjAyMi0wNC0yNVQxNTozMDowMFoEBzEwMDAuMDAFBjE1MC4wMA=='
    })
  })

  it.each(golden.cases.map((entry) => entry.name))(
    'encodes %s byte-for-byte and decodes it back',
    (name) => {
      const entry = golden.cases.find((candidate) => candidate.name === name) as GoldenCase
      const result = encodeZatcaPhase1Qr(entry.input)

      expect(result).toEqual({ ok: true, payload: entry.base64 })
      expect(Buffer.from(entry.base64, 'base64').toString('hex')).toBe(entry.tlvHex)
      expect(decodeZatcaPhase1Qr(entry.base64)).toEqual({
        sellerName: entry.input.sellerName,
        vatNumber: entry.input.vatNumber,
        timestamp: entry.input.timestamp,
        total: entry.amounts.total,
        vatTotal: entry.amounts.vatTotal
      })
    }
  )

  it.each(golden.rejects.map((entry) => entry.name))(
    'refuses %s exactly as the backend does',
    (name) => {
      const entry = golden.rejects.find((candidate) => candidate.name === name)!
      expect(encodeZatcaPhase1QrFields(entry.input).ok).toBe(false)
    }
  )

  it('refuses a payload that is not exactly tags 1–5 (wrong type, truncated, extra bytes)', () => {
    const official =
      'AQxCb2JzIFJlY29yZHMCDzMxMDEyMjM5MzUwMDAwMwMUMjAyMi0wNC0yNVQxNTozMDowMFoEBzEwMDAuMDAFBjE1MC4wMA=='
    const bytes = Buffer.from(official, 'base64')
    expect(
      decodeZatcaPhase1Qr(Buffer.concat([bytes, Buffer.from([6, 1, 65])]).toString('base64'))
    ).toBeNull()
    expect(decodeZatcaPhase1Qr(bytes.subarray(0, bytes.length - 2).toString('base64'))).toBeNull()
    expect(decodeZatcaPhase1Qr('THINIS-TXN/1;co=x')).toBeNull()
    expect(decodeZatcaPhase1Qr('')).toBeNull()
  })

  it('formats amounts and time stamps exactly', () => {
    expect(zatcaAmount(5, 2)).toBe('0.05')
    expect(zatcaAmount(1234567, 3)).toBe('1234.567')
    expect(zatcaAmount(7, 0)).toBe('7')
    expect(zatcaTimestamp('2026-10-04T20:05:09.987+03:00')).toBe('2026-10-04T17:05:09Z')
    expect(() => zatcaAmount(-1, 2)).toThrow()
  })
})

describe('txn-ref-v1 transaction reference QR', () => {
  const facts = {
    companyUuid: '11111111-1111-4111-8111-111111111111',
    documentKind: 'sale' as const,
    documentUuid: '22222222-2222-4222-8222-222222222222',
    instant: '2026-10-04T20:05:09.5+03:00',
    totalMinor: 4075,
    currencyExponent: 2,
    currency: 'SAR'
  }

  it('encodes the agreed fixed-order ASCII form and parses it back', () => {
    const text = encodeTransactionReferenceQr(facts)
    expect(text).toBe(
      'THINIS-TXN/1;co=11111111-1111-4111-8111-111111111111;doc=sale;id=22222222-2222-4222-8222-222222222222;ts=2026-10-04T17:05:09Z;amt=40.75;cur=SAR'
    )
    expect(text.length).toBeLessThanOrEqual(255)
    expect(decodeTransactionReferenceQr(text)).toEqual({
      co: facts.companyUuid,
      doc: 'sale',
      id: facts.documentUuid,
      ts: '2026-10-04T17:05:09Z',
      amt: '40.75',
      cur: 'SAR'
    })
  })

  it('refuses a reordered, foreign or ZATCA payload', () => {
    expect(decodeTransactionReferenceQr('THINIS-TXN/1;doc=sale;co=x')).toBeNull()
    expect(
      decodeTransactionReferenceQr(
        'AQxCb2JzIFJlY29yZHMCDzMxMDEyMjM5MzUwMDAwMwMUMjAyMi0wNC0yNVQxNTozMDowMFoEBzEwMDAuMDAFBjE1MC4wMA=='
      )
    ).toBeNull()
    expect(() => encodeTransactionReferenceQr({ ...facts, companyUuid: 'not-a-uuid' })).toThrow()
  })

  it('canonical JSON sorts keys recursively and does not escape Arabic', () => {
    expect(canonicalJson({ b: 1, a: { d: 'مرحبا', c: [2, { z: 0, y: 1 }] } })).toBe(
      '{"a":{"c":[2,{"y":1,"z":0}],"d":"مرحبا"},"b":1}'
    )
  })
})
