import { describe, expect, it } from 'vitest'
import { blockedReasonForQueueState, partitionCandidates } from './preparationDependencies'

/*
 * CP3 — the §7.2 dependency table and partition.
 *
 * The central property: a blocked product must not block an *unrelated* product (§6.8). The
 * secondary one: retained `synced` history must never block anything, because §7.1 forbids any
 * physical-table-emptiness gate — `synced`, `conflict` and `rejected` rows are all retained forever.
 */

const COLA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const WATER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const JUICE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

type CapturedRow = Parameters<typeof partitionCandidates>[0]['capturedRows'][number]

function row(overrides: Partial<CapturedRow>): CapturedRow {
  return {
    localQueueUuid: 'q1',
    queueSequence: 1,
    state: 'pending' as const,
    productUuids: [COLA],
    allocationUuids: [],
    scopeKnown: true,
    ...overrides
  }
}

function partition(
  capturedRows: readonly CapturedRow[],
  extras: Partial<Parameters<typeof partitionCandidates>[0]> = {}
): ReturnType<typeof partitionCandidates> {
  return partitionCandidates({
    candidateProductUuids: [COLA, WATER],
    capturedRows,
    productsOwnedByUnresolvedOperations: new Set<string>(),
    policyDisabledProductUuids: new Set<string>(),
    blockedByUnreleasedHoldProductUuids: new Set<string>(),
    ...extras
  })
}

describe('the §7.2 dependency table', () => {
  it('maps each queue state to its documented effect', () => {
    expect(blockedReasonForQueueState('pending')).toBe('pending_upload')
    expect(blockedReasonForQueueState('uploading')).toBe('uploading_ambiguous')
    expect(blockedReasonForQueueState('retryable_error')).toBe('retryable_error')
    expect(blockedReasonForQueueState('conflict')).toBe('terminal_conflict')
    expect(blockedReasonForQueueState('rejected')).toBe('terminal_rejection')
    // §7.1: retained synced history never blocks. A queue-emptiness gate is not permitted at all.
    expect(blockedReasonForQueueState('synced')).toBeNull()
  })
})

describe('partitioning candidates', () => {
  it('blocks only the touched product and lets an unrelated one through', () => {
    // §6.8 verbatim: Cola holds a terminal conflict, Water has no unresolved dependency.
    const result = partition([row({ state: 'conflict', productUuids: [COLA] })])

    expect(result.eligible).toEqual([WATER])
    expect(result.blocked).toEqual([{ productUuid: COLA, reason: 'terminal_conflict' }])
  })

  it('ignores retained synced history entirely', () => {
    const result = partition([
      row({ state: 'synced', productUuids: [COLA] }),
      row({ localQueueUuid: 'q2', queueSequence: 2, state: 'synced', productUuids: [WATER] })
    ])

    expect(result.eligible).toEqual([COLA, WATER])
    expect(result.blocked).toEqual([])
  })

  it('blocks every candidate when a dependency scope cannot be resolved', () => {
    // §7.2's explicit data-integrity exception: conservatively block this owner and warehouse rather
    // than guess. It must never silently narrow to "no products affected".
    const result = partition([row({ state: 'pending', scopeKnown: false, productUuids: [] })])

    expect(result.eligible).toEqual([])
    expect(result.blocked).toEqual([
      { productUuid: COLA, reason: 'dependency_scope_unknown' },
      { productUuid: WATER, reason: 'dependency_scope_unknown' }
    ])
  })

  it('does not treat an unresolvable synced row as a scope problem', () => {
    // A synced row blocks nothing, so its scope being unknown is not an integrity exception either.
    const result = partition([row({ state: 'synced', scopeKnown: false, productUuids: [] })])

    expect(result.eligible).toEqual([COLA, WATER])
  })

  it('blocks a product already selected by an unresolved operation', () => {
    // §5.6: no new operation may be created for a product an unresolved one already owns. This is
    // what makes repeated clicks and restarts produce no duplicate grant.
    const result = partition([], {
      productsOwnedByUnresolvedOperations: new Set([COLA])
    })

    expect(result.eligible).toEqual([WATER])
    expect(result.blocked).toEqual([{ productUuid: COLA, reason: 'owned_by_unresolved_operation' }])
  })

  it('reports the most actionable reason when several apply', () => {
    // A product can be blocked several ways at once. The reason an operator can actually act on
    // wins, so a terminal conflict is never hidden behind a transient retryable error.
    const result = partitionCandidates({
      candidateProductUuids: [COLA],
      capturedRows: [
        row({ state: 'retryable_error', productUuids: [COLA] }),
        row({ localQueueUuid: 'q2', queueSequence: 2, state: 'conflict', productUuids: [COLA] })
      ],
      productsOwnedByUnresolvedOperations: new Set<string>(),
      policyDisabledProductUuids: new Set<string>(),
      blockedByUnreleasedHoldProductUuids: new Set<string>()
    })

    expect(result.blocked).toEqual([{ productUuid: COLA, reason: 'terminal_conflict' }])
  })

  it('surfaces an exhausted cap as blocked_by_unreleased_hold rather than ordinary scarcity', () => {
    // §10 CP7: a cap exhausted by unreleased holds must be visible, because with release disabled it
    // is not automatically recoverable and retrying can never succeed.
    const result = partition([], {
      blockedByUnreleasedHoldProductUuids: new Set([JUICE, COLA])
    })

    expect(result.blocked).toEqual([{ productUuid: COLA, reason: 'blocked_by_unreleased_hold' }])
    expect(result.eligible).toEqual([WATER])
  })
})
