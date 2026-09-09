import { deepEqual, equal, ok } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import type { PreparationRepository } from '../../../src/main/repositories/preparation.repository'
import { PreparationService } from '../../../src/main/services/preparation.service'
import { buildPrepareRequest } from '../../../src/main/services/preparationRequest'
import { databaseTest } from '../support/sandbox'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories } from '../support/realRepositories'
import {
  COMPANY_UUID,
  DEVICE_UUID,
  HASH_64,
  NOW,
  WAREHOUSE_UUID,
  markReconciledCapability
} from '../support/allocationScenario'

/*
 * CP3 — the durable preparation lifecycle against real Electron SQLite.
 *
 * These suites run the actual service against a real on-disk database and a scripted API client.
 * The scenarios are the plan's own: §6.7 (partial discovery cannot close a multi-product
 * operation), §6.8 (a blocked product must not hold back an unrelated eligible one), and §7.2's
 * restart and ambiguity rules.
 */

const OWNER = {
  companyUuid: COMPANY_UUID,
  deviceUuid: DEVICE_UUID,
  warehouseUuid: WAREHOUSE_UUID
}

const COLA = '00000000-0000-4000-8000-0000000000c0'
const WATER = '00000000-0000-4000-8000-0000000000wa'.replace('wa', 'a0')
const JUICE = '00000000-0000-4000-8000-0000000000j0'.replace('j', 'e')

/**
 * Second precision, deliberately. The shipped envelope contract requires it, and the backend emits
 * `toIso8601String()`; a millisecond-precision fixture would parse here while failing in the field.
 */
const WIRE_FAR_FUTURE = '2099-01-01T00:00:00Z'
const WIRE_NOW = '2026-09-09T10:00:00Z'

const COLA_ALLOCATION = '00000000-0000-4000-8000-0000000000f1'
const WATER_ALLOCATION = '00000000-0000-4000-8000-0000000000f2'

interface ScriptedCall {
  readonly body: Record<string, unknown>
}

/** A scripted API client that records every dispatched body, so replay identity is checkable. */
function scriptedClient(responses: (() => Promise<{ data: unknown }>)[]): {
  readonly client: {
    requestWithMeta: (
      route: unknown,
      body: unknown
    ) => Promise<{ data: unknown; meta: Record<string, unknown> }>
    assertRequestPreconditions: () => void
  }
  readonly calls: ScriptedCall[]
} {
  const calls: ScriptedCall[] = []
  let index = 0

  return {
    calls,
    client: {
      assertRequestPreconditions: (): void => {},
      async requestWithMeta(_route: unknown, body: unknown) {
        calls.push({ body: body as Record<string, unknown> })
        const next = responses[Math.min(index, responses.length - 1)]
        index += 1
        const result = await next()

        return { data: result.data, meta: {} }
      }
    }
  }
}

function allocationEnvelope(
  allocationUuid: string,
  productUuid: string,
  operationUuid: string,
  grantedMilli: number,
  serverSequence: number
): Record<string, unknown> {
  return {
    id: allocationUuid,
    contract_version: 1,
    company_uuid: COMPANY_UUID,
    device_uuid: DEVICE_UUID,
    warehouse_uuid: WAREHOUSE_UUID,
    product_uuid: productUuid,
    server_sequence: serverSequence,
    rights_generation: 1,
    lifecycle_generation: 1,
    granted_quantity_milli: grantedMilli,
    consumed_quantity_milli: 0,
    remaining_quantity_milli: grantedMilli,
    consume_until: WIRE_FAR_FUTURE,
    status: 'active',
    envelope_hash: HASH_64,
    seal_nonce: null,
    final_consumption_sequence: null,
    final_consumption_hash: null,
    sealed_at: null,
    acknowledged_at: null,
    released_at: null,
    origin_operation_uuid: operationUuid,
    origin_request_uuid: operationUuid,
    grant_purpose: 'advance_prepare'
  }
}

