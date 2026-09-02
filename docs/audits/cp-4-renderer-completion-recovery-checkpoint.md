# CP-4 Renderer Completion and Recovery Lifecycle Checkpoint

Date: 2026-08-29

Scope: desktop CP-4 only — the renderer-side completion/recovery lifecycle wired against CP-3's
five IPC channels. No IPC channel, main-process code, or SQLite/repository code was touched in
this checkpoint.

**Verification limitation, stated plainly and not glossed over:** this checkpoint could not be
manually smoke-tested in a running Electron window. `npm run dev` does not produce a usable GUI
from this agent's shell (`ELECTRON_RUN_AS_NODE` interferes — a known, previously-recorded
limitation of this environment, not specific to this change). Everything reported below is
`typecheck`/`lint`/`vitest` verification only. CLAUDE.md's rule for UI changes ("start the dev
server and use the feature in a browser before reporting complete") was **not satisfied** — a human
must open this build in the real desktop app and click through the golden path (complete a sale,
hit a blocked attempt, retry it, abandon it with confirmation, acknowledge a committed sale, force
a late-response race) before this checkpoint can be considered done in the sense CLAUDE.md means.

## Result

- `checkout.service.ts` gained `complete`, `retryAttempt`, `abandonAttempt`, `acknowledgeAttempt`,
  `pendingAttempts` — one method per CP-3 channel, same `unwrapIpcResult` pattern as the existing
  `validate`.
- `payment.store.ts` gained the full completion/recovery state machine: `attemptKey` (the
  renderer-generated idempotency key, created once per draft and reused across retries of that
  same draft — tombstoned to `null` on a T3 rejection or a successful abandon/acknowledge, so a
  corrected sale always gets a genuinely new key, plan §2.2), `completionPending`,
  `completionOutcome`, `completionError`, `blockingAttemptKey`, `pendingResults`, and the
  `complete`/`retryAttempt`/`abandonAttempt`/`acknowledgeAttempt`/`discoverPending` actions.
  `complete()` never imports `cart.store.ts` directly — cart-clearing on a successful commit is an
  injected `onCommitted` callback, mirroring `refreshPreview`'s existing `getCartToken` callback
  pattern exactly, so the two stores stay decoupled the same way they already were for the preview
  flow.
- **Late-response staleness guards (plan §2.10), on all five actions, not just `complete()`.**
  `complete()` reuses the existing `currentToken(cartToken)` draft-generation check
  (`payment.store.ts:40-48`, cited by the plan as the pattern to reuse). `retryAttempt`,
  `abandonAttempt`, `acknowledgeAttempt`, and `discoverPending` needed a *different* guard: they are
  not scoped to the live cart draft at all (a recovery-banner action can target an attempt from a
  previous crash with no corresponding draft in memory), so each now captures the store's own
  `contextGeneration` (bumped by `resetPayment()` on logout/device-recovery/cashier change) before
  its IPC call and drops the reply if that generation moved on — a reply arriving after a cashier
  switch can never repopulate `blockingAttemptKey`/`pendingResults`/`completionOutcome` for the
  wrong owner. This was not part of the original draft of this checkpoint; it was added after
  re-reading plan §2.10 ("late responses... never apply to a newer session") against the four
  actions that don't go through `currentToken` and finding they had no equivalent guard at all.
