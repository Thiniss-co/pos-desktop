import type { PrepareOperationResource } from '../http/desktopResources.contract'
import type { PrepareOperationRow } from '../repositories/preparation.repository'

/**
 * CP3 — the §5.4 completeness predicate.
 *
 * This is the single gate an operation must pass to reach `applied`. It is pure and takes no
 * database and no clock, so it can be exercised exhaustively, and so that no part of it can be
 * accidentally satisfied by a side effect.
 *
 * ## Why it exists
 *
 * §5.4 names two truths that must never be conflated:
 *
 *  - **Grant ingested** — a per-allocation fact. Safe on its own; an ingested grant is spendable
 *    under the ordinary rules whether or not its operation is complete.
 *  - **Decision applied** — a per-operation fact, and the only one that closes an operation.
 *
 * Ingesting a grant never establishes the second. One operation may select many products and may
 * legitimately end in a zero outcome for any subset of them, and **every zero outcome creates no
 * allocation row at all**. A discovery channel that returns allocations therefore cannot, even in
 * principle, carry the zero half of a decision — which is why only an authoritative replay can
 * close an operation, and why this predicate can never be satisfied by counting grants.
 *
 * ## Forbidden inferences (§5.4)
 *
 * Completeness must never be fabricated from: quantities that happen to match the target; finding
 * one `origin_operation_uuid`; a grant count equal to the selected-product count; a bootstrap
 * envelope that merely contains no *further* grants; elapsed time; or operator assertion. **Absence
 * of evidence is never evidence of a zero outcome.**
 *
 * §6.7 is the concrete damage: an operation selecting Cola, Water and Juice, where Cola and Water
 * were granted and Juice was an explicit `zero_cap`. If bootstrap reveals only Cola's grant, then
 * treating absence as zero would silently convert Water's 12 real units into an assumed zero *and*
 * let a later cycle re-request Juice against a cap the server has already charged.
 */

export type CompletenessFailure =
  | 'operation-identity-mismatch'
  | 'request-hash-mismatch'
  | 'selected-set-mismatch'
  | 'missing-product-decision'
  | 'incomplete-grant-linkage'
  | 'undiscovered-grant-not-in-decision'
  | 'missing-manifest'
  | 'unresolvable-authority-reference'

export type CompletenessVerdict =
  | { readonly kind: 'complete' }
  | { readonly kind: 'incomplete'; readonly failure: CompletenessFailure }

export interface CompletenessInput {
  /** The locally frozen operation. Its stored bytes are the reference, never the response's. */
  readonly operation: PrepareOperationRow
  /** A response this contract designates as decision-complete: an exact replay of the operation. */
  readonly response: PrepareOperationResource
  /**
   * Allocation UUIDs already known locally to belong to this operation, from discovery.
   *
   * A grant known locally but absent from the decision blocks completion (§5.4 item 4). That is
   * deliberately asymmetric with the reverse case: a decision naming a grant the client has not yet
   * ingested is also incomplete, because the client would be closing an operation whose authority
   * it has not actually applied.
   */
  readonly discoveredAllocationUuids: readonly string[]
  /** Allocation UUIDs this application is about to ingest, from the response itself. */
  readonly ingestedAllocationUuids: readonly string[]
}

function normalized(values: readonly string[]): ReadonlySet<string> {
  return new Set(values.map((value) => value.trim().toLowerCase()))
}

function sameMembers(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) {
    return false
  }

  for (const value of left) {
    if (!right.has(value)) {
      return false
    }
  }

  return true
}

/**
 * Evaluate the six §5.4 conditions in order. Any failure leaves the operation in its prior state.
 */
