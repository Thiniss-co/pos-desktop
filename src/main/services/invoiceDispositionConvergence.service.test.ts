import { describe, expect, it, vi } from 'vitest'
import type { SyncStatusEntry } from '@shared/contracts/dispositionDiscovery.contract'
import { fetchDispositionStatuses, syncStatusRoute } from '../sync/dispositionStatus.client'
import { InvoiceDispositionConvergenceService } from './invoiceDispositionConvergence.service'
import {
  type DispositionCandidate,
  type InvoiceDispositionDiscoveryService,
  phpJsonEncode
} from './invoiceDispositionDiscovery.service'

const OWNER = { companyUuid: 'company-1', deviceUuid: 'device-1' }

function candidate(index: number): DispositionCandidate {
  return {
    invoiceLocalUuid: `invoice-${index}`,
    idempotencyKey: `key-${index}`,
    localQueueUuid: `queue-${index}`,
    payloadJson: '{}',
    payloadHash: 'a'.repeat(64),
    quarantineReason: 'allocation_sequence_gap',
    queueFailureJson: '{}'
  }
}

function discovery(candidates: DispositionCandidate[]): Pick<
  InvoiceDispositionDiscoveryService,
  'findCandidates' | 'apply'
> & {
  apply: ReturnType<typeof vi.fn>
} {
  return {
    findCandidates: vi.fn(() => candidates),
    apply: vi.fn((_owner, row: DispositionCandidate) => ({
      kind: 'applied' as const,
      invoiceLocalUuid: row.invoiceLocalUuid
    }))
  }
}

function statuses(
  entries: Array<Partial<SyncStatusEntry> & { idempotency_key: string }>
): ReadonlyMap<string, SyncStatusEntry> {
  return new Map(
    entries.map((entry) => [entry.idempotency_key, { status: 'quarantined', ...entry } as never])
  )
}

describe('phpJsonEncode', () => {
  it("matches PHP json_encode's default escaping byte for byte", () => {
    // Captured from `php -r 'echo bin2hex(json_encode([...]))'` (PHP 8): `/` and every non-ASCII
    // code unit are escaped, DEL is not, and key order is the caller's.
    const php =
      '7b2273223a22504f535c2f323032365c2f30303031222c2275223a225c75303065395c75643833645c7564653030222c2263223a22615c753030316662222c2271223a225c225c5c222c2264223a227f222c226e223a5b312c302c2d335d2c2265223a5b5d2c227a223a6e756c6c2c2274223a66616c73657d'

    const encoded = phpJsonEncode({
      s: 'POS/2026/0001',
      u: 'é😀',
      c: 'a\u001fb',
      q: '"\\',
      d: '\u007f',
      n: [1, 0, -3],
      e: [],
      z: null,
      t: false
    })

    expect(Buffer.from(encoded, 'utf8').toString('hex')).toBe(php)
  })
})

describe('PS5b sync-status client', () => {
  it('asks for exactly the given keys as idempotency_keys[] query parameters', () => {
    expect(syncStatusRoute(['k1', 'k 2']).path).toBe(
      '/invoices/sync-status?idempotency_keys%5B%5D=k1&idempotency_keys%5B%5D=k+2'
    )
    expect(syncStatusRoute(['k1']).method).toBe('GET')
  })

  it('refuses an answer that omits, repeats or invents a key', async () => {
    for (const answer of [
      { statuses: [{ idempotency_key: 'k1', status: 'not_found' }] },
      {
        statuses: [
          { idempotency_key: 'k1', status: 'not_found' },
          { idempotency_key: 'k1', status: 'not_found' }
        ]
      },
      {
        statuses: [
          { idempotency_key: 'k1', status: 'not_found' },
          { idempotency_key: 'zz', status: 'not_found' }
        ]
      },
      { nothing: true }
    ]) {
      await expect(
        fetchDispositionStatuses({ request: vi.fn().mockResolvedValue(answer) }, ['k1', 'k2'])
      ).rejects.toMatchObject({ backendCode: 'DESKTOP_SYNC_STATUS_ANSWER_INVALID' })
    }
  })

  it('leaves each disposition unparsed for the strict per-invoice verification', async () => {
    const malformed = { id: 'x', whatever: true }
    const entries = await fetchDispositionStatuses(
      {
        request: vi.fn().mockResolvedValue({
          statuses: [{ idempotency_key: 'k1', status: 'processed', disposition: malformed }]
        })
      },
      ['k1']
    )

    expect(entries.get('k1')?.disposition).toBe(malformed)
  })

  it('never sends an empty or oversized batch', async () => {
    const request = vi.fn()

    await expect(fetchDispositionStatuses({ request }, [])).rejects.toThrow()
    await expect(
      fetchDispositionStatuses(
        { request },
        Array.from({ length: 51 }, (_, index) => `k${index}`)
      )
    ).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  })
})

