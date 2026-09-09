import { describe, expect, it } from 'vitest'
import type { PrepareOperationResource } from '../http/desktopResources.contract'
import type { PrepareOperationRow } from '../repositories/preparation.repository'
import { discoveryCanCompleteOperation, evaluateCompleteness } from './preparationCompleteness'

/*
 * CP3 — the §5.4 completeness predicate.
 *
 * Most of these cases are *negative*: they pin the forbidden inferences §5.4 lists by name.
 * Completeness must never be fabricated from matching quantities, a single `origin_operation_uuid`,
 * a grant count equal to the selected-product count, an envelope with no further grants, elapsed
 * time, or operator assertion. Absence of evidence is never evidence of a zero outcome.
 */

const OPERATION_UUID = '11111111-1111-4111-8111-111111111111'
const HASH = 'a'.repeat(64)
const COLA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const WATER = 'wwwwwwww-wwww-4www-8www-wwwwwwwwwwww'.replace(/w/g, 'd')
const JUICE = 'jjjjjjjj-jjjj-4jjj-8jjj-jjjjjjjjjjjj'.replace(/j/g, 'e')
const COLA_ALLOCATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const WATER_ALLOCATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'

function operation(overrides: Partial<PrepareOperationRow> = {}): PrepareOperationRow {
  return {
    operationUuid: OPERATION_UUID,
    cycleUuid: '22222222-2222-4222-8222-222222222222',
    companyUuid: 'company',
    deviceUuid: 'device',
    warehouseUuid: 'warehouse',
    requestedPolicyRevision: 1,
    canonicalRequestJson: '{}',
    requestHash: HASH,
    selectedProductUuids: [COLA, WATER, JUICE],
    capturedSessionEpoch: 1,
    state: 'ambiguous',
    dispatchStartedAt: '2026-09-09T10:00:00Z',
    preparedAt: null,
    requiredDurationSeconds: null,
    requiredReadyUntil: null,
    authorityReadyUntil: null,
    result: null,
    primaryLimitingReason: null,
    appliedPolicyRevision: null,
    manifestJson: null,
    authorityReferencesJson: null,
    conflictReason: null,
    capturedAt: '2026-09-09T10:00:00Z',
    appliedAt: null,
    ...overrides
  }
}

function product(
  productUuid: string,
  reason: string,
  grantedMilli: number,
  allocationUuid: string | null
): PrepareOperationResource['decision']['products'][number] {
  return {
    product_uuid: productUuid,
    reason: reason as never,
    granted_quantity_milli: grantedMilli,
    advance_target_milli: 30_000,
    device_hard_cap_milli: 50_000,
    warehouse_budget_milli: 120_000,
    device_held_before_milli: 0,
    warehouse_held_before_milli: 0,
    physical_unreserved_milli: 100_000,
    window_qualified_hold_milli: 0,
    short_lived_hold_milli: 0,
    expired_hold_milli: 0,
    quarantined_hold_milli: 0,
    allocation_uuid: allocationUuid,
    issued_at: allocationUuid === null ? null : '2026-09-09T10:00:00Z',
    consume_until: allocationUuid === null ? null : '2026-09-12T10:00:00Z',
    blocking_allocation_uuids: []
  }
}

function response(
  overrides: Partial<PrepareOperationResource['decision']> = {},
  top: Partial<PrepareOperationResource> = {}
): PrepareOperationResource {
  return {
    operation_uuid: OPERATION_UUID,
    request_hash: HASH,
    response_representation_version: 1,
    decision: {
      prepare_contract_version: 1,
      selection_version: 1,
      authority_reference_version: 1,
      requested_policy_revision: 1,
      applied_policy_revision: 1,
      selected_product_uuids: [COLA, WATER, JUICE],
      result: 'partial_quantity',
      primary_limiting_reason: 'zero_cap',
      manifest: {
        prepared_at: '2026-09-09T10:00:00Z',
        required_duration_seconds: 259_200,
        required_ready_until: '2026-09-12T10:00:00Z',
        authority_ready_until: '2026-09-12T10:00:00Z',
        actual_supported_seconds: 259_200,
        primary_limiting_reason: 'required_window',
        tied_limiting_reasons: ['required_window'],
        evaluated_guards: [
          { guard: 'required_window', deadline: '2026-09-12T10:00:00Z', bounded: true }
        ]
      },
      authority_references: { authority_reference_version: 1 },
      // §6.7's exact decision: Cola full, Water partial, Juice an explicit zero with no row.
      products: [
        product(COLA, 'full', 40_000, COLA_ALLOCATION),
        product(WATER, 'partial_stock', 12_000, WATER_ALLOCATION),
        product(JUICE, 'zero_cap', 0, null)
      ],
      ...overrides
    },
    allocations: [],
    reconciliation: {},
    ...top
  } as PrepareOperationResource
}

const bothIngested = [COLA_ALLOCATION, WATER_ALLOCATION]

