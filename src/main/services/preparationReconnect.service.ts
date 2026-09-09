import type { PrepareOwner } from '../repositories/preparation.repository'
import type { PrepareCycleOutcome, PreparationService } from './preparation.service'

/**
 * CP4 — the §7.3 reconnect state machine, owned by main.
 *
 * ## What this exists to get right
 *
 * §7.3 opens by withdrawing two tempting simplifications:
 *
 *  - **there is no global sale pause.** The cashier keeps selling from already valid local rights
 *    throughout every step below;
 *  - **there is no single total order for all work.** Prerequisite reads may precede upload;
 *    unsafe *mutations* are what the ordering fences.
 *
 * §2.2 finding 1 corrects the other tempting rule: "every refresh before every upload is unsafe" is
 * **false**. The frozen reconciliation representation computes local spendable quantity as grant
 * minus the accepted server boundary minus every local committed consumption above that boundary,
 * ignores older coverage, and holds equal-sequence disagreement. A verified bootstrap or coverage
 * refresh can therefore safely precede upload. The required rule is **monotonic reconciliation**,
 * not blanket upload-first ordering — and reintroducing an upload-first rule here would recreate the
 * exact deadlock §7.3 exists to remove: uploads need refreshed authority, and refresh would be
 * waiting for an empty queue that §7.1 proves never comes.
 *
 * ## The ordering that *is* required
 *
 * ```text
 * 1. restore transport and authorization      (reads; may precede upload)
 * 2. read-only authoritative refresh          (reads; monotonic reconciliation only)
 * 3. capture a bounded cycle and partition    (local; grants nothing)
 * 4. drain captured dependencies              (uploads for affected products only)
 * 5. prepare the eligible set                 (the only step that creates authority)
 * 6. retire only selected grants              (never on ordinary reconnect)
 * 7. acknowledge proof, then optionally release (separate gates; release stays disabled)
 * ```
 *
 * Steps 1 and 2 are unfenced because they create no authority. Step 5 is fenced by steps 3 and 4
 * for its *own* products only: draining may move a product out of the blocked set, but only into a
 * **later** cycle, never into an operation already frozen (§7.2 step 6).
 *
 * Step 6 is a deliberate no-op here, and that is the point: §7.3 item 6 and §14.2 item 8 both say
 * healthy allocations are **not** sealed merely because connectivity returned. Seal is for explicit
 * excess retirement, reassignment, integrity hold, or a security workflow — none of which is
 * "reconnect happened".
 */

export type ReconnectStep =
  | 'authority_restored'
  | 'refresh_reconciled'
  | 'dependencies_drained'
  | 'preparation_ran'
  | 'retirement_skipped'

export interface ReconnectStepResult {
  readonly step: ReconnectStep
  readonly ok: boolean
  readonly detail: string | null
}

export interface ReconnectOutcome {
  readonly steps: readonly ReconnectStepResult[]
  /** `null` when preparation was not reached, which is a normal outcome rather than a failure. */
  readonly preparation: PrepareCycleOutcome | null
}

export interface PreparationReconnectDependencies {
  /**
   * Step 1. Re-establish authentication, validate the license, refresh session/device binding, and
   * obtain current permissions. These prerequisite calls may precede upload (§7.3 item 1), and the
   * existing catalog refresh already validates the license first because an overdue license blocks
   * bootstrap.
   */
  restoreAuthority(owner: PrepareOwner): Promise<{ readonly ok: boolean; readonly detail?: string }>
  /**
   * Step 2. Fetch and atomically reconcile bootstrap/catalog/allocation envelopes and coverage.
   *
   * Refresh never creates a grant, and must preserve local consumptions above the accepted
   * boundary, terminal markers, and holds. That property lives in the reconciliation service this
   * delegates to; it is not re-implemented here.
   */
  refreshAuthoritativeState(
    owner: PrepareOwner
  ): Promise<{ readonly ok: boolean; readonly detail?: string }>
  /**
   * Step 4. Upload or replay only the captured rows for affected products, applying returned
   * coverage. The cashier may keep selling from existing valid rights concurrently.
   */
  drainCapturedDependencies(
    owner: PrepareOwner
  ): Promise<{ readonly ok: boolean; readonly detail?: string }>
  readonly preparation: Pick<PreparationService, 'runCycle'>
}

export class PreparationReconnectService {
  constructor(private readonly dependencies: PreparationReconnectDependencies) {}

  async reconnect(owner: PrepareOwner): Promise<ReconnectOutcome> {
    const steps: ReconnectStepResult[] = []

    const authority = await this.dependencies.restoreAuthority(owner)
    steps.push({
      step: 'authority_restored',
      ok: authority.ok,
      detail: authority.detail ?? null
    })

    if (!authority.ok) {
      // Without current authority nothing later can be trusted, and preparation in particular would
      // be dispatching under credentials the server may already have revoked.
      return { steps, preparation: null }
    }

    const refresh = await this.dependencies.refreshAuthoritativeState(owner)
    steps.push({
      step: 'refresh_reconciled',
      ok: refresh.ok,
      detail: refresh.detail ?? null
    })

    // A failed refresh does not stop the drain. Uploading queued invoices is safe without a fresh
    // snapshot — their payloads are immutable and their authority is historical — and blocking the
    // drain on refresh is precisely the dependency cycle §7.3 removes.
    const drain = await this.dependencies.drainCapturedDependencies(owner)
    steps.push({
      step: 'dependencies_drained',
      ok: drain.ok,
      detail: drain.detail ?? null
    })

    // Step 5. The cycle captures its own bounded boundary and partitions for itself, so a product
    // the drain did not resolve is simply blocked in *this* cycle and served by a later one.
    const preparation = await this.dependencies.preparation.runCycle(owner)
    steps.push({
      step: 'preparation_ran',
      ok: preparation.kind === 'applied',
      detail: preparation.kind
    })

    // Step 6, recorded rather than performed. §7.3 item 6: healthy allocations are not sealed
    // merely because connectivity returned. Making the non-action explicit in the trace is what
    // stops a future change from quietly adding one.
    steps.push({
      step: 'retirement_skipped',
      ok: true,
      detail: 'healthy_grants_retained'
    })

    return { steps, preparation }
  }
}