function productOutcome(
  productUuid: string,
  reason: string,
  grantedMilli: number,
  allocationUuid: string | null
): Record<string, unknown> {
  return {
    product_uuid: productUuid,
    reason,
    granted_quantity_milli: grantedMilli,
    advance_target_milli: 30_000,
    device_hard_cap_milli: 50_000,
    warehouse_budget_milli: 120_000,
    device_held_before_milli: 0,
    warehouse_held_before_milli: 0,
    physical_unreserved_milli: 200_000,
    window_qualified_hold_milli: 0,
    short_lived_hold_milli: 0,
    expired_hold_milli: 0,
    quarantined_hold_milli: 0,
    allocation_uuid: allocationUuid,
    issued_at: allocationUuid === null ? null : WIRE_NOW,
    consume_until: allocationUuid === null ? null : WIRE_FAR_FUTURE,
    blocking_allocation_uuids: []
  }
}

function decisionResponse(params: {
  readonly operationUuid: string
  readonly requestHash: string
  readonly selected: readonly string[]
  readonly products: Record<string, unknown>[]
  readonly allocations: Record<string, unknown>[]
  readonly result?: string
}): { data: unknown } {
  return {
    data: {
      operation_uuid: params.operationUuid,
      request_hash: params.requestHash,
      response_representation_version: 1,
      decision: {
        prepare_contract_version: 1,
        selection_version: 1,
        authority_reference_version: 1,
        requested_policy_revision: 1,
        applied_policy_revision: 1,
        selected_product_uuids: [...params.selected],
        result: params.result ?? 'ready_72h',
        primary_limiting_reason: 'required_window',
        manifest: {
          prepared_at: '2026-09-09T10:00:00.000Z',
          required_duration_seconds: 259_200,
          required_ready_until: '2026-09-12T10:00:00.000Z',
          authority_ready_until: '2026-09-12T10:00:00.000Z',
          actual_supported_seconds: 259_200,
          primary_limiting_reason: 'required_window',
          tied_limiting_reasons: ['required_window'],
          evaluated_guards: [
            { guard: 'required_window', deadline: '2026-09-12T10:00:00.000Z', bounded: true }
          ]
        },
        authority_references: { authority_reference_version: 1, device_uuid: DEVICE_UUID },
        products: params.products
      },
      allocations: params.allocations,
      reconciliation: { observed_at: NOW }
    }
  }
}

function buildService(
  database: ReturnType<typeof openTestDatabase>,
  client: ReturnType<typeof scriptedClient>['client'],
  candidateProducts: readonly string[],
  overrides: Partial<{
    capturedRows: never[]
    ownedProducts: ReadonlySet<string>
  }> = {}
): { readonly service: PreparationService; readonly preparation: PreparationRepository } {
  const { preparation, stockAllocations } = realRepositories(database, () => NOW)

  const service = new PreparationService({
    database,
    preparation,
    stockAllocations,
    apiClient: client as never,
    connectivity: { getSnapshot: () => ({ status: 'online' }) as never },
    candidates: {
      resolveCandidates: () => candidateProducts,
      capturedDependencies: () => overrides.capturedRows ?? [],
      policyDisabledProducts: () => new Set<string>(),
      blockedByUnreleasedHoldProducts: () => new Set<string>(),
      authorityReferences: () => ({
        licenseValidationUuid: null,
        catalogRevision: null,
        requestedPolicyRevision: 1
      }),
      sessionEpoch: () => 1
    },
    now: () => NOW,
    log: () => {}
  })

  return { service, preparation }
}