describe('PS6b convergence run', () => {
  it('sends no request when nothing is eligible or no owner is resolved', async () => {
    const fetchStatuses = vi.fn()

    await new InvoiceDispositionConvergenceService({
      discovery: discovery([]),
      fetchStatuses,
      owner: () => OWNER
    }).run()
    await new InvoiceDispositionConvergenceService({
      discovery: discovery([candidate(1)]),
      fetchStatuses,
      owner: () => null
    }).run()

    expect(fetchStatuses).not.toHaveBeenCalled()
  })

  it('applies only decided entries; undecided, not_found and missing entries change nothing', async () => {
    const rows = [candidate(1), candidate(2), candidate(3)]
    const found = discovery(rows)
    const onConverged = vi.fn()

    const summary = await new InvoiceDispositionConvergenceService({
      discovery: found,
      fetchStatuses: vi.fn().mockResolvedValue(
        statuses([
          { idempotency_key: 'key-1', status: 'processed', disposition: { id: 'd1' } as never },
          { idempotency_key: 'key-2', status: 'quarantined', disposition: null },
          { idempotency_key: 'key-3', status: 'not_found' }
        ])
      ),
      owner: () => OWNER,
      onConverged
    }).run()

    expect(found.apply).toHaveBeenCalledTimes(1)
    expect(found.apply.mock.calls[0][1]).toBe(rows[0])
    expect(summary).toMatchObject({ asked: 3, undecided: 2, applied: 1, conflicts: 0 })
    expect(onConverged).toHaveBeenCalledTimes(1)
  })

  it('writes nothing when the read fails, so the next trigger simply asks again', async () => {
    const found = discovery([candidate(1)])
    const service = new InvoiceDispositionConvergenceService({
      discovery: found,
      fetchStatuses: vi.fn().mockRejectedValue(new Error('offline')),
      owner: () => OWNER
    })

    await expect(service.run()).rejects.toThrow('offline')
    expect(found.apply).not.toHaveBeenCalled()
  })

  it('applies nothing when the session changed while the read was in flight', async () => {
    const found = discovery([candidate(1)])
    let owner: typeof OWNER | null = OWNER

    const summary = await new InvoiceDispositionConvergenceService({
      discovery: found,
      fetchStatuses: vi.fn(async () => {
        owner = { companyUuid: 'company-1', deviceUuid: 'another-device' }

        return statuses([{ idempotency_key: 'key-1', disposition: { id: 'd1' } as never }])
      }),
      owner: () => owner
    }).run()

    expect(found.apply).not.toHaveBeenCalled()
    expect(summary.applied).toBe(0)
  })

  it('asks about at most 50 rows and paces each row, so a stuck backlog cannot starve newer rows', async () => {
    const rows = Array.from({ length: 60 }, (_, index) => candidate(index))
    let clock = 0
    const asked: string[][] = []
    const service = new InvoiceDispositionConvergenceService({
      discovery: discovery(rows),
      fetchStatuses: vi.fn(async (keys: readonly string[]) => {
        asked.push([...keys])

        return statuses(keys.map((key) => ({ idempotency_key: key, disposition: null })))
      }),
      owner: () => OWNER,
      perRowIntervalMs: 1000,
      now: () => clock
    })

    await service.run()
    await service.run()
    clock = 1000
    await service.run()

    expect(asked[0]).toHaveLength(50)
    expect(asked[1]).toEqual(rows.slice(50).map((row) => row.idempotencyKey))
    expect(asked[2]).toEqual(rows.slice(0, 50).map((row) => row.idempotencyKey))
  })
})
