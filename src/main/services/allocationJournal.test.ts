import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

import {
  allocationItemLineUuid,
  allocationJournalAppend,
  allocationJournalChainHash,
  allocationJournalEntryBytes,
  allocationJournalInitialHash,
  isSha256Hex,
  uuid5Oid,
  type AllocationJournalEntry
} from './allocationJournal'

interface JournalVectorEntry {
  readonly consumption_sequence: number
  readonly local_consumption_uuid: string
  readonly invoice_idempotency_key: string
  readonly item_line_uuid: string
  readonly quantity_milli: number
  readonly request_hash: string
  readonly entry_bytes_hex: string
  readonly entry_hash: string
  readonly chain_hash: string
}

interface JournalVector {
  readonly allocation_uuid: string
  readonly rights_generation: number
  readonly initial_hash: string
  readonly entries: readonly JournalVectorEntry[]
}

const fixturesDir = resolve(__dirname, '../../../tests/fixtures')

const vector = JSON.parse(
  readFileSync(resolve(fixturesDir, 'stock-allocation-journal-v1.json'), 'utf8')
) as JournalVector

const envelopeGolden = JSON.parse(
  readFileSync(resolve(fixturesDir, 'stock-allocation-envelope-golden.json'), 'utf8')
) as {
  readonly reconciliation: {
    readonly coverageJournals: readonly {
      readonly allocation_uuid: string
      readonly rights_generation: number
      readonly initial_hash: string
      readonly entries: readonly JournalVectorEntry[]
      readonly boundary: {
        readonly accepted_consumption_sequence: number
        readonly accepted_consumed_quantity_milli: number
        readonly accepted_chain_hash: string
      }
      readonly emptyPrefixBoundary: {
        readonly accepted_consumption_sequence: number
        readonly accepted_consumed_quantity_milli: number
        readonly accepted_chain_hash: string
      }
    }[]
  }
}

function toEntry(
  allocationUuid: string,
  rightsGeneration: number,
  raw: JournalVectorEntry
): AllocationJournalEntry {
  return {
    allocationUuid,
    rightsGeneration,
    consumptionSequence: raw.consumption_sequence,
    localConsumptionUuid: raw.local_consumption_uuid,
    invoiceIdempotencyKey: raw.invoice_idempotency_key,
    itemLineUuid: raw.item_line_uuid,
    quantityMilli: raw.quantity_milli,
    requestHash: raw.request_hash
  }
}

describe('journal v1 cross-language golden vector', () => {
  it('reproduces the backend initial hash', () => {
    expect(allocationJournalInitialHash(vector.allocation_uuid, vector.rights_generation)).toBe(
      vector.initial_hash
    )
  })

  it('reproduces every entry byte sequence, entry hash and chain hash', () => {
    let chainHash = vector.initial_hash

    for (const raw of vector.entries) {
      const entry = toEntry(vector.allocation_uuid, vector.rights_generation, raw)

      // The vector's `invoice-é-001` is the reason the length prefix must count UTF-8 bytes: its
      // byte length is 14 while its JavaScript string length is 13.
      expect(allocationJournalEntryBytes(entry).toString('hex')).toBe(raw.entry_bytes_hex)

      const hashes = allocationJournalAppend(chainHash, entry)
      expect(hashes.entryHash).toBe(raw.entry_hash)
      expect(hashes.chainHash).toBe(raw.chain_hash)
      chainHash = hashes.chainHash
    }

    expect(chainHash).toBe(vector.entries[vector.entries.length - 1].chain_hash)
  })

  it('replays the full chain in one call', () => {
    const entries = vector.entries.map((raw) => ({
      ...toEntry(vector.allocation_uuid, vector.rights_generation, raw),
      entryHash: raw.entry_hash,
      chainHash: raw.chain_hash
    }))

    expect(
      allocationJournalChainHash(vector.allocation_uuid, vector.rights_generation, entries)
    ).toBe(vector.entries[vector.entries.length - 1].chain_hash)
  })

  it('returns the initial hash for an empty prefix', () => {
    expect(allocationJournalChainHash(vector.allocation_uuid, vector.rights_generation, [])).toBe(
      vector.initial_hash
    )
  })

  it('rejects a sequence gap, a foreign grant identity and a tampered stored hash', () => {
    const [first, second] = vector.entries.map((raw) =>
      toEntry(vector.allocation_uuid, vector.rights_generation, raw)
    )

    expect(() =>
      allocationJournalChainHash(vector.allocation_uuid, vector.rights_generation, [second])
    ).toThrow(/sequence gap/)

    expect(() =>
      allocationJournalChainHash(vector.allocation_uuid, vector.rights_generation, [
        first,
        { ...second, allocationUuid: '11111111-1111-4111-8111-111111111112' }
      ])
    ).toThrow(/another grant identity/)

    expect(() =>
      allocationJournalChainHash(vector.allocation_uuid, vector.rights_generation, [
        { ...first, chainHash: 'f'.repeat(64) }
      ])
    ).toThrow(/hash is inconsistent/)
  })

  it('binds the chain to the allocation identity and rights generation', () => {
    const base = allocationJournalInitialHash(vector.allocation_uuid, vector.rights_generation)

    expect(
      allocationJournalInitialHash(vector.allocation_uuid, vector.rights_generation + 1)
    ).not.toBe(base)
    expect(
      allocationJournalInitialHash('11111111-1111-4111-8111-111111111112', vector.rights_generation)
    ).not.toBe(base)
  })
})