databaseTest('CP3 a complete decision is applied atomically with its grants', async (sandbox) => {
  const database = openTestDatabase(sandbox)
  markReconciledCapability(database, 5)

  let frozenOperationUuid = ''
  let frozenHash = ''
  const scripted = scriptedClient([
    async () =>
      decisionResponse({
        operationUuid: frozenOperationUuid,
        requestHash: frozenHash,
        selected: [COLA, WATER].sort(),
        products: [
          productOutcome(COLA, 'full', 30_000, COLA_ALLOCATION),
          productOutcome(WATER, 'zero_cap', 0, null)
        ],
        allocations: [allocationEnvelope(COLA_ALLOCATION, COLA, frozenOperationUuid, 30_000, 1501)],
        result: 'partial_quantity'
      })
  ])

  const { service, preparation } = buildService(database, scripted.client, [COLA, WATER])

  // The operation UUID and hash are generated inside the cycle, so the scripted response is built
  // lazily from what was actually frozen — the test never assumes the identity.
  const originalRequest = scripted.client.requestWithMeta.bind(scripted.client)
  scripted.client.requestWithMeta = async (route: unknown, body: unknown) => {
    const typed = body as { operation_uuid: string; product_uuids: string[] }
    frozenOperationUuid = typed.operation_uuid
    frozenHash = buildPrepareRequest({
      operationUuid: typed.operation_uuid,
      requestedPolicyRevision: 1,
      productUuids: typed.product_uuids,
      licenseValidationUuid: null,
      catalogRevision: null
    }).requestHash

    return originalRequest(route, body)
  }

  const outcome = await service.runCycle(OWNER)

  equal(outcome.kind, 'applied')

  const operation = preparation.findOperation(frozenOperationUuid)
  ok(operation)
  equal(operation.state, 'applied')
  equal(operation.result, 'partial_quantity')
  // §8.5: the countdown anchors are the server's, stored verbatim — never `now`-derived.
  equal(operation.preparedAt, '2026-09-09T10:00:00.000Z')
  equal(operation.authorityReadyUntil, '2026-09-12T10:00:00.000Z')

  // One decision per selected product, *including* the zero. The grant count and the decision count
  // deliberately differ, which is the whole point of §5.4.
  const outcomes = preparation.outcomes(frozenOperationUuid)
  equal(outcomes.length, 2)
  deepEqual(outcomes.map((entry) => entry.reason).sort(), ['full', 'zero_cap'])

  equal(
    (
      database.prepare('SELECT COUNT(*) AS total FROM stock_allocation_grants').get() as {
        total: number
      }
    ).total,
    1
  )
  closeDatabase(database)
})

