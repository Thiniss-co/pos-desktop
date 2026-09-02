# CP-2 Attempt Lifecycle and Atomic Persistence Service Checkpoint

Date: 2026-08-29

Scope: desktop CP-2 only — `LocalSaleService` (the existing-state dispatcher, T1–T10 transition
implementation, and the single atomic business transaction), the fingerprinting/payload/allocation
services it depends on, the `catalog.service.ts` allocation-remaining overlay, `applicationServices.ts`
wiring, and the `checkout.contract.ts` completion/recovery unions. Explicitly **out of scope, not
touched**: IPC channels, `ipc.validators.ts`, `posApi.ts`, and all renderer/`.vue` code — those are
CP-3/CP-4. No production database was touched; every test ran against a disposable sandboxed SQLite
file using the real shipped Electron better-sqlite3 build via `scripts/runElectronNode.mjs`.

Depends on (implemented and verified in this session, both before and during this checkpoint): CP-1
(schema/repository foundation), BE-3F-5 and BE-3F-3 (backend allocation and historical-upload
contracts, reverified independently), and BE-3F-2A's golden request fixture.

## Result

- `LocalSaleService` implements the plan's full T1–T10 transition table and §2.3 existing-state
  dispatcher: T1 (genuinely new claim), T2/T4 (the single atomic business transaction, shared between
  create and retry), T3 (definite rejection, separate transaction, intent purge), T5 (abandon, D1-A,
  no `pos.sell`/shift/commercial-access required, §1.7 no-sale evidence check), T6/T8 (exact replay
  for committed/acknowledged, no selling gate), T7 (acknowledge, idempotent), T9 (content-mismatch
  conflict on any state), T10 (owner-scoped miss and opaque global-key collision).
