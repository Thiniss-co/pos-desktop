import {
  checkoutCompletionOutcomeSchema,
  checkoutRecoveryStateSchema,
  type CheckoutCompletionOutcome,
  type CheckoutIntent,
  type CheckoutPendingAttemptsInput,
  type CheckoutPreviewOutcome,
  type CheckoutRecoveryState
} from '@shared/contracts/checkout.contract'
import { unwrapIpcResult } from '@renderer/shared/utils/unwrapIpcResult'

export class CheckoutRendererService {
  constructor(private readonly gateway: Window['posApi']['checkout'] = window.posApi.checkout) {}

  async validate(intent: CheckoutIntent): Promise<CheckoutPreviewOutcome> {
    return unwrapIpcResult(await this.gateway.validate(intent))
  }

  /** `checkout:complete` (T1 → T2/T3). */
  async complete(attemptKey: string, intent: CheckoutIntent): Promise<CheckoutCompletionOutcome> {
    return checkoutCompletionOutcomeSchema.parse(
      unwrapIpcResult(await this.gateway.complete({ attemptKey, intent }))
    )
  }

  /** `checkout:retry-attempt` (T4), key-only — never repriced, never resubmits content. */
  async retryAttempt(attemptKey: string): Promise<CheckoutCompletionOutcome> {
    return checkoutCompletionOutcomeSchema.parse(
      unwrapIpcResult(await this.gateway.retryAttempt({ attemptKey }))
    )
  }

  /** `checkout:abandon-attempt` (T5, D1-A) — no `pos.sell` required. */
  async abandonAttempt(attemptKey: string): Promise<CheckoutCompletionOutcome> {
    return checkoutCompletionOutcomeSchema.parse(
      unwrapIpcResult(await this.gateway.abandonAttempt({ attemptKey }))
    )
  }

  /** `checkout:acknowledge-attempt` (T7/T8) — idempotent, owner-scoped. */
  async acknowledgeAttempt(attemptKey: string): Promise<CheckoutCompletionOutcome> {
    return checkoutCompletionOutcomeSchema.parse(
      unwrapIpcResult(await this.gateway.acknowledgeAttempt({ attemptKey }))
    )
  }

  /** `checkout:pending-attempts` — read-only discovery, never mutates. */
  async pendingAttempts(input: CheckoutPendingAttemptsInput): Promise<CheckoutRecoveryState> {
    return checkoutRecoveryStateSchema.parse(
      unwrapIpcResult(await this.gateway.pendingAttempts(input))
    )
  }
}