databaseTest(
  'CP3 partial discovery never closes a multi-product operation, and its grants stay spendable',
  async (sandbox) => {
    // §6.7 verbatim: three selected products, one grant returned, no decision. The grant must be
    // ingested and spendable; the operation must NOT close.
    const database = openTestDatabase(sandbox)
    markReconciledCapability(database, 5)

    let frozenOperationUuid = ''
    const scripted = scriptedClient([
      async () => ({
        data: {
          operation_uuid: frozenOperationUuid,
          request_hash: HASH_64,
          response_representation_version: 1,
          decision: {
            prepare_contract_version: 1,
            selection_version: 1,
            authority_reference_version: 1,
            requested_policy_revision: 1,
            applied_policy_revision: 1,
            // Deliberately truncated: only one of the three selected products carries a decision.
            selected_product_uuids: [COLA],
            result: 'ready_72h',
            primary_limiting_reason: 'required_window',
            manifest: {
              prepared_at: '2026-09-09T10:00:00.000Z',
              required_duration_seconds: 259_200,
              required_ready_until: '2026-09-12T10:00:00.000Z',
              authority_ready_until: '2026-09-12T10:00:00.000Z',
              actual_supported_seconds: 259_200,
              primary_limiting_reason: 'required_window',
              tied_limiting_reasons: ['required_window'],
              evaluated_guards: [
                { guard: 'required_window', deadline: '2026-09-12T10:00:00.000Z', bounded: true }
              ]
            },
            authority_references: { authority_reference_version: 1 },
            products: [productOutcome(COLA, 'full', 40_000, COLA_ALLOCATION)]
          },
          allocations: [
            allocationEnvelope(COLA_ALLOCATION, COLA, frozenOperationUuid, 40_000, 1501)
          ],
          reconciliation: {}
        }
      })
    ])

    const { service, preparation } = buildService(database, scripted.client, [COLA, WATER, JUICE])
    const original = scripted.client.requestWithMeta.bind(scripted.client)
    scripted.client.requestWithMeta = async (route: unknown, body: unknown) => {
      frozenOperationUuid = (body as { operation_uuid: string }).operation_uuid
      return original(route, body)
    }

    const outcome = await service.runCycle(OWNER)

    // Not applied. The selected set does not match, so the completeness predicate refuses.
    equal(outcome.kind, 'discovered_pending_replay')

    const operation = preparation.findOperation(frozenOperationUuid)
    ok(operation)
    equal(operation.state, 'discovered_pending_replay')
    equal(operation.appliedAt, null)
    equal(operation.result, null)

    // The grant is nonetheless ingested and spendable: §5.4 keeps "grant ingested" and "decision
    // applied" strictly apart, and withholding real authority because the operation is unresolved
    // would strand stock the server has already committed.
    equal(
      (
        database
          .prepare(
            'SELECT COUNT(*) AS total FROM stock_allocation_grants WHERE allocation_uuid = ?'
          )
          .get(COLA_ALLOCATION) as { total: number }
      ).total,
      1
    )

    // And no new operation may be created for any of its selected products while it is unresolved.
    const owned = preparation.productsOwnedByUnresolvedOperations(OWNER)
    ok(owned.has(COLA))
    ok(owned.has(WATER))
    ok(owned.has(JUICE))
    closeDatabase(database)
  }
)

databaseTest(
  'CP3 a blocked product does not prevent an unrelated eligible product from being prepared',
  async (sandbox) => {
    // §6.8: Cola is held by a terminal invoice conflict; Water has no unresolved dependency at all.
    const database = openTestDatabase(sandbox)
    markReconciledCapability(database, 5)

    let frozenOperationUuid = ''
    let frozenHash = ''
    const scripted = scriptedClient([
      async () =>
        decisionResponse({
          operationUuid: frozenOperationUuid,
          requestHash: frozenHash,
          selected: [WATER],
          products: [productOutcome(WATER, 'full', 30_000, WATER_ALLOCATION)],
          allocations: [
            allocationEnvelope(WATER_ALLOCATION, WATER, frozenOperationUuid, 30_000, 1501)
          ]
        })
    ])

    const { preparation, stockAllocations } = realRepositories(database, () => NOW)
    const service = new PreparationService({
      database,
      preparation,
      stockAllocations,
      apiClient: scripted.client as never,
      connectivity: { getSnapshot: () => ({ status: 'online' }) as never },
      candidates: {
        resolveCandidates: () => [COLA, WATER],
        capturedDependencies: () => [
          {
            localQueueUuid: '00000000-0000-4000-8000-000000000991',
            queueSequence: 1,
            state: 'conflict',
            productUuids: [COLA],
            allocationUuids: [],
            scopeKnown: true
          }
        ],
        policyDisabledProducts: () => new Set<string>(),
        blockedByUnreleasedHoldProducts: () => new Set<string>(),
        authorityReferences: () => ({
          licenseValidationUuid: null,
          catalogRevision: null,
          requestedPolicyRevision: 1
        }),
        sessionEpoch: () => 1
      },
      now: () => NOW,
      log: () => {}
    })

    const original = scripted.client.requestWithMeta.bind(scripted.client)
    scripted.client.requestWithMeta = async (route: unknown, body: unknown) => {
      const typed = body as { operation_uuid: string; product_uuids: string[] }
      frozenOperationUuid = typed.operation_uuid
      frozenHash = buildPrepareRequest({
        operationUuid: typed.operation_uuid,
        requestedPolicyRevision: 1,
        productUuids: typed.product_uuids,
        licenseValidationUuid: null,
        catalogRevision: null
      }).requestHash

      return original(route, body)
    }

    const outcome = await service.runCycle(OWNER)

    equal(outcome.kind, 'applied')

    // Only Water was sent. Cola never occupied a slot in the frozen request.
    deepEqual(scripted.calls[0]?.body.product_uuids, [WATER])

    const operation = preparation.findOperation(frozenOperationUuid)
    ok(operation)
    deepEqual([...operation.selectedProductUuids], [WATER])

    // Cola is recorded as blocked with its reason, as cycle state — never as part of the request.
    const cycle = preparation.findCycle(operation.cycleUuid)
    ok(cycle)
    const products = preparation.cycleProducts(cycle.cycleUuid)
    const cola = products.find((entry) => entry.productUuid === COLA)
    ok(cola)
    equal(cola.disposition, 'blocked')
    equal(cola.blockedReason, 'terminal_conflict')
    closeDatabase(database)
  }
)