- `PaymentPanel.vue`'s completion control is real: `completionEnabled`, `completionPending`,
  `completionMessage`/`completionIsError`, and `recoveryState` props replace the previous
  hard-`disabled`, no-`@click` placeholder (the exact control named in the plan's CP-4 file list).
  `recoveryState` is a three-state discriminated prop (`clear` / `blocked` /
  `awaiting-acknowledgment`) so the same dialog shows the normal payment flow, an inline
  blocked-attempt notice with retry/abandon, or a post-commit acknowledgment screen — never more
  than one of the three at once, and the normal payment fields/complete button are hidden in the
  latter two states rather than merely disabled underneath a banner.
- **Plan §1.9 (abandon confirmation and tender warning), added after the first pass missed it.**
  Both `PaymentPanel.vue` and the new `SaleRecoveryBanner.vue` require two distinct actions to
  actually abandon: the first click reveals the tender warning ("abandoning does not mean cash was
  returned…") plus a **Confirm abandon** / **Never mind** pair; only the confirm button emits
  `abandon`. The confirmation state resets automatically if the underlying blocked attempt changes
  (a retry succeeding, a different attempt becoming blocking), so a stale confirmation can never
  apply to a different attempt than the one the cashier was warned about.
- New `SaleRecoveryBanner.vue` (pure presentation, `shared/components/pos/`, subject to the same
  `importBoundary.test.ts` sweep as every other file in that folder — verified it still passes,
  29 cases, picked up automatically by that test's directory scan): renders the one possible
  blocking attempt and every unacknowledged committed result, each row action-scoped to its own
  `attemptKey` (never a bare "acknowledge whatever is current" emit, since multiple unacknowledged
  results can coexist per plan §2.9). Renders nothing when there is nothing to recover.
- `PosPage.vue` wires all of the above: `completionEnabled` (`canSell && !isBlocked && preview ===
  'valid'`), `completionMessage`/`completionIsError` mapped from `completionOutcome`/
  `completionError` through a new `pos.payment.completion.{rejected,failed}.<code>` locale
  namespace (with a `genericFailure` fallback via `te()` for any code that doesn't have — or ever
  gains — a dedicated message, so an unmapped code degrades to a generic message rather than a
  broken/missing-key render), `paymentPanelRecoveryState` derived from `isBlocked`/
  `completionOutcome`, and `handleComplete`/`handleRetryAttempt`/`handleAbandonAttempt`/
  `handleAcknowledgeAttempt` — the latter three accept an optional explicit `attemptKey` so the
  exact same handler serves both `PaymentPanel`'s bare emits (defaulting to the store's own
  `blockingAttemptKey`/`completionOutcome.attemptKey`) and `SaleRecoveryBanner`'s key-carrying
  emits. `payment.discoverPending()` runs in the existing `onMounted` `Promise.all` alongside
  `shift.loadCurrent()`/`catalog.initialize()` — made to never throw (see Errors below) so a
  transient discovery failure can never abort the other two.
- Locale keys added to **both** `en.json` and `ar.json` (verified by the existing strict
  `i18n.test.ts` key-parity check, which also compiles every leaf string through the real vue-i18n
  compiler in both locales — this caught nothing new, but is the same test that has caught a broken
  message body before): `pos.recovery.unacknowledgedPrefix`, and the full
  `pos.payment.completion.*` namespace (`pending`, `retry`, `abandon`, `acknowledge`,
  `abandonWarning`, `confirmAbandon`, `blocked`, `committed` (`{offlineNumber}` interpolation),
  `unavailable`, `genericFailure`, and `rejected.*`/`failed.*` per known
  `LocalSaleFailure`/rejection code except `attempt-blocked`, which is shown through `recoveryState`
  instead of as an inline error). `completeSale`'s label lost its "— not available in this phase"
  suffix.

## What changed

New:

- `src/renderer/src/shared/components/pos/SaleRecoveryBanner.vue`
- `src/renderer/src/shared/components/pos/SaleRecoveryBanner.test.ts` (4 tests)
- `docs/audits/cp-4-renderer-completion-recovery-checkpoint.md` (this file)

Modified:

- `src/renderer/src/modules/pos/checkout.service.ts` — the four new methods + `pendingAttempts`.
- `src/renderer/src/modules/pos/payment.store.ts` — completion/recovery state, actions, staleness
  guards, `resetPayment()` extended.
- `src/renderer/src/modules/pos/payment.store.test.ts` — 25 total tests in the file (16 new):
  attemptKey generation/reuse/tombstoning, cart-clearing on commit, `attempt-blocked` recording,
  no-double-submit, stale-reply dropping (both the existing `currentToken` path and the new
  `contextGeneration` path for `retryAttempt`), thrown-error localization, `retryAttempt`/
  `abandonAttempt`/`acknowledgeAttempt` state transitions, `discoverPending` (success and swallowed
  failure), `resetPayment` clearing the new state.
- `src/renderer/src/shared/components/pos/PaymentPanel.vue` — the real completion control,
  `recoveryState` three-state rendering, the abandon confirmation step.
- `src/renderer/src/shared/components/pos/PaymentPanel.test.ts` — 18 total tests in the file (2
  rewritten to match the now-real control, 6 new: enabled/disabled states, the complete emit,
  a completion-rejection inline error, the blocked banner wiring retry only, the two-step abandon
  confirmation firing/cancelling, the awaiting-acknowledgment state).
- `src/renderer/src/shared/components/pos/types.ts` — `PaymentPanelRecoveryState`,
  `DisplayRecoveryResult`.
- `src/renderer/src/modules/pos/pages/PosPage.vue` — the computeds, handlers, `discoverPending()`
  call, and both new component wirings described above.
- `src/preload/posApi.ts`, `src/preload/posApiSurface.test.ts`, `checkout.ipc.ts`,
  `checkout.ipc.test.ts`, `ipc.validators.ts`, `ipcChannels.ts`, `checkout.contract.ts` — these were
  actually CP-3 work; listed here only because they were re-verified together with this checkpoint,
  not because anything in them changed for CP-4.
- `src/renderer/src/i18n/locales/en.json`, `ar.json` — the locale keys described above.

## Errors found and fixed during this checkpoint

1. **`payment.discoverPending()` could throw and abort unrelated page-load work.** Main's
   `LocalSaleService.pendingAttempts()` calls `shiftAuthority.captureContext()` with no internal
   try/catch; if called before a valid session/shift-authority context exists, that throws, the IPC
   handler turns it into an `{ok:false}` envelope, and `unwrapIpcResult` re-throws it in the
   renderer. `onMounted` originally awaited `Promise.all([shift.loadCurrent(), catalog.initialize(),
   payment.discoverPending()])` — a thrown `discoverPending()` would have rejected the whole
   `Promise.all` and skipped the subsequent `cart.setContract(...)` call, leaving the cart wired to
   no catalog contract. Fixed by wrapping `discoverPending()`'s body in its own try/catch: a
   transient failure now just leaves the recovery banner empty instead of touching anything else.
2. **No late-response staleness guard on `retryAttempt`/`abandonAttempt`/`acknowledgeAttempt`/
   `discoverPending`, only on `complete()`.** Found by re-reading plan §2.10 specifically against
   each of the five actions rather than assuming the one guard already built for `complete()`
   covered the others. Fixed as described above (the `contextGeneration` guard).
3. **Abandon had no confirmation step at all in the first pass** — a bare click fired `abandon`
   immediately, missing plan §1.9's explicit "requires explicit confirmation" and tender-warning
   requirements. Fixed in both `PaymentPanel.vue` and `SaleRecoveryBanner.vue` with the two-step
   confirm pattern described above, plus dedicated tests proving the first click alone never emits.
4. **The invoice/item/payment result schemas in `checkout.contract.ts` (CP-3, reverified here)
   were a hand-guessed subset** of the real `LocalInvoiceRow`/`LocalInvoiceItemRow`/
   `LocalInvoicePaymentRow` shapes and were caught failing against a real service result — already
   fixed in the CP-3 checkpoint, re-confirmed still correct here since CP-4's renderer types consume
   those same schemas' inferred types directly.

## Verification evidence

All commands actually executed, in this repository, after every change in this checkpoint:

| Command | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run lint` | PASS (0 errors, 0 warnings) |
| `npm run test` (vitest) | PASS — 596 tests, 85 files |
| `npm run test:sqlite:electron` | PASS — 97 tests, 0 failures (unchanged; no main-process code touched) |
| `npm run verify:fixture` | PASS |
| `npm run smoke:database` | PASS |
| `npm run build` | PASS (308 renderer modules, up from 305 — the new component/wiring bundled) |
| `git diff --check` | PASS |
| Manual browser smoke test | **NOT RUN — see the limitation statement above** |

## Security boundary confirmation

`posApi.ts`'s new methods are typed one-per-capability against `IPC_CHANNELS`, no generic `invoke`,
matching `posApiSurface.test.ts`'s existing regex sweep (still passing). `shared/components/pos/`'s
`importBoundary.test.ts` (a directory sweep, not an explicit file list — verified it picked up both
new files automatically) confirms `SaleRecoveryBanner.vue` never imports `window.posApi`, a business
Pinia store, HTTP, or SQLite — every action is a bare or key-carrying emit resolved by the parent
page. No SQLite access was added. No new dependency was added. `contextIsolation`/`nodeIntegration`
/`sandbox` were not touched.

## Explicitly deferred to CP-5 (not implemented here, per plan scope)

Fresh-process/SIGKILL recovery tests, the D1 device/session permission matrix exercised end-to-end
through the real IPC boundary, and the manual smoke checklist (plan's own 19-item list) all remain
CP-5b territory — and, as stated above, the manual/browser portion of *this* checkpoint's own
CLAUDE.md testing obligation is outstanding pending a human running the real desktop app. CP-5a
artifact generation and BE-3F-2B backend integration are untouched.