- **Root-cause fix (this checkpoint's primary task):** the business transaction's steps 1–6
  (commercial access, `pos.sell`, current shift/branch/warehouse identity, catalog revision) were
  incorrectly treated identically to steps 7–9 (calculateCart/calculatePayments/allocation) — every
  non-`ok` result triggered a T3 rejection (`recordRejection` + `state='rejected'`), and a
  `touchLastAttempted` write ran unconditionally before the transaction even resolved. Plan §1.8/§2.4/
  the cross-document consistency table (line 1782, "T4 compares current shift/branch/warehouse to
  immutable origin and returns `context-changed` **with zero writes**") and §1.8's own retry table
  ("shift-unavailable... **cashier may abandon**"; "catalog revision changed... **cashier must abandon
  and re-ring**"; "commercial access or `pos.sell` lost... **abandonment follows the approved D1-A
  matrix**") all require these four codes (`permission-denied`, `shift-unavailable`, `context-changed`,
  `refresh-required`) to leave the row `claimed` with **zero writes**, never a T3 rejection — an
  already-rejected row cannot later be abandoned (T5 requires `claimed`), which is exactly what all
  three of those quoted sentences promise the cashier. Fixed by: (1) introducing
  `NON_TERMINAL_FAILURE_CODES` and short-circuiting `attemptBusinessTransaction`'s failure branch
  before `recordRejection` for exactly those four codes, returning `{outcome:'failed', code, attemptKey}`
  instead; (2) splitting the single "shift/branch/warehouse mismatch → `context-changed`" check into
  two distinct cases — no currently open shift/branch/warehouse at all is `shift-unavailable`
  (plan: "closed / paused / foreign / reconciliation-required"), while a currently open shift/branch/
  warehouse that simply differs from the captured origin is `context-changed` (plan: "S1 closed and S2
  opened"); (3) removing the unconditional pre-transaction `touchLastAttempted` write and the now-dead
  `SaleAttemptRepository.touchLastAttempted` method — plan §1.8 states `last_attempted_at` "is
  persisted only with a terminal commit/rejection," which `markCommitted`/`markRejected` already do
  themselves. The one test this bug caused to fail (`retry after the shift closes on another terminal
  returns context-changed`) was itself found to only simulate S1 *closing*, never S2 *opening* — its
  own title and plan line 1782 both describe the S1→S2 case, so the test was corrected to actually open
  a second shift with a different UUID after closing the first, which is what makes `context-changed`
  (vs. the now-correctly-distinguished `shift-unavailable`) the right expectation for that scenario.
- `LocalSaleCommitted`/`LocalSaleAcknowledged` now carry the full `items`/`payments` detail alongside
  the invoice header (previously only the bare header row), fetched from the same
  `itemsForInvoice`/`paymentsForInvoice` calls the business transaction and replay/acknowledge paths
  already made internally — closing a gap where the plan's 5-channel IPC surface (§2.9) has no separate
  "fetch invoice detail" channel, so a receipt-capable result must be inline on the outcome itself.
- Added `CatalogService.getAllocationRemaining(owner, productUuid)`: the D2-B sellable-remaining
  quantity for one tracked product at one device/warehouse, computed by the exact same
  `usableGrantsForProduct` + `remainingMilli` read path the commit-time allocation split already uses
  (never a cached/shared-stock number); `null` for an untracked or unknown product or when no trusted
  time is available. `CatalogService`'s allocation-repository dependency is optional so the six
  pre-existing construction sites (Phase 3C tests, `checkoutPreview.suite.ts`, IPC tests) are unchanged;
  only `applicationServices.ts`'s real wiring passes it.
- Wired `LocalSaleService` (plus `SaleAttemptRepository`, `LocalSaleRepository`, `LocalStockRepository`,
  `StockAllocationRepository`, `StockAllocationService`) into `applicationServices.ts`, following the
  exact pattern already used for `checkoutPreview`. `ApplicationServices.localSale` is now available for
  CP-3's IPC handlers to call; no IPC channel yet reads it.
- Extended `checkout.contract.ts` with the completion/recovery wire shapes named in the plan's CP-2
  file list ("intent, outcome, and recovery unions" — `intent` already existed from Phase 3E):
  `checkoutCompletionOutcomeSchema` (discriminated union mirroring `LocalSaleOutcome` exactly —
  `committed`/`acknowledged`/`rejected`/`abandoned`/`failed`, each `.strict()`) and
  `checkoutRecoveryStateSchema` (a deliberately narrower view of `pendingAttempts()` than the raw
  `sale_attempts` row — never exposes `intent_json`, fingerprints, or origin columns to the renderer
  boundary). The invoice/item/payment result schemas were first written as a hand-guessed subset and
  **caught by their own test**: parsing a real `LocalSaleService.complete()` result against them failed
  with `unrecognized_keys` (`.strict()` rejects fields absent from the schema) for
  `remoteUuid`/`serverNumber`/`syncStatus`/`syncAttempts`/`lastSyncError`/`syncedAt`/
  `commitSessionEpoch`/`intentFingerprint`/`commercialSnapshotJson`/`uploadPayloadVersion`/`updatedAt`
  on the invoice and `methodSnapshotJson` on the payment. Corrected to a complete, faithful field-by-
  field mirror of `LocalInvoiceRow`/`LocalInvoiceItemRow`/`LocalInvoicePaymentRow` rather than a
  speculative curated subset — CP-3, which does not exist yet, owns any decision to narrow what
  actually crosses the wire.
- Expanded `tests/electron/suites/localSaleCompletion.suite.ts` from 11 to 19 `databaseTest` cases
  (89 → 97 total suite tests) to close specific T1–T10 gaps that had zero prior coverage: T4's success
  path (retry commits the exact retained intent — previously only retry's *failure* paths were
  tested); T6/T8 exact replay reached via `retry()` on an already-committed/-acknowledged attempt
  (proving no selling gate applies to replay); T10 owner-scoped miss for `retry`/`acknowledge`/`abandon`
  together; T10 foreign-owner opacity (a claimed row for a different cashier is `not-found`, never
  disclosed, for all three read/write recovery operations); T1's opaque `attempt-key-unavailable` on a
  genuine global primary-key collision; `abandon-attempt` refused as `already-committed` on a committed
  sale, never rewriting it. Every new committed/acknowledged/rejected/failed outcome produced in this
  suite is now also parsed through `checkoutCompletionOutcomeSchema` inline, so the shared contract and
  the real service can never silently drift apart again.
- Added `src/main/services/localSale.payload.test.ts` (6 vitest cases) — `buildUploadPayload()` had
  zero direct coverage before this checkpoint (only indirect coverage via "a `sync_queue` row exists").
  Now covers: the exact v2 wire shape field-for-field for an untracked-only sale; no `allocations` key
  ever appears for an untracked line; items/payments are sorted by `lineIndex`/`paymentIndex`
  regardless of input array order; a tracked line's `allocations` entry carries `rights_generation`
  from the referenced grant's `lifecycleGeneration` exactly; an unknown allocation reference throws
  rather than silently omitting a consumption; the invoice discount type/value pass through unchanged.

## What changed

New:

- `src/main/services/localSale.payload.test.ts` (6 tests)
- `docs/audits/cp-2-attempt-lifecycle-checkpoint.md` (this file)

Modified:

- `src/main/services/localSale.service.ts` — the `shift-unavailable`/`context-changed` split, the
  `NON_TERMINAL_FAILURE_CODES` zero-write short circuit, removal of the unconditional
  `touchLastAttempted` call, and `items`/`payments` added to `LocalSaleCommitted`/`LocalSaleAcknowledged`
  (with `requireResultIntegrity` now returning the full detail, reused by both `replayTerminal` and
  `acknowledge()`).
- `src/main/repositories/saleAttempt.repository.ts` — removed the now-dead `touchLastAttempted` method
  (no remaining caller anywhere in the codebase).
- `src/main/services/catalog.service.ts` — `getAllocationRemaining()` and the optional
  `StockAllocationRepository` constructor dependency.
- `src/main/app/applicationServices.ts` — instantiates and exposes `localSale: LocalSaleService`;
  passes the allocation repository into `CatalogService`.
- `src/shared/contracts/checkout.contract.ts` — the completion/recovery schemas and types described
  above.
- `tests/electron/suites/localSaleCompletion.suite.ts` — the S1→S2 test fix, the 8 new transition-
  matrix tests, and inline `checkoutCompletionOutcomeSchema.parse()` calls on every outcome variant
  the suite already produces.
- `tests/electron/suites/catalog.suite.ts` — one new test for `getAllocationRemaining()` (tracked
  product with a real grant, untracked product, unknown product).

## Verification evidence

All commands actually executed, in this repository, after every change in this checkpoint:

| Command | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run lint` | PASS (0 errors, 0 warnings) |
| `npm run test` (vitest) | PASS — 550 tests, 84 files |
| `npm run test:sqlite:electron` | PASS — 97 tests, 0 failures |
| `npm run verify:fixture` | PASS — all three existing cross-repo fixtures byte-identical |
| `npm run smoke:database` | PASS |
| `npm run build` | PASS |
| `git diff --check` | PASS |

## Debugging note

The one failing test inherited from the prior session (`retry after the shift closes on another
terminal returns context-changed`) surfaced only as `node:test`'s generic masked error ("Electron
SQLite test leaked an open database handle") because `databaseTest`'s `finally { sandbox.dispose() }`
throws its own error when a test body throws before reaching `closeDatabase()`, and a `finally`-block
throw overrides whatever the `try` block threw. Root-caused by writing a standalone script
(`node scripts/runElectronNode.mjs <script>.ts`, bypassing `node:test` entirely) that ran the exact
same setup and printed the real return value directly — the same technique used for the two similar
masked failures introduced by this checkpoint's own new tests (a `CHECK (length(...) = 64)` violation
from placeholder fingerprint strings, and a `.strict()` schema mismatch from a hand-guessed subset of
the invoice row shape). All three were real bugs or omissions, not test-harness flakiness.

## Security boundary confirmation

No IPC channel, `contextBridge` surface, or renderer file was touched. No SQLite access was added
outside the main-process repository layer. No new dependency was added. The desktop app's
`contextIsolation`/`nodeIntegration`/`sandbox` settings were not touched.

## Explicitly deferred to CP-3/CP-4/CP-5 (not implemented here, per plan scope)

`ipcChannels.ts`, `ipc.validators.ts`, `checkout.ipc.ts` (the five completion/recovery channels of
plan §2.9 — the existing `checkout.ipc.ts` only carries Phase 3E's single `checkout:validate` preview
channel), `posApi.ts`, and every renderer/`.vue` file (`checkout.service.ts`, `payment.store.ts`,
`cart.store.ts`, `PaymentPanel.vue`, `PosPage.vue`, `SaleRecoveryBanner.vue`). Fresh-process/SIGKILL
crash tests and the full fault-injection sweep at every enumerated write boundary remain CP-5b
territory per the plan's own acceptance-matrix "Where" column. CP-5a artifact generation and BE-3F-2B
backend integration are untouched.