export function evaluateCompleteness(input: CompletenessInput): CompletenessVerdict {
  const { operation, response } = input

  // 1. Exact operation identity and request hash. A hash mismatch is IDEMPOTENCY_CONFLICT
  //    territory, never a completion — the server answered about *different* bytes.
  if (response.operation_uuid.trim().toLowerCase() !== operation.operationUuid) {
    return { kind: 'incomplete', failure: 'operation-identity-mismatch' }
  }

  if (response.request_hash.trim().toLowerCase() !== operation.requestHash) {
    return { kind: 'incomplete', failure: 'request-hash-mismatch' }
  }

  // 2. Exact frozen selected product set: same members, no more, no fewer. Compared against the
  //    locally frozen set rather than against the response's own echo of it, which would be
  //    circular.
  const frozenProducts = normalized(operation.selectedProductUuids)
  const decidedProducts = normalized(response.decision.selected_product_uuids)

  if (!sameMembers(frozenProducts, decidedProducts)) {
    return { kind: 'incomplete', failure: 'selected-set-mismatch' }
  }

  // 3. One decision per selected product. A product with no record is a *missing decision*, not a
  //    zero — this is the condition §6.7 exists to protect, and the reason a count is never enough.
  const outcomeProducts = normalized(
    response.decision.products.map((product) => product.product_uuid)
  )

  if (
    !sameMembers(frozenProducts, outcomeProducts) ||
    response.decision.products.length !== frozenProducts.size
  ) {
    return { kind: 'incomplete', failure: 'missing-product-decision' }
  }

  // 4. Complete grant linkage, in both directions.
  //
  //    Every non-zero outcome must name its allocation, and every allocation the decision names
  //    must be one this application is actually ingesting. A decision that names a grant the client
  //    never receives would close an operation whose authority was never applied.
  const ingested = normalized(input.ingestedAllocationUuids)

  for (const product of response.decision.products) {
    const grantsSomething = product.granted_quantity_milli > 0

    if (grantsSomething !== (product.allocation_uuid !== null)) {
      return { kind: 'incomplete', failure: 'incomplete-grant-linkage' }
    }

    if (product.allocation_uuid !== null && !ingested.has(product.allocation_uuid.toLowerCase())) {
      return { kind: 'incomplete', failure: 'incomplete-grant-linkage' }
    }
  }

  // ...and every grant already discovered as belonging to this operation must appear in the
  // decision. A locally known grant the decision omits means the client is looking at a truncated
  // view, not a complete one.
  const decisionAllocations = normalized(
    response.decision.products
      .map((product) => product.allocation_uuid)
      .filter((value): value is string => value !== null)
  )

  for (const discovered of normalized(input.discoveredAllocationUuids)) {
    if (!decisionAllocations.has(discovered)) {
      return { kind: 'incomplete', failure: 'undiscovered-grant-not-in-decision' }
    }
  }

  // 5. Preparation manifest and authority references present and internally coherent.
  const manifest = response.decision.manifest

  if (
    manifest.required_duration_seconds <= 0 ||
    manifest.prepared_at.length === 0 ||
    manifest.required_ready_until.length === 0 ||
    manifest.authority_ready_until.length === 0 ||
    manifest.evaluated_guards.length === 0
  ) {
    return { kind: 'incomplete', failure: 'missing-manifest' }
  }

  // The window must not claim more than it measured: `authority_ready_until` is a MIN that includes
  // the requested window, so it can never exceed `required_ready_until`.
  if (manifest.authority_ready_until > manifest.required_ready_until) {
    return { kind: 'incomplete', failure: 'missing-manifest' }
  }

  if (Object.keys(response.decision.authority_references).length === 0) {
    return { kind: 'incomplete', failure: 'unresolvable-authority-reference' }
  }

  // 6. Atomic local application is the caller's obligation: it applies this whole decision, its
  //    per-product outcomes, its grant links and its manifest in one SQLite transaction, or none of
  //    it. This predicate cannot enforce that and does not pretend to — it is enforced by
  //    `runSerializedWrite` at the call site and by the schema's refusal to store `applied` without
  //    a manifest.
  return { kind: 'complete' }
}

/**
 * Whether a *discovery* observation may close an operation. It never may.
 *
 * Kept as an explicit exported function rather than left implicit, because "just this once, the
 * shapes line up" is exactly the reasoning §5.4 forbids: one selected product, one returned grant,
 * matching quantities. Those coincidences are indistinguishable from a truncated view of a larger
 * decision without the decision itself.
 */
export function discoveryCanCompleteOperation(): false {
  return false
}
