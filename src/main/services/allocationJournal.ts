import { createHash } from 'crypto'

/**
 * Journal v1 — the byte framing the backend's `StockAllocationJournalService` defines, reimplemented
 * exactly so this app can recompute its own consumption chain and therefore verify a server coverage
 * boundary (BH-04A §3.1) instead of trusting one.
 *
 * Every detail here is load-bearing and pinned by `tests/fixtures/stock-allocation-journal-v1.json`,
 * which is byte-identical to the backend's own copy:
 *
 * - Two different NUL-terminated domain prefixes, so an entry can never be read as an initial hash.
 * - Fields are framed as `<byte length>:<raw bytes>` with no separator. The length is the UTF-8
 *   **byte** count (PHP `strlen`), not the JavaScript UTF-16 code-unit count — they differ for every
 *   non-ASCII character, and `invoice_idempotency_key` is deliberately non-ASCII in the vector.
 * - Chaining concatenates the previous hash decoded from hex to 32 raw bytes, never its hex text.
 * - Integers are plain decimal; uuids and the request hash are lowercased; the idempotency key is
 *   hashed as its exact bytes with no normalization at all.
 */
export const ALLOCATION_JOURNAL_VERSION = 1

const INITIAL_DOMAIN = 'THINIS-STOCK-ALLOCATION-JOURNAL\0'
const ENTRY_DOMAIN = 'THINIS-STOCK-ALLOCATION-CONSUMPTION\0'

export interface AllocationJournalEntry {
  readonly allocationUuid: string
  readonly rightsGeneration: number
  readonly consumptionSequence: number
  readonly localConsumptionUuid: string
  readonly invoiceIdempotencyKey: string
  readonly itemLineUuid: string
  readonly quantityMilli: number
  readonly requestHash: string
}

export interface AllocationJournalHashes {
  readonly entryHash: string
  readonly chainHash: string
}

/** `strlen($value) . ':' . $value` — byte length, not character length. */
function lengthPrefix(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8')

  return Buffer.concat([Buffer.from(`${bytes.byteLength}:`, 'utf8'), bytes])
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

export function allocationJournalInitialHash(
  allocationUuid: string,
  rightsGeneration: number
): string {
  return sha256Hex(
    Buffer.concat([
      Buffer.from(INITIAL_DOMAIN, 'utf8'),
      lengthPrefix(String(ALLOCATION_JOURNAL_VERSION)),
      lengthPrefix(allocationUuid),
      lengthPrefix(String(rightsGeneration))
    ])
  )
}

export function allocationJournalEntryBytes(entry: AllocationJournalEntry): Buffer {
  return Buffer.concat([
    Buffer.from(ENTRY_DOMAIN, 'utf8'),
    lengthPrefix(String(ALLOCATION_JOURNAL_VERSION)),
    lengthPrefix(entry.allocationUuid),
    lengthPrefix(String(entry.rightsGeneration)),
    lengthPrefix(String(entry.consumptionSequence)),
    lengthPrefix(entry.localConsumptionUuid.toLowerCase()),
    lengthPrefix(entry.invoiceIdempotencyKey),
    lengthPrefix(entry.itemLineUuid.toLowerCase()),
    lengthPrefix(String(entry.quantityMilli)),
    lengthPrefix(entry.requestHash.toLowerCase())
  ])
}

export function allocationJournalAppend(
  previousChainHash: string,
  entry: AllocationJournalEntry
): AllocationJournalHashes {
  if (!isSha256Hex(previousChainHash)) {
    throw new Error('The allocation journal previous chain hash is not lowercase sha256 hex')
  }

  const entryBytes = allocationJournalEntryBytes(entry)

  return {
    entryHash: sha256Hex(entryBytes),
    chainHash: sha256Hex(Buffer.concat([Buffer.from(previousChainHash, 'hex'), entryBytes]))
  }
}

/**
 * The chain hash after replaying `entries` from the initial hash. Mirrors the backend's
 * `terminalHash()`: entries must be exactly sequences `1..n` with no gap, and any stored
 * `entryHash`/`chainHash` supplied alongside an entry must match what is recomputed — a stored hash
 * is treated as a cache to be checked, never as evidence in its own right.
 *
 * Throws rather than returning a "best effort" hash. Every caller here treats a throw as
 * unverifiable evidence, which denies spending; it never falls back to a plausible value.
 */
export function allocationJournalChainHash(
  allocationUuid: string,
  rightsGeneration: number,
  entries: readonly (AllocationJournalEntry & {
    readonly entryHash?: string | null
    readonly chainHash?: string | null
  })[]
): string {
  let chainHash = allocationJournalInitialHash(allocationUuid, rightsGeneration)
  let expectedSequence = 1

  for (const entry of entries) {
    if (entry.consumptionSequence !== expectedSequence) {
      throw new Error('The allocation journal contains a sequence gap')
    }
    if (entry.allocationUuid !== allocationUuid || entry.rightsGeneration !== rightsGeneration) {
      throw new Error('The allocation journal contains an entry from another grant identity')
    }

    const next = allocationJournalAppend(chainHash, entry)

    if (
      (entry.entryHash != null && entry.entryHash !== next.entryHash) ||
      (entry.chainHash != null && entry.chainHash !== next.chainHash)
    ) {
      throw new Error('The allocation journal hash is inconsistent')
    }

    chainHash = next.chainHash
    expectedSequence++
  }

  return chainHash
}

/** `6ba7b812-9dad-11d1-80b4-00c04fd430c8` — RFC 4122 namespace OID, hex without dashes. */
const UUID_NAMESPACE_OID = '6ba7b8129dad11d180b400c04fd430c8'

/**
 * RFC 4122 v5 (SHA-1) UUID, matching `Ramsey\Uuid\Uuid::uuid5(Uuid::NAMESPACE_OID, ...)`.
 *
 * Used only for `item_line_uuid`, which the backend derives from `(idempotency_key, zero-based line
 * index)` and never accepts from the client — so this app must derive the identical value to
 * reconstruct a journal entry it never received back over the wire.
 */
export function uuid5Oid(name: string): string {
  const hash = createHash('sha1')
    .update(Buffer.from(UUID_NAMESPACE_OID, 'hex'))
    .update(Buffer.from(name, 'utf8'))
    .digest()

  const bytes = Buffer.from(hash.subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  const hex = bytes.toString('hex')

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** The backend's `item_line_uuid` derivation: `uuid5(NAMESPACE_OID, "<idempotency key>#<index>")`. */
export function allocationItemLineUuid(invoiceIdempotencyKey: string, lineIndex: number): string {
  return uuid5Oid(`${invoiceIdempotencyKey}#${lineIndex}`)
}