databaseTest(
  'CP3 an ambiguous outcome is replayed with identical bytes after a restart',
  async (sandbox) => {
    const database = openTestDatabase(sandbox)
    markReconciledCapability(database, 5)

    // First run: the transport fails after dispatch began. Ambiguity is the default classification.
    const failing = scriptedClient([
      async () => {
        throw Object.assign(new Error('connection reset'), { status: 503 })
      }
    ])
    const first = buildService(database, failing.client, [COLA])

    const firstOutcome = await first.service.runCycle(OWNER)
    equal(firstOutcome.kind, 'ambiguous')

    const operationUuid = (failing.calls[0]?.body as { operation_uuid: string }).operation_uuid
    const dispatchedBody = failing.calls[0]?.body
    const stored = first.preparation.findOperation(operationUuid)
    ok(stored)
    equal(stored.state, 'ambiguous')
    // Written before the request left, which is what makes the classification honest after a crash.
    ok(stored.dispatchStartedAt !== null)

    closeDatabase(database)

    // ---- Restart: a brand-new process and a brand-new connection to the same on-disk database ----
    const reopened = openTestDatabase(sandbox)
    const replay = scriptedClient([
      async () =>
        decisionResponse({
          operationUuid,
          requestHash: stored.requestHash,
          selected: [COLA],
          products: [productOutcome(COLA, 'full', 30_000, COLA_ALLOCATION)],
          allocations: [allocationEnvelope(COLA_ALLOCATION, COLA, operationUuid, 30_000, 1501)]
        })
    ])
    const second = buildService(reopened, replay.client, [COLA])

    const secondOutcome = await second.service.runCycle(OWNER)

    equal(secondOutcome.kind, 'applied')
    equal(secondOutcome.operationUuid, operationUuid)

    // §7.2: recovery replays the stored bytes verbatim. Identical identity, identical body — never
    // re-partitioned, re-frozen, or re-hashed, however much local state has moved on.
    deepEqual(replay.calls[0]?.body, dispatchedBody)

    // Exactly one grant set, and exactly one operation, across both runs.
    equal(
      (
        reopened.prepare('SELECT COUNT(*) AS total FROM stock_allocation_grants').get() as {
          total: number
        }
      ).total,
      1
    )
    equal(
      (
        reopened.prepare('SELECT COUNT(*) AS total FROM prepare_operations').get() as {
          total: number
        }
      ).total,
      1
    )
    closeDatabase(reopened)
  }
)

