# FU-P4-1 — A draft refused while the subscription had lapsed looked blocked after reactivation

**Status:** Fixed on `feat/platform-plans-subscriptions` (Phase 4 closeout, 2026-10-07). **Found:** Phase 4 verification,
2026-10-07 (backend release notes, "Observed during verification"). **Introduced by Phase 4:** no — it is checkout
behaviour that a lapsed subscription made reachable.

## Reproduction (real Electron, before the fix)

Journey `p4cartrecovery` against the unchanged code (logs `repro*.log`, screenshots under
`plans/phase4-closeout-evidence-20261007/repro/`):

1. A physical-presence till sells once, then scans WATER (the draft).
2. The paid period and grace end (labelled sandbox precondition); the cashier refreshes and consents to review the cart.
3. Exact cash (Shift+F9) is refused. Main answers `{ outcome: 'failed', code: 'context-changed', attemptKey: null }`:
   nothing is claimed or committed. The dialog shows "The subscription grace period has ended." **and** "The shift or
   workstation assignment changed. Refresh before completing this sale."
4. The platform approves, records the payment and activates a same-plan request; the cashier refreshes (consent) and
   rebuilds the kept draft (catalog review).
5. Pressing exact cash again does nothing, and the old "shift or workstation changed" message is still shown, so the
   draft looks blocked. Pressing **Complete sale (F9)** does pay it — the draft was never durably blocked.

## Root cause

Four renderer/main defects, none of them in the sale attempt itself:

| # | Defect | Effect |
| --- | --- | --- |
| 1 | `LocalSaleService` reported every commercial-access refusal (lapsed subscription, overdue validation, blocked device, revoked `pos.sell`…) as `context-changed`. | The cashier was told the shift or workstation changed and to refresh — wrong cause. |
| 2 | The payment store treated a `failed` code from the "claimed" list as a claimed attempt even when main answered `attemptKey: null`, and only a second `attempt-status` call released it. | At the moment the refusal settled the draft was `attemptProtected` (no Clear cart, no exact cash, scanning locked). When that status call failed, the draft stayed locked — the Phase 4 observation "Clear cart did not open". Measured in the journey: `protectedAtSettle: true, attemptState: 'claimed'`. |
| 3 | The refusal stayed bound to the draft as `completionOutcome` through dismissal, refresh and rebuild. | "Refresh before completing this sale" was still shown after the refresh. |
| 4 | Exact cash requires an empty tender, but the refused press had left its own exact-cash row. | Shift+F9 / *Exact cash* silently did nothing for the same draft. |

## Fix

- Main: a commercial-access refusal is `access-denied` (new failure code; `clock-untrusted` and `company-suspended` keep
  their codes). Before a claim nothing is written and the answer carries no attempt key; for an already claimed attempt
  it is non-terminal and the attempt stays claimed (as `context-changed` was). EN/AR message: selling is not allowed,
  nothing was saved, the cart is kept; refresh and complete it again once access returns. `context-changed` now means
  only that the shift/workstation identity moved.
- Renderer (`payment.store.ts`): a `failed` answer with `attemptKey: null` is a known outcome — the key is released at
  once, nothing is protected and no status round trip is needed; a late unbound answer like that never sets a
  blocking key. Such an answer is dropped when the dialog is dismissed or the cart changes. Claimed, rejected,
  committed and blocked results, and in-flight requests, are never touched.
- Page (`PosPage.vue`): one exact-cash row for exactly the current total counts as exact cash, so Shift+F9 re-submits the
  same draft with that row (never a second row).

Unchanged: a new key is only created after main has answered (a lost reply still reconciles through
`attempt-status`/`retry-attempt` and recovers the original sale); main still de-duplicates a concurrent press of the same
key; catalog review/rebuild is still required after a revision change; Clear cart is still refused for a protected
attempt; completed sales, queued uploads and refunds are untouched. Persisting drafts across restarts remains FU-P3-3.

## Tests

| Test | Before the fix | After |
| --- | --- | --- |
| `payment.store.test.ts` "Phase 4 closeout: a refused sale that main never claimed" (7 tests: no protection when the status re-check fails; a late unbound refusal never blocks; same draft paid once; lost reply recovers the original sale; dismissal and cart change drop only the unclaimed refusal; leftover exact row) | 5 failed | pass |
| `PosPage.v3Behaviour.test.ts` "a refused, never-claimed sale leaves the draft usable…" (through the real page: dismiss, Clear → Cancel, exact cash re-submits with one row) | failed | pass |
| `tests/electron/suites/lapsedSubscriptionCheckout.suite.ts` (real SQLite: refusal claims nothing and is `access-denied`; after reactivation the draft commits once and a repeat replays; a claimed attempt stays claimed) | 2 failed | pass |
| Existing suites expecting `context-changed` for an access refusal (`localSaleCompletion`, `localSaleAttempts`, `ppCommitBoundaries`) | — | updated to `access-denied` |
| Electron `p4cartrecovery` (real app, sandbox backend): refusal `access-denied`, `attemptKey: null`, not protected; Escape clears the stale message; Clear opens with focus inside (EN, AR) and Escape/Cancel keep the draft; reactivation, refresh with consent, rebuild; exact cash pressed twice → one sale, uploaded once (local 2, server 2); Clear on a new draft: Cancel keeps, Clear empties only it, invoice queue unchanged | — | passed |

The uncertain-reply case (main committed, reply lost) is covered by the store test above and the existing
`reconciles an IPC failure…` test; it is not forced in Electron.