describe('the §5.4 completeness predicate', () => {
  it('accepts a decision that carries every selected product, including the zero', () => {
    expect(
      evaluateCompleteness({
        operation: operation(),
        response: response(),
        discoveredAllocationUuids: [COLA_ALLOCATION],
        ingestedAllocationUuids: bothIngested
      })
    ).toEqual({ kind: 'complete' })
  })

  it('refuses a decision whose operation identity or request hash differs', () => {
    expect(
      evaluateCompleteness({
        operation: operation(),
        response: response({}, { operation_uuid: '99999999-9999-4999-8999-999999999999' }),
        discoveredAllocationUuids: [],
        ingestedAllocationUuids: bothIngested
      })
    ).toEqual({ kind: 'incomplete', failure: 'operation-identity-mismatch' })

    expect(
      evaluateCompleteness({
        operation: operation(),
        response: response({}, { request_hash: 'b'.repeat(64) }),
        discoveredAllocationUuids: [],
        ingestedAllocationUuids: bothIngested
      })
    ).toEqual({ kind: 'incomplete', failure: 'request-hash-mismatch' })
  })

  it('refuses a truncated selected set', () => {
    expect(
      evaluateCompleteness({
        operation: operation(),
        response: response({ selected_product_uuids: [COLA] }),
        discoveredAllocationUuids: [],
        ingestedAllocationUuids: bothIngested
      })
    ).toEqual({ kind: 'incomplete', failure: 'selected-set-mismatch' })
  })

  it('treats a missing product decision as missing, never as a zero', () => {
    // §6.7: an undiscovered grant and an explicit `zero_cap` are indistinguishable from a discovery
    // channel alone. Reading absence as zero would silently convert Water's 12 real units into an
    // assumed zero and let a later cycle re-request Juice against a cap the server already charged.
    expect(
      evaluateCompleteness({
        operation: operation(),
        response: response({
          products: [
            product(COLA, 'full', 40_000, COLA_ALLOCATION),
            product(WATER, 'partial_stock', 12_000, WATER_ALLOCATION)
          ]
        }),
        discoveredAllocationUuids: [],
        ingestedAllocationUuids: bothIngested
      })
    ).toEqual({ kind: 'incomplete', failure: 'missing-product-decision' })
  })

  it('refuses a decision whose grant linkage is inconsistent in either direction', () => {
    // A non-zero outcome with no allocation named.
    expect(
      evaluateCompleteness({
        operation: operation(),
        response: response({
          products: [
            product(COLA, 'full', 40_000, null),
            product(WATER, 'partial_stock', 12_000, WATER_ALLOCATION),
            product(JUICE, 'zero_cap', 0, null)
          ]
        }),
        discoveredAllocationUuids: [],
        ingestedAllocationUuids: bothIngested
      })
    ).toEqual({ kind: 'incomplete', failure: 'incomplete-grant-linkage' })

    // ...and a decision naming a grant this application is not actually ingesting. Closing that
    // operation would mean closing one whose authority was never applied.
    expect(
      evaluateCompleteness({
        operation: operation(),
        response: response(),
        discoveredAllocationUuids: [],
        ingestedAllocationUuids: [COLA_ALLOCATION]
      })
    ).toEqual({ kind: 'incomplete', failure: 'incomplete-grant-linkage' })
  })

  it('refuses when a locally discovered grant is absent from the decision', () => {
    // The client is looking at a truncated view, not a complete one.
    expect(
      evaluateCompleteness({
        operation: operation(),
        response: response(),
        discoveredAllocationUuids: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9'],
        ingestedAllocationUuids: bothIngested
      })
    ).toEqual({ kind: 'incomplete', failure: 'undiscovered-grant-not-in-decision' })
  })

  it('refuses a decision with no manifest, or one whose window claims more than it measured', () => {
    expect(
      evaluateCompleteness({
        operation: operation(),
        response: response({
          manifest: { ...response().decision.manifest, evaluated_guards: [] }
        }),
        discoveredAllocationUuids: [],
        ingestedAllocationUuids: bothIngested
      })
    ).toEqual({ kind: 'incomplete', failure: 'missing-manifest' })

    // `authority_ready_until` is a MIN that includes the requested window, so it can never exceed
    // `required_ready_until`. A response claiming otherwise is not a longer window; it is invalid.
    expect(
      evaluateCompleteness({
        operation: operation(),
        response: response({
          manifest: {
            ...response().decision.manifest,
            authority_ready_until: '2099-01-01T00:00:00Z'
          }
        }),
        discoveredAllocationUuids: [],
        ingestedAllocationUuids: bothIngested
      })
    ).toEqual({ kind: 'incomplete', failure: 'missing-manifest' })
  })

  it('refuses a decision with no authority references', () => {
    expect(
      evaluateCompleteness({
        operation: operation(),
        response: response({ authority_references: {} }),
        discoveredAllocationUuids: [],
        ingestedAllocationUuids: bothIngested
      })
    ).toEqual({ kind: 'incomplete', failure: 'unresolvable-authority-reference' })
  })

  it('cannot be satisfied by any forbidden inference', () => {
    // A single-product operation, one returned grant, matching quantities — the exact coincidence
    // §5.4 warns about, and §6.2 works through. The grant is spendable; the operation is not closed
    // by it, and only an authoritative replay carrying the decision can close it.
    const single = operation({ selectedProductUuids: [COLA] })

    expect(discoveryCanCompleteOperation()).toBe(false)

    // No decision at all, however suggestive the grant is.
    expect(
      evaluateCompleteness({
        operation: single,
        response: response({ selected_product_uuids: [COLA], products: [] }),
        discoveredAllocationUuids: [COLA_ALLOCATION],
        ingestedAllocationUuids: [COLA_ALLOCATION]
      })
    ).toEqual({ kind: 'incomplete', failure: 'missing-product-decision' })

    // A grant count equal to the selected-product count is likewise not completeness.
    expect(
      evaluateCompleteness({
        operation: operation(),
        response: response({
          products: [
            product(COLA, 'full', 40_000, COLA_ALLOCATION),
            product(WATER, 'partial_stock', 12_000, WATER_ALLOCATION),
            product(JUICE, 'zero_cap', 0, null)
          ],
          selected_product_uuids: [COLA, WATER]
        }),
        discoveredAllocationUuids: [],
        ingestedAllocationUuids: bothIngested
      })
    ).toEqual({ kind: 'incomplete', failure: 'selected-set-mismatch' })
  })
})
