import type { SyncQueueState } from '@shared/constants/syncQueueStates'
import type { PrepareBlockedReason } from '../repositories/preparation.repository'

/**
 * CP3 — the §7.2 dependency table, as code.
 *
 * The whole point of this module is that a *blocked* product must not block an *unrelated* product.
 * §6.8 is the worked case: Cola holds a terminal invoice conflict while Water has no unresolved
 * dependency at all. Water is prepared normally; Cola is recorded with its reason and resumes only
 * through its own explicit resolution in a later cycle.
 *
 * Revision 2.1 contradicted itself here — it promised both "a blocked product must not block
 * unrelated products" and "one operation waits for all of its captured dependencies". §6.8 resolves
 * that by scope, not by exception: Cola was never a dependency of Water's operation because Cola was
 * never *in* it.
 */

/** §7.2: how one captured queue row affects the product or allocation it touches. */
export function blockedReasonForQueueState(state: SyncQueueState): PrepareBlockedReason | null {
  switch (state) {
    case 'pending':
      // Local consumption not yet accepted by the server. Blocks only the touched
      // product/allocation, until synced or until authoritative coverage proves it accepted.
      return 'pending_upload'
    case 'uploading':
      // Genuinely ambiguous: the upload may or may not have been accepted. Blocks the same narrow
      // scope until lease recovery, replay, or verified coverage settles it.
      return 'uploading_ambiguous'
    case 'retryable_error':
      return 'retryable_error'
    case 'conflict':
      // Terminal quarantine on the touched allocation/product. Never retried automatically, and
      // never allowed to block unrelated products.
      return 'terminal_conflict'
    case 'rejected':
      // A permanently rejected invoice does not make its local physical sale disappear: its
      // allocation consumption stays deducted and its server reservation stays held. Preparation is
      // blocked for the affected scope pending explicit resolution — there is no hidden deletion,
      // release, or write-off.
      return 'terminal_rejection'
    case 'synced':
      // Retained history. §7.1 is explicit that no physical-table-emptiness condition is permitted,
      // because `synced`, `conflict`, and `rejected` rows are all retained forever. A synced row is
      // ignored after the coverage consistency check.
      return null
    default:
      return null
  }
}

export interface CapturedQueueRow {
  readonly localQueueUuid: string
  readonly queueSequence: number
  readonly state: SyncQueueState
  /** Products this row's immutable invoice/allocation journal touches, when resolvable. */
  readonly productUuids: readonly string[]
  readonly allocationUuids: readonly string[]
  /** False when the row cannot be mapped confidently to products or allocations. */
  readonly scopeKnown: boolean
}

export interface PartitionInput {
  readonly candidateProductUuids: readonly string[]
  readonly capturedRows: readonly CapturedQueueRow[]
  /** Products already selected by an unresolved operation (§5.6). */
  readonly productsOwnedByUnresolvedOperations: ReadonlySet<string>
  /** Products the resolved policy does not enable for preparation. */
  readonly policyDisabledProductUuids: ReadonlySet<string>
  /** Products whose exposure is already fully occupied by unreleased holds (§4.4). */
  readonly blockedByUnreleasedHoldProductUuids: ReadonlySet<string>
}

export interface PartitionResult {
  readonly eligible: readonly string[]
  readonly blocked: readonly {
    readonly productUuid: string
    readonly reason: PrepareBlockedReason
  }[]
}

/**
 * Partition candidates into the eligible and blocked sets (§7.2 step 2).
 *
 * Reasons are evaluated in a fixed precedence so a product blocked for several reasons reports the
 * one an operator can actually act on first. `dependency_scope_unknown` deliberately ranks highest:
 * it is a data-integrity exception, not the normal policy, and §7.2 requires it to be surfaced
 * rather than absorbed into a narrower-looking reason.
 */
export function partitionCandidates(input: PartitionInput): PartitionResult {
  const candidates = input.candidateProductUuids.map((uuid) => uuid.trim().toLowerCase())
  const reasons = new Map<string, PrepareBlockedReason>()

  const assign = (productUuid: string, reason: PrepareBlockedReason, rank: number): void => {
    const existing = reasons.get(productUuid)

    if (existing === undefined || rank < precedence(existing)) {
      reasons.set(productUuid, reason)
    }
  }

  // A row whose scope cannot be resolved blocks this owner and warehouse conservatively — every
  // candidate — rather than being guessed at. §7.2 calls this the broader fallback and an explicit
  // data-integrity exception; it must never silently narrow to "no products affected".
  const unknownScope = input.capturedRows.some(
    (row) => !row.scopeKnown && blockedReasonForQueueState(row.state) !== null
  )

  if (unknownScope) {
    for (const productUuid of candidates) {
      assign(productUuid, 'dependency_scope_unknown', precedence('dependency_scope_unknown'))
    }
  }

  for (const row of input.capturedRows) {
    const reason = blockedReasonForQueueState(row.state)

    if (reason === null) {
      continue
    }

    for (const productUuid of row.productUuids) {
      const normalized = productUuid.trim().toLowerCase()

      if (candidates.includes(normalized)) {
        assign(normalized, reason, precedence(reason))
      }
    }
  }

  for (const productUuid of candidates) {
    if (input.policyDisabledProductUuids.has(productUuid)) {
      assign(productUuid, 'policy_disabled', precedence('policy_disabled'))
    }

    if (input.blockedByUnreleasedHoldProductUuids.has(productUuid)) {
      assign(productUuid, 'blocked_by_unreleased_hold', precedence('blocked_by_unreleased_hold'))
    }

    // §5.6: no new operation may be created for a product already selected by an unresolved one.
    // This is what makes repeated clicks and restarts produce no duplicate grant (§6.8).
    if (input.productsOwnedByUnresolvedOperations.has(productUuid)) {
      assign(
        productUuid,
        'owned_by_unresolved_operation',
        precedence('owned_by_unresolved_operation')
      )
    }
  }

  const blocked = candidates
    .filter((productUuid) => reasons.has(productUuid))
    .map((productUuid) => ({
      productUuid,
      reason: reasons.get(productUuid) as PrepareBlockedReason
    }))

  return {
    eligible: candidates.filter((productUuid) => !reasons.has(productUuid)),
    blocked
  }
}

function precedence(reason: PrepareBlockedReason): number {
  switch (reason) {
    case 'dependency_scope_unknown':
      return 0
    case 'owned_by_unresolved_operation':
      return 1
    case 'terminal_conflict':
      return 2
    case 'terminal_rejection':
      return 3
    case 'blocked_by_unreleased_hold':
      return 4
    case 'uploading_ambiguous':
      return 5
    case 'pending_upload':
      return 6
    case 'retryable_error':
      return 7
    case 'policy_disabled':
      return 8
    default:
      return 9
  }
}