describe('coverage journals in the allocation envelope golden fixture', () => {
  it('recomputes every published boundary hash, including the empty-prefix boundary', () => {
    const journals = envelopeGolden.reconciliation.coverageJournals

    expect(journals.length).toBeGreaterThan(0)

    for (const journal of journals) {
      expect(allocationJournalInitialHash(journal.allocation_uuid, journal.rights_generation)).toBe(
        journal.initial_hash
      )
      expect(journal.emptyPrefixBoundary.accepted_consumption_sequence).toBe(0)
      expect(journal.emptyPrefixBoundary.accepted_consumed_quantity_milli).toBe(0)
      expect(journal.emptyPrefixBoundary.accepted_chain_hash).toBe(journal.initial_hash)

      const entries = journal.entries.map((raw) => ({
        ...toEntry(journal.allocation_uuid, journal.rights_generation, raw),
        entryHash: raw.entry_hash,
        chainHash: raw.chain_hash
      }))

      expect(
        allocationJournalChainHash(journal.allocation_uuid, journal.rights_generation, entries)
      ).toBe(journal.boundary.accepted_chain_hash)
      expect(entries.length).toBe(journal.boundary.accepted_consumption_sequence)
      expect(entries.reduce((total, entry) => total + entry.quantityMilli, 0)).toBe(
        journal.boundary.accepted_consumed_quantity_milli
      )
      expect(isSha256Hex(journal.boundary.accepted_chain_hash)).toBe(true)
    }
  })
})

describe('uuid5 item line derivation', () => {
  it('matches the backend uuid5(NAMESPACE_OID, key#index) values', () => {
    const requestHashGolden = JSON.parse(
      readFileSync(resolve(fixturesDir, 'desktop-invoice-request-hash-golden.json'), 'utf8')
    ) as {
      readonly itemLineUuidNamespace: string
      readonly cases: readonly {
        readonly payload: { readonly idempotency_key: string }
        readonly itemLineUuids: readonly string[]
      }[]
    }

    expect(requestHashGolden.itemLineUuidNamespace).toBe('6ba7b812-9dad-11d1-80b4-00c04fd430c8')

    for (const testCase of requestHashGolden.cases) {
      testCase.itemLineUuids.forEach((expected, index) => {
        expect(allocationItemLineUuid(testCase.payload.idempotency_key, index)).toBe(expected)
      })
    }
  })

  it('produces a well-formed version 5 uuid', () => {
    expect(uuid5Oid('anything')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
  })
})