databaseTest(
  'CP3 a stale policy revision is terminal and creates no local authority',
  async (sandbox) => {
    const database = openTestDatabase(sandbox)
    markReconciledCapability(database, 5)

    const scripted = scriptedClient([
      async () => {
        throw Object.assign(new Error('stale'), { code: 'POLICY_REVISION_STALE', status: 409 })
      }
    ])
    const { service, preparation } = buildService(database, scripted.client, [COLA])

    const outcome = await service.runCycle(OWNER)

    equal(outcome.kind, 'superseded_uncommitted')

    const operationUuid = (scripted.calls[0]?.body as { operation_uuid: string }).operation_uuid
    const operation = preparation.findOperation(operationUuid)
    ok(operation)
    // §5.6: the server proved no operation and no grant were created, so this is honest and terminal
    // — there is genuinely nothing to reconcile, and a new cycle may follow immediately.
    equal(operation.state, 'superseded_uncommitted')
    equal(
      (
        database.prepare('SELECT COUNT(*) AS total FROM stock_allocation_grants').get() as {
          total: number
        }
      ).total,
      0
    )
    equal(preparation.productsOwnedByUnresolvedOperations(OWNER).size, 0)
    closeDatabase(database)
  }
)

databaseTest(
  'CP3 repeated cycles never create a second operation for an owned product',
  async (sandbox) => {
    const database = openTestDatabase(sandbox)
    markReconciledCapability(database, 5)

    const scripted = scriptedClient([
      async () => {
        throw Object.assign(new Error('timeout'), { status: 504 })
      }
    ])
    const { service, preparation } = buildService(database, scripted.client, [COLA])

    equal((await service.runCycle(OWNER)).kind, 'ambiguous')

    // §6.8: repeated clicks reach a main process that already has an operation for this product.
    // At best a click retries the identical frozen request under the identical identity.
    equal((await service.runCycle(OWNER)).kind, 'ambiguous')
    equal((await service.runCycle(OWNER)).kind, 'ambiguous')

    equal(
      (
        database.prepare('SELECT COUNT(*) AS total FROM prepare_operations').get() as {
          total: number
        }
      ).total,
      1
    )
    const bodies = scripted.calls.map((call) => JSON.stringify(call.body))
    equal(new Set(bodies).size, 1, 'every retry must send byte-identical request bodies')
    equal(preparation.unresolvedOperations(OWNER).length, 1)
    closeDatabase(database)
  }
)

databaseTest(
  'CP3 an empty eligible set blocks the cycle and dispatches nothing',
  async (sandbox) => {
    const database = openTestDatabase(sandbox)
    markReconciledCapability(database, 5)

    const scripted = scriptedClient([
      async () => {
        throw new Error('the cycle must not dispatch')
      }
    ])
    const { preparation, stockAllocations } = realRepositories(database, () => NOW)
    const service = new PreparationService({
      database,
      preparation,
      stockAllocations,
      apiClient: scripted.client as never,
      connectivity: { getSnapshot: () => ({ status: 'online' }) as never },
      candidates: {
        resolveCandidates: () => [COLA],
        capturedDependencies: () => [
          {
            localQueueUuid: '00000000-0000-4000-8000-000000000992',
            queueSequence: 1,
            state: 'rejected',
            productUuids: [COLA],
            allocationUuids: [],
            scopeKnown: true
          }
        ],
        policyDisabledProducts: () => new Set<string>(),
        blockedByUnreleasedHoldProducts: () => new Set<string>(),
        authorityReferences: () => ({
          licenseValidationUuid: null,
          catalogRevision: null,
          requestedPolicyRevision: 1
        }),
        sessionEpoch: () => 1
      },
      now: () => NOW,
      log: () => {}
    })

    const outcome = await service.runCycle(OWNER)

    equal(outcome.kind, 'blocked')
    equal(scripted.calls.length, 0)
    // A blocked cycle is a persisted terminal outcome with its reasons — not a failure, and not a
    // reason to loop or mint a new operation (§4.4).
    equal(
      (
        database.prepare('SELECT COUNT(*) AS total FROM prepare_operations').get() as {
          total: number
        }
      ).total,
      0
    )
    equal(
      (
        database
          .prepare(`SELECT COUNT(*) AS total FROM prepare_cycles WHERE state = 'blocked'`)
          .get() as { total: number }
      ).total,
      1
    )
    closeDatabase(database)
  }
)
