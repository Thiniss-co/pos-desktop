# BH-04B-3 — Desktop Persistence and Coverage Reconciliation

Slice 3 of the BH-04A safe stock-allocation recovery contract
(`docs/architecture/bh-04a-stock-allocation-recovery-contract.md`, §11). This phase makes desktop
persistence and reconciliation compatible with the backend evidence BH-04B-1 and BH-04B-2 already
prepared. It does not activate recovery.

Evidence tags follow the BH-04A contract's §1 convention (**Observed** / **Reported** /
**Inferred** / **Proposed** / **Unknown**); everything below not otherwise marked is **Observed**
from this session's own work.

> **BH-04B-3-R1 (2026-09-06):** a focused review found that this document's original §9 concurrency
> claim exceeded its own described test (a timestamp comparison that slow process startup alone
> could satisfy, not genuine evidence of overlap), that §8's guarantee-6 wording called a
> same-process thrown-exception rollback and a graceful close/reopen "ordinary crash," and that this
> document's §3/§6 wording was imprecise about the SQLite `defer_foreign_keys` behavior and the
> lint command's actual exit code. All four are corrected in place below (§3, §6, §8, §9), with the
> superseded original wording retained inline and marked so, rather than deleted. §14 is the new,
> consolidated correction record (§13 is a separate addition: the manual GUI checklist evidence).
> The migration, payload-negotiation, hash-parity, and
> reconciliation-predicate work itself was not found to be defective by this review and required no
> change — only the evidence describing two specific claims did. No backend change was needed.

## 1. Baseline

| Repo | Branch | Full HEAD | `git status --porcelain -uall` at session start |
|---|---|---|---|
| `pos-backend` | `main` | `1432bff179414ccbb962a4c013c36a0b56930cc7` | 15 modified + 10 untracked (BH-04B-1/1-R1/2 working-tree state) |
| `pos-desktop` | `main` | `91841cc624d05e40cd860ae58ccec829ba57ec39` | 1 modified (`docs/audits/phase-3g-manual-gui-smoke-checklist.md`) |

Both HEADs are unchanged at the end of this session — nothing was committed, pushed, reset,
stashed, or cleaned in either repository. Every pre-existing modified/untracked file from both
baselines is preserved exactly as found; this phase only adds to it.

### 1.1 A rules note, recorded rather than silently resolved

`pos-desktop/.ai/guidelines/no-go-rules.md` rule #1 and `CLAUDE.md` §2 declare this repository
frontend-only and forbid backend changes "of any kind." This task's own text explicitly requires
backend changes to `pos-backend` (the wire-negotiation and one-transaction-read work in §2 of the
task). The task instruction governs here as an explicit, scoped exception — backend changes were
made only under `app/Modules/{Inventory,POS,Sync}/**`, `tests/**`, and `docs/**`, following the
existing BH-04B-1/2 pattern of touching backend code from a session whose primary repository is
`pos-desktop`. This is not a standing precedent for future desktop-repo sessions; it applies to this
authorized task only.

## 2. Files changed, by repository

### 2.1 `pos-backend`

| File | Change |
|---|---|
| `app/Modules/Inventory/Enums/AllocationPayloadVersion.php` (new) | The negotiation enum: `Legacy=1`, `Reconciliation=2`, the request-field name, and `fromRequestValue()` (accepts both a JSON int and a query-string numeric string, fails safe to `Legacy`). |
| `app/Modules/Inventory/Http/Requests/TopUpStockAllocationsRequest.php` | Adds `allocation_payload_version` (`sometimes`, `integer`, `Rule::in([1,2])`). |
| `app/Modules/Sync/Http/Requests/DesktopBootstrapRequest.php` | Same rule, for the bootstrap query string. |
| `app/Modules/Sync/Data/DesktopBootstrapData.php` | Carries the resolved `AllocationPayloadVersion` from the request. |
| `app/Modules/Inventory/Services/StockAllocationService.php` | New `bootstrapAllocationSnapshot()` (one transaction: live list + per-allocation coverage + terminal markers + revision); new `coverageForAllocations()` helper; `topUp()` gains an `$includeReconciliation` parameter and returns `coverage` from inside its existing transaction on both the fresh-commit and exact-replay paths. |
| `app/Modules/Inventory/Actions/TopUpStockAllocationsAction.php` | Accepts and forwards the resolved payload version. |
| `app/Modules/Inventory/Http/Controllers/DesktopStockAllocationController.php` | Resolves the version from the request and calls `StockAllocationResource::collectionWithCoverage()`. |
| `app/Modules/Inventory/Http/Resources/StockAllocationResource.php` | Adds a `withCoverage()` setter (not a second constructor argument — see §4) and `collectionWithCoverage()`; `null` reproduces the original 21-key `toArray()` byte-for-byte. |
| `app/Modules/Sync/Actions/BuildDesktopBootstrapAction.php` | Calls `bootstrapAllocationSnapshot()` instead of the old separate `forBootstrap()`/`revision()` calls. |
| `app/Modules/Sync/Http/Resources/DesktopBootstrapResource.php` | Uses `collectionWithCoverage()`; emits `stock_allocation_terminal_markers` only under the reconciliation representation. |
| `app/Console/Commands/GenerateStockAllocationEnvelopeGoldenFixture.php` | Adds a `reconciliation` section to the golden fixture: real journal-v1 chains per representative allocation, the empty-prefix boundary, terminal-marker cases (including one marker for an allocation absent from the live list), and v2 top-up/bootstrap fragments. `resourceKeys` (legacy, 21) is unchanged. |
| `app/Console/Commands/GenerateDesktopInvoiceRequestHashGoldenFixture.php` (new) | Generates the cross-language request-hash vector from the real `UploadDesktopInvoiceData`/`UploadDesktopInvoiceRequest` pipeline: 5 cases (minimal, non-ASCII notes/barcode, forward-slash reference, multi-line/multi-allocation/discounted, positive UTC offset). |
| `tests/Fixtures/stock-allocation-envelope-golden.json` | Regenerated with the `reconciliation` section. |
| `tests/Fixtures/desktop-invoice-request-hash-golden.json` (new) | The request-hash golden vector, committed. |
| `tests/Feature/DesktopStockAllocationApiTest.php` | 8 new HTTP tests for the negotiation (see §4). |
| `tests/Unit/GenerateDesktopInvoiceRequestHashGoldenFixtureTest.php` (new) | 4 tests proving the fixture matches deterministic regeneration and the real validation/hashing path. |

No route, migration, config, model, or enum outside the above was touched. `DesktopInvoiceResource`
and its coverage block (slice 1) are unchanged.

### 2.2 `pos-desktop`

**New:**

| File | Purpose |
|---|---|
| `src/main/database/migrations/0009_allocation_lifecycle_reconciliation.ts` | The forward migration: table rebuild, journal-evidence columns, reconciliation tables, backfill. |
| `src/main/database/serializedWrite.ts` | `runSerializedWrite()` — `BEGIN IMMEDIATE` with a narrow BEGIN-only retry. |
| `src/main/services/allocationJournal.ts` (+ `.test.ts`) | Journal-v1 reimplementation, uuid5 derivation. |
| `src/main/services/invoiceRequestHash.ts` (+ `.test.ts`) | The immutable invoice request-hash reimplementation. |
| `src/main/services/allocationReconciliation.service.ts` | The §3.1 boundary predicate and terminal-marker application. |
| `tests/fixtures/stock-allocation-journal-v1.json`, `tests/fixtures/desktop-invoice-request-hash-golden.json` | Byte-for-byte copies of the backend-generated vectors. |
| `tests/electron/support/allocationScenario.ts` | Shared real-SQLite scenario builders for the new suites. |
| `tests/electron/support/allocationConcurrencyWorker.ts` | The two-process concurrency worker (not imported by `index.ts` — spawned as its own bundle, like `recoveryWorker.ts`). **[R1: rewritten — see §14.]** |
| `tests/electron/suites/allocationLifecycleMigration.suite.ts` | §7 items 1-2. **[R1: gained a dedicated real-orphan safety-gate regression — see §14.]** |
| `tests/electron/suites/allocationCoverage.suite.ts` | §7 items 5-9, 11 (predicate half). |
| `tests/electron/suites/allocationTerminalMarkers.suite.ts` | §7 items 10, 12. |
| `tests/electron/suites/allocationCheckoutConcurrency.suite.ts` | The two-OS-process checkout-vs-reconciliation proof. **[R1: rewritten — see §14.]** |

**Modified:**

| File | Change |
|---|---|
| `src/main/database/migrator.ts` | Adds the opt-in `rebuildsForeignKeyReferencedTable` flag and the FK-toggle-around-the-transaction logic (see §3). **[R1: doc comment corrected — see §14.]** |
| `src/main/database/migrations/index.ts` | Registers migration 0009. |
| `src/main/repositories/stockAllocation.repository.ts` | Fixes `writeBootstrapGrant()`'s hardcoded `status='active'`; adds `AllocationRepresentation`, coverage/marker/hold CRUD, `spendableMilli()` (replaces `remainingMilli()`), `latestJournalChainHash()`, `committedQuantityAboveSequence()`, `journalEntriesFor()`. |
| `src/main/repositories/bootstrapSnapshot.repository.ts` | Resolves representation/coverage/markers from the response; applies them via `AllocationReconciliationService` inside the existing bootstrap transaction. |
| `src/main/services/localSale.service.ts` | Checkout moves to `runSerializedWrite()`; consumption rows now carry journal-v1 evidence, computed from the frozen upload payload's own request hash; payload array order restored to `(sequence, allocation_uuid)` (see §7 finding). |
| `src/main/services/allocationAcquisition.service.ts` | Top-up requests `allocation_payload_version:2`, applies returned coverage via `runSerializedWrite()`. |
| `src/main/services/allocationDeficit.ts`, `src/main/services/catalog.service.ts`, `src/main/services/stockAllocation.service.ts` | Renamed call sites for `spendableMilli()`. |
| `src/main/sync/invoiceUpload.client.ts`, `src/main/sync/invoiceUploadOutcome.ts`, `src/main/sync/invoiceUploadWorker.ts` | Surface and apply the upload response's `allocations[]` coverage block (slice 1's block, previously parsed and silently dropped by the `.passthrough()` schema) inside the existing outcome transaction. |
| `src/main/http/desktopResources.contract.ts` (+ `.test.ts`) | Adds `stockAllocationCoverageSchema`, `stockAllocationReconciliationResourceSchema`, `stockAllocationEnvelopeSchema` (union), `stockAllocationTerminalMarkerSchema`; wires them into the bootstrap/top-up schemas; names the upload response's `allocations[]` block instead of leaving it to `.passthrough()`. |
| `src/main/app/applicationServices.ts` | Wires `AllocationReconciliationService` into the three consumers. |
| `src/shared/constants/apiRoutes.ts` | Bootstrap route requests `?allocation_payload_version=2`. |
| `src/shared/contracts/sale.contract.ts` | `LocalStockAllocationConsumptionRow` gains the journal-evidence fields. |
| `scripts/verifyFixtureParity.mjs` | New byte-parity checks for the two new fixtures; structural checks for the envelope fixture's `reconciliation` section. |
| `tests/electron/support/openTestDatabase.ts` | `openPreAllocationReconciliationTestDatabase()`, `runTestMigrations()`. |
| `tests/electron/support/realRepositories.ts` | Wires `AllocationReconciliationService` the same way production does. |
| `tests/electron/index.ts` | Registers the four new suites. |
| `tests/electron/suites/schema.suite.ts`, `localSalePersistenceSchema.suite.ts` | Updated expected table/index lists; the two migration-0007 CHECK tests are replaced with tests against the corrected migration-0009 rules (the old ones asserted the exact defect this slice fixes). |
| `tests/electron/suites/catalogRefresh.suite.ts`, `localSaleRepositories.suite.ts` | Renamed `remainingMilli` → `spendableMilli` call sites. |

## 3. Root cause and lossless-migration evidence

**Root cause (confirmed against actual source, not historical line numbers).** Migration 0007's
`stock_allocation_grants` carries `CHECK ((status = 'active') = (sealed_at IS NULL))` and a
`released`-coupled `final_consumption_*`/`finalized_at` rule, both against the *legacy* `status`
column. `StockAllocationRepository.writeBootstrapGrant()` hardcoded `status = 'active'` while writing
the server's real `sealed_at`/`final_consumption_*` values. Any `revocation_pending` (sealed),
`seal_acknowledged`, `released`, or `consumed` envelope therefore violated one of those two CHECKs
and aborted the entire bootstrap/catalog transaction — reproduced directly against the actual
pre-0009 schema in `allocationLifecycleMigration.suite.ts`'s first test, which asserts the exact
`CHECK constraint failed` SQLite error for both broken rules before any fix is applied.

**A second, harder defect found during implementation — corrected in R1.** *(Original wording,
superseded: "SQLite refuses `DROP TABLE` of a table another table holds a foreign key to whenever
`PRAGMA foreign_keys = ON`, regardless of `PRAGMA defer_foreign_keys`." That was broader than what
was actually tested and is wrong as a general claim; the precise, re-verified behavior follows.)*

SQLite's `DROP TABLE` performs an implicit `DELETE FROM` on the table first
(sqlite.org/foreignkeys.html §5). This schema's foreign keys are plain (non-`DEFERRABLE`), so that
implicit delete's constraint violation is checked immediately by default — a bare `DROP TABLE` of
`stock_allocation_grants` fails right away while `local_stock_allocation_consumptions` still holds a
referencing row. Re-verified directly (not merely re-asserted) with a minimal repro and `PRAGMA
defer_foreign_keys = ON` set for the transaction: `DROP TABLE` then **succeeds** — the violation is
deferred, not refused, contradicting the original claim above. The actual, confirmed problem is
narrower: even after creating a fully-populated replacement table and renaming it back to the
original name, with `PRAGMA foreign_key_check` reporting **zero violations** at that point,
mid-transaction, `COMMIT` still fails with `FOREIGN KEY constraint failed`. The deferred-violation
state SQLite recorded during the implicit delete is not reconciled by the later rename, even though
the data is by then fully self-consistent by any real measure. Separately, `PRAGMA foreign_keys =
OFF` is confirmed a genuine no-op once a transaction is already open (the pragma's own read-back
value stays `1`/ON after attempting to set it to `0` inside `BEGIN`), so it must be disabled *before*
the transaction starts.

This is exactly SQLite's own documented procedure for this category of schema change
(sqlite.org/lang_altertable.html §8, "Making Other Kinds Of Table Schema Changes"), not a workaround
invented for this migration: disable `foreign_keys`, start the transaction, rebuild, run `PRAGMA
foreign_key_check` before commit, commit, then re-enable `foreign_keys`. `DatabaseMigration`
therefore gained an opt-in `rebuildsForeignKeyReferencedTable` flag implementing exactly that
sequence; the migrator disables `foreign_keys` strictly before opening that migration's transaction
and restores it strictly after, in a `finally`, so every other migration's atomicity is completely
unaffected. The migration's own `PRAGMA foreign_key_check` call — asserted before `up()` returns —
remains the actual safety gate: with enforcement off for the duration, a genuine orphaned row would
otherwise commit silently. This gate previously had only ever run against migration 0009's own
correct rebuild, which has never actually found anything wrong — a positive empty result alone does
not prove the gate would refuse a real orphan. A dedicated regression added in R1
(`allocationLifecycleMigration.suite.ts`, "the FK-rebuild safety gate genuinely refuses a real
orphan and restores enforcement") now runs the same mechanism against a throwaway two-table schema
with a migration deliberately written to lose one row during its rebuild, and confirms: the gate
throws, `schema_migrations` never records success, both toy tables and rows are restored exactly,
`foreign_key_check` is empty afterward, `PRAGMA foreign_keys` reads back `1`, and a fresh orphan
insert still fails. The exact SQLite version linked via `better-sqlite3` in this environment is
`3.53.2` (queried directly via `sqlite_version()` through the Electron-node harness, compiled with
`DEFAULT_FOREIGN_KEYS`).

**Lossless-migration evidence.** `allocationLifecycleMigration.suite.ts` builds representative
pre-existing rows against the real pre-0009 schema — a partially consumed grant
(`server_consumed_quantity_milli=1000`), a pending invoice with its frozen upload payload in
`sync_queue`, and a committed local consumption row — then applies migration 0009 and asserts:
every pre-existing grant/invoice/sync_queue row is byte-identical (`deepEqual`) before and after
except the legacy-status mirror (verified column-by-column); the child table's foreign key still
resolves to the rebuilt parent (`PRAGMA foreign_key_check` returns `[]`, and a new row referencing a
nonexistent allocation still fails); every required index survives; and a **failing** migration
(the real one, wrapped to throw immediately after finishing its work) leaves the exact pre-0009
schema and rows on disk, proven both from the in-process handle and from a genuinely separate
read-only connection (`readCommitted()`).

**Journal evidence is backfilled, not invented.** A dedicated test seeds a legacy consumption row
with its frozen `sync_queue.payload_json` present, and confirms the backfilled `request_hash`
matches the shared cross-language golden vector exactly, with a correctly derived
`item_line_uuid`/`chain_hash`. A second test removes the frozen payload and confirms the row is
**retained untouched** (quantity, sequence unchanged) with NULL journal columns, and its grant is
recorded in `stock_allocation_holds` with reason `unreconstructable_prefix` — `spendableMilli()`
returns `0` for it.

## 4. Payload negotiation and compatibility matrix

`allocation_payload_version` (`AllocationPayloadVersion`, `Legacy=1` / `Reconciliation=2`) is a
fifth, explicit **response-representation** axis — deliberately not one of the BH-04A §9.3 four
version axes. It never touches a grant envelope version/hash, a journal-v1 byte, an invoice-contract
version, or a persisted seal-proof version, and it is never authorization or a safety claim.

| Request | Legacy (absent or `1`) | Reconciliation (`2`) | Unsupported value |
|---|---|---|---|
| `GET /bootstrap` | `stock_allocations[]` — exactly the original 21 keys; no `stock_allocation_terminal_markers` key at all | 24-key envelopes (21 + `accepted_consumption_sequence`/`accepted_consumed_quantity_milli`/`accepted_chain_hash`); `stock_allocation_terminal_markers[]` present (`[]` when none) | `422 VALIDATION_ERROR`, no mutation |
| `POST /stock-allocations/top-up` | `data[]` — exactly 21 keys | `data[]` — 24 keys | `422 VALIDATION_ERROR`, no mutation |
| `POST /invoices/upload` | unchanged (slice 1's `allocations[]` block, unaffected by this axis) | unchanged | n/a — this endpoint has no version field |

Both directions proven at the HTTP layer in `DesktopStockAllocationApiTest.php` (8 new tests) and at
the desktop schema layer in `desktopResources.contract.test.ts` (6 new tests using the committed
golden fixture's `reconciliation` section) — including that a legacy request's response still
parses through the pre-existing `.strict()` schemas unchanged, that the reconciliation envelope's
extra keys are exactly the coverage triple and nothing else, and that a partial coverage triple
(one of the three keys missing) is rejected by the schema rather than defaulted.

**Compatible rollout order (documented; no deployment authorized by this work).** Backend ships
first — it is additive and answers every existing (non-negotiating) desktop exactly as before.
The desktop cohort updates second; only a client that explicitly requests
`allocation_payload_version=2` ever receives or depends on the coverage/marker fields. An old
desktop binary reaching an updated backend is unaffected (it never requests the field). An updated
desktop reaching an old backend degrades to the legacy representation and the conservative
`server_consumed_quantity_milli = 0` guard — never to a fabricated boundary.

**What this negotiation does not do.** It does not repair an already-shipped desktop binary's
sealed-envelope persistence defect — an old binary without migration 0009 still aborts on a sealed
envelope regardless of what the backend sends. Response negotiation alone never makes an old client
recovery-capable; only the desktop upgrade in this slice does.

## 5. Boundary validation, hash parity, spendability, terminal markers, transactions

**Coverage boundary** (`AllocationReconciliationService.applyCoverage()`) implements the exact §3.1
list in order: identity/ownership/generation match; bounded-safe-integer and well-formed-hash
checks; monotonicity (a lower sequence is silently ignored; an equal sequence with a different
quantity or hash is a `conflict`, never an idempotent update); the complete contiguous local prefix
`1..s` must exist and `s` may not exceed the highest sequence this device actually authored; the
recomputed journal-v1 chain hash and prefix quantity must equal the declared ones exactly (`s=0`
requires exactly `q=0` and the backend initial hash); and the resulting
`spendable = granted - q - Σ(uncovered local quantity above s)` must be a non-negative safe integer,
never clamped. Lifecycle revision plays no part in any of this — an unchanged revision never blocks
a newer valid boundary. Every rejection writes a durable `stock_allocation_holds` row (except
`unknown-allocation`, which has no local identity to key one on) and is cleared only by a subsequent
write that itself re-verifies the evidence.

**Hash parity.** `allocationJournal.ts` reimplements the backend's exact byte framing (two distinct
NUL-terminated domain prefixes, UTF-8 **byte**-length-prefixed fields, hex-decoded chaining) and is
proven against the shared `stock-allocation-journal-v1.json` vector, including its deliberately
non-ASCII `invoice_idempotency_key` and the empty-prefix case. `invoiceRequestHash.ts` reimplements
`json_encode`'s escaped-slash/`\uXXXX` behavior, Carbon's UTC/microsecond normalization, and
Laravel's rule-declaration key order, proven against the new `desktop-invoice-request-hash-golden.json`
vector across five adversarial cases. Both fixtures are copied byte-for-byte into
`pos-desktop/tests/fixtures/` and checked by `npm run verify:fixture` on every run.

**Spendability.** `spendableMilli()` (replacing `remainingMilli()`) implements the exact §3.1 formula
under `reconciliation_v2` and preserves the original conservative-guard behavior byte-for-byte under
`legacy` — proven directly: grant 10.000 / local committed 3.000 remains exactly 7.000 whether the
boundary or the local row arrives first, and acknowledgement status (`pending` vs `acknowledged`)
never changes the result, because nothing in the arithmetic reads it.

**Terminal markers.** `id` is confirmed (from backend source, not assumed) to be the allocation
uuid — the same value a live envelope publishes as its own `id`. Markers are scoped to the
authenticated company/device, retained even when the allocation is absent locally, permanent once
written (a later stale active envelope, omission from a list, or a process restart cannot undo one —
each proven with a real restart via `closeDatabase`/`openTestDatabase` reopening the same on-disk
file), and non-regressing on `(lifecycle_generation, terminal_revision)` via a `WHERE` guard on the
write itself. Inconsistent terminal evidence (a marker arriving while local consumption above the
accepted boundary is uncovered) holds the grant with reason `terminal_conflict` and never deletes
the local evidence. A different allocation terminalizing never touches an unrelated allocation's
`last_observed_revision` eligibility or spendable balance (proven at both the coverage-service level
and via `usableGrantsForProduct()`, which is where revision gating actually lives — the same place
it lived before this slice; `spendableMilli()` was never the revision gate).

**Transactions.** Bootstrap applies grants, coverage, markers, and the revision watermark in one
`database.transaction()` (unchanged transactional shape, extended contents). Top-up applies its
returned coverage inside its own existing transaction via `runSerializedWrite()`. Invoice-upload
outcome applies its `allocations[]` coverage inside the same transaction that resolves the
`sync_queue` row. Checkout itself moved from `database.transaction()` (`BEGIN DEFERRED`) to
`runSerializedWrite()` (`BEGIN IMMEDIATE`), with a retry that fires **only** when the transaction
itself could not begin — contention raised from inside an already-entered closure propagates as the
pre-existing `isStorageFailure` path, which already leaves the sale attempt `claimed` and safely
retryable.

## 6. Test totals and commands actually executed

### Desktop

| Command | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.node.json --composite false` | Clean |
| `npx vue-tsc --noEmit -p tsconfig.web.json --composite false` | Clean |
| `npm run lint` (`eslint --cache .`) | **[R1 correction: the original row here said "0 errors... lint clean" while the same row went on to name two pre-existing errors — an internally inconsistent headline. Corrected.]** Actual exit code **1** (nonzero). `25 problems (2 errors, 23 warnings)` before R1's own prettier pass; **`9 problems (2 errors, 7 warnings)`** after it. Both remaining errors are `@typescript-eslint/explicit-function-return-type` in `tests/electron/support/cp3g5/seedReliability.mjs`; all 7 remaining warnings are `prettier/prettier` formatting nits in `scripts/cp3g5LiveUpload.mjs`, `tests/cp3g5HarnessLifecycle.test.mjs`, and the same `seedReliability.mjs`. All three files are confirmed untouched by this session or the original one (`git diff --stat HEAD` against each is empty). Every file either session touched has **zero** ESLint errors; only `prettier/prettier` formatting warnings, resolved by `npx prettier --write` on exactly those files. Not fixing the three pre-existing files is a scope decision, not an oversight — recorded here rather than folded into a blanket "clean." |
| `npx prettier --write <files this session touched>` | Applied; re-typechecked and re-tested clean afterward |
| `npx vitest run` | **906 tests passed, 906 total, 102 files** |
| `node scripts/runElectronNode.mjs tests/electron/index.ts` | **[R1: counts updated — one new migration-safety regression and the rewritten concurrency suite added two net tests.]** **281 tests, 247 passed, 0 failed, 34 skipped** (all 34 skips are the pre-existing "no live CP-3G-5 backend provided" gate, unrelated to this slice). One run reported per change, not three — see §14 for why the original "repeated three times" framing was itself part of what R1 corrects. |
| `npm run verify:fixture` | All 7 fixtures verified byte-for-byte against `pos-backend`, including the two new ones |
| `npm run build` (`typecheck && electron-vite build`) | Clean; `out/main`, `out/preload`, `out/renderer` all built |
| `git diff --check` | Clean |

### Backend

| Command | Result |
|---|---|
| `php artisan test --compact` | **868 tests, 858 passed, 10 skipped, 4,410 assertions** (10 skips are the pre-existing disposable-MySQL-only opt-in groups from BH-01/BH-02/BH-03/BH-04B-1, plus this session's own MySQL-gated tests are none — this slice added no MySQL-only test) |
| `vendor/bin/pint --dirty --format agent` | First pass fixed 4 files (trailing commas, brace position); second pass: `{"result":"passed"}` |
| `php artisan test --compact --filter=...` (the touched suites, after pint) | 48 tests, 48 passed, 488 assertions |
| `php artisan architecture:scan-routes` | Clean |
| `php artisan architecture:scan-permission-matrix` | Clean |
| `php artisan architecture:report --strict` | Exit 1, **exactly** the pre-existing `CompanyUserPermissionController::assignableRoles` (25 lines, max 20) finding — not touched, not suppressed |
| `php artisan config:show stock_allocations.release_enabled` | `false` |
| `git diff --check` | Clean |

MySQL-specific verification was not run for this slice: no changed backend transaction or query in
this slice carries a concrete MySQL-specific risk beyond what BH-04B-1/2's own disposable-MySQL
campaigns already covered (`bootstrapAllocationSnapshot()` is a plain read wrapped in
`DB::transaction()`, using the same lock order and the same underlying queries `forBootstrap()` and
`coverageBoundary()` already had individually).

## 7. A correctness finding surfaced and fixed during this slice's own test-writing

Restructuring the checkout transaction to compute journal evidence (which requires the frozen
upload payload's own request hash, computed from the payload after it is built) initially changed
the order consumption rows were inserted relative to the payload's own array order. The existing
test `split-grant payload order is stable across insertion permutations, ANALYZE, and process
restart` caught this immediately: it asserts the wire payload's `allocations[]` array is ordered by
`(consumption_sequence, allocation_uuid)`, independent of grant-selection order, because that array
order is hashed downstream by both `payloadHash()` locally and the backend's `request_hash` (which
every journal entry in this slice now binds). The consumption list is explicitly sorted before the
payload is built, restoring the original invariant; the pre-existing test (unmodified) now passes
again. No production behavior outside this slice's own new code was at risk — the test exists
specifically because payload order is semantic, and it did its job.

## 8. §10.3 guarantees: what this slice establishes and what remains

| # | Guarantee | Status after this slice |
|---|---|---|
| 1 | Checkout and sealing cannot spend/seal the same generation concurrently, proven at the transaction boundary | **Not addressed** — sealing does not exist yet on the desktop. This slice proves checkout-versus-*reconciliation* (bootstrap/top-up/upload-coverage) at the real two-process level; checkout-versus-*seal* remains slice 4. |
| 2 | The local seal and its "no later sale" boundary commit atomically and survive crashes | **Not addressed** — no seal request exists on the desktop yet (slice 4). |
| 3 | The final journal includes every locally committed consumption, gap-free, including pending uploads | **Partially established.** Journal-v1 is now computed and verified locally for every *new* consumption from this slice forward, and coverage validation itself enforces gap-free contiguity as a precondition for acceptance. A complete cross-checkout, cross-crash proof that no committed consumption is ever missing from an eventual seal request is slice-4 scope (sealing does not exist here to seal against). |
| 4 | Journal-v1 bytes/hashes match the backend golden vectors exactly, bound to company/device/allocation/generation/nonce | **Established** for the journal-v1 byte framing and chaining itself (proven against the shared cross-language vector, including the empty prefix). The nonce binding is a seal-acknowledgement concept (slice 4); it does not exist in this slice's scope. |
| 5 | Every declared entry uploads idempotently before acknowledgement; lost responses and out-of-order delivery converge without deleting or relabelling pending evidence | **Partially established — corrected in R1.** *(Original wording, superseded: flatly "Established.")* This slice has **no desktop seal request or acknowledgement orchestration at all** (that is slice 4), so "every declared entry uploads... before acknowledgement" cannot be evaluated here — there is no acknowledgement flow yet to check it against. What **is** established, and re-verified across two genuinely independent OS processes in R1 (§14): the six §3.1 coverage-arrival scenarios converge correctly regardless of order, upload acknowledgement never flips a consumption to `acknowledged` or deletes it (there is no writer for that transition anywhere in this slice or before it), and a rejected/early boundary is held rather than lost. The seal-journal-declaration half of this guarantee remains slice-4 scope in full. |
| 6 | Bootstrap and local persistence accept all lifecycle states, reject revision/generation rollback, apply terminal markers durably, reconcile the §3.1 boundary, and do not revive released rights under ordinary crash and retry | **Established for the cases actually exercised — corrected in R1.** *(Original wording, superseded: "ordinary crash/retry is proven (a killed migration rolls back... a reopened database after a normal close retains every marker/boundary)" — "killed" overstated what was tested.)* Two specific, named mechanisms were exercised, and only these: (a) **same-process transaction rollback after a thrown JS exception** — the migrator's `database.transaction(fn)()` wrapper catches a thrown `Error` and issues `ROLLBACK`; proven for migration 0009 failing after its own work completes, and separately for the R1 orphan-safety-gate regression. (b) **Persistence across a graceful `close()`/reopen of the same connection** — used for the terminal-marker "restart" tests. Neither exercises an abrupt process termination (no `SIGKILL`, no signal, no crash without cleanup handlers) or host/power-loss durability; this slice contains **no** fault-injection or process-kill test for migration, coverage, or terminal-marker persistence. (Pre-existing, unrelated `SIGKILL` coverage exists for the invoice-upload/sync-queue path via CP-3G-6 — it does not touch allocation reconciliation and was not run again for this correction.) Abrupt-termination coverage for the reconciliation/migration paths specifically is a **named verification gap**, not claimed here and not silently assumed away — appropriate follow-up work for slice 4 or a dedicated hardening pass. Detected/explicit restoration has no dedicated entry point in this app (see §10) — documented as a gap, not built as a new feature. Arbitrary undetected storage rollback remains explicitly unsupported and undetectable, exactly as the contract states. |

## 9. Concurrency evidence and its limits

**This entire section was rewritten in R1; see §14 for why.** The original version described a
mechanism whose only evidence of overlap was a wall-clock comparison — the coverer's write-
transaction-acquisition timestamp against the holder's insertion time plus a fixed 400ms hold — and
claimed that comparison as proof of real serialization. It is not: that inequality is also satisfied
whenever the coverer process simply takes at least ~300ms to spawn, load its bundle, and reach its
own `BEGIN IMMEDIATE`, which real Electron process startup routinely does, **regardless of whether
its transaction was ever attempted while the holder's lock was held**. Running the suite three times
and getting the same counts does not close that gap, because process-startup latency on one machine
is itself fairly consistent — a passing run says nothing about whether genuine contention occurred
on that run or any other.

`allocationCheckoutConcurrency.suite.ts` (rewritten) runs two **genuinely separate Electron/Node
processes**, each with its own independent SQLite connection against one on-disk sandbox file — not
two connections driven from a single JS thread, and not a sequential mock standing in for
concurrency. It now uses direct, instant-in-time evidence of contention instead of a timing
inference.

**The corrected mechanism.** The competing process sets `PRAGMA busy_timeout = 0` on its own
connection — the exact connection `LocalSaleService` goes on to use — and attempts
`BEGIN IMMEDIATE`. With a zero busy timeout, SQLite grants the lock immediately or fails immediately
with `SQLITE_BUSY`/`SQLITE_LOCKED`; there is no internal wait for scheduling jitter to be confused
with. Observing that failure is direct evidence that another connection holds the write lock at that
exact instant. Only after the probe is `busy_timeout` restored to the production value (5000ms) and
the real code path (`setUpAuthorizedContext()`'s setup writes, then `LocalSaleService.complete()`)
allowed to proceed — it now blocks and waits exactly as production does, rather than failing fast.
Because SQLite allows only one write transaction per database file at a time, confirming the lock
was held immediately before this process's *first* write is sufficient to show every later write on
that same connection — setup and the real sale alike — was also still blocked: there is no way a
later write on the same connection could have run before an observed-busy probe on that connection.
The holder (`hold-lock`) never fabricates a consumption row — `BEGIN IMMEDIATE` alone already takes
the RESERVED lock that blocks a second writer, so holding it open is sufficient contention by
itself — and it holds until an explicit parent-written release file appears, never a fixed sleep, so
the parent fully controls when release happens and can require contention to be positively observed
first.

**Test 1 — sensitivity check (negative control).** With no holder started at all, the same probe
mechanism reports `busy: false`. This is the check that the probe is discriminating — that it can
actually report "no contention" — rather than assuming a mechanism nobody has shown can ever report
`false` is meaningful when it reports `true`. During R1's own verification (not part of the
committed suite), an ad-hoc variant of the main test with the holder deliberately never started was
run standalone: the probe reported `busy: false`, and the main test's own load-bearing assertion
(`equal(probeResult.busy, true, ...)`) was confirmed to throw against that result —
`AssertionError [ERR_ASSERTION]: false !== true` — demonstrating the assertion actually catches a
bypassed boundary rather than passing unconditionally. The ad-hoc file was deleted after use; the
committed suite's own `probe-only` sensitivity test is the permanent, equivalent record.

**Test 2 — the real checkout path composes correctly with reconciliation under genuine, evidenced
contention.** Everything is seeded through the exact production fixture every other checkout suite
in this repo uses (`setUpAuthorizedContext`, `localSaleFixture.ts`), including a real allocation
grant. A holder process takes the write lock and waits. A second process writes a "ready" marker,
runs the busy probe (confirmed `busy: true` — the parent asserts this before proceeding, and fails
the test outright if it is ever `false`), restores `busy_timeout`, then calls the real
`setUpAuthorizedContext()` and the real `LocalSaleService.complete()` for one sale of the tracked
product. Only after the probe result is observed does the parent release the holder. Final state,
read by a fourth, independent connection after both processes exit: exactly one real consumption
row (not a synthetic insert — `rights_generation`, `request_hash`, and `chain_hash` are all
populated by the actual production checkout code), which `AllocationReconciliationService
.applyCoverage()` then accepts using the *real* values read back from that row, never a value the
test precomputed — proving the two paths compose correctly end to end, not merely that each works in
isolation.

**Test 3 — sequential cross-process ordering (not a concurrency race; described accordingly).**
*(Original wording, superseded: this was previously described inline as part of the same
"concurrency" proof without qualification.)* Three processes run one after another, each fully
`await`ed to completion before the next starts: an early coverage message (rejected,
`sequence-beyond-local-history`, held), a real committed sale, then a later coverage message
(accepted, clears the hold). This is a genuine cross-process ordering/recovery proof — each side
really does run in its own OS process — but the two sides are never open at the same time, so it
establishes nothing about lock contention. It is now documented as sequential, matching what it
actually does.

**What this establishes and what it does not.** Test 1 (sensitivity) and Test 2 (contention +
composition) together establish that the real checkout path and reconciliation cannot interleave to
corrupt state, with direct evidence of overlap rather than an inference from timing. It says nothing
about checkout-versus-*seal* (no seal request exists on the desktop yet) or any backend-side release
race — both are explicitly out of this slice's scope and remain slice 4's disposable-MySQL
release-race campaign. It is also not a stress/fuzz campaign across many random interleavings: it
exercises one specific, deliberately engineered interleaving (reconciliation's connection genuinely
contending with an open checkout-side write) plus its negative control, rather than a broad random
schedule search.

## 10. Historical local rows and restoration

No pre-existing desktop-produced local database was available to inspect in this environment (this
is a development checkout, not a fielded device), so no *actual* historical row was found to be
unreconstructable in practice. The migration's backfill path was exercised against representative
synthetic rows built to look exactly like the real shape (a legacy grant plus a committed
consumption row with, and separately without, its frozen `sync_queue.payload_json` present) — the
"payload missing" case is the one that would occur on a real device if, for example, a retention
policy had already purged old queue rows before this migration ran. Any such row is held
(`stock_allocation_holds`, reason `unreconstructable_prefix`) rather than spent; there is no
enumerable list of them from this session because none exist in this environment.

**Restoration.** This app has no backup mechanism, no `PRAGMA integrity_check` usage, and no down
migrations anywhere in the codebase (confirmed by inspection of `src/main`, not merely absence of
a keyword hit) — the migrator's own per-migration transaction is the entire recovery mechanism. There
is consequently no dedicated "detected restoration" entry point to wire a mandatory fresh-bootstrap
requirement into. This is documented here as the actual current state, per the task's instruction
not to build a backup product: a database restored by copying a stale snapshot over the current
file would present terminal markers and coverage boundaries consistent with *that* snapshot's own
revision watermark, and the existing `last_observed_revision`/capability-revision mechanism already
means a subsequent live bootstrap re-establishes current, correct state the next time the app
successfully connects — but nothing in this app *requires* that bootstrap to happen before allowing
a sale, because no such gate exists anywhere in the current architecture (online/offline selling is
governed by `canSell`/`canSync` and catalog/allocation snapshot presence, not by a "reconciliation
freshness" flag). Building that gate was out of this slice's scope and is not attempted here.

## 11. Scope confirmation

- `config('stock_allocations.release_enabled')` is `false` (confirmed live via
  `php artisan config:show`) and untouched by any file in this slice.
- No desktop seal request, acknowledgement orchestration, or finalizer command exists anywhere in
  this diff. `grep` for `requestSeal`/`acknowledgeSeal`/finalizer-style naming in `src/main` outside
  the pre-existing test/service surface confirms nothing new was added.
- No automatic release, new business endpoint, UI feature, or monitoring surface was added.
- `canSell`/`canSync`, licensing, feature, permission, device-binding, tenant/warehouse ownership,
  and `blocked_sync` behavior are unchanged — every eligibility gate this slice's new code composes
  with (`usableGrantsForProduct()`'s existing owner/status/expiry/revision predicates) is the exact
  pre-existing set, with only the two additions the task specified: a `NOT EXISTS` against terminal
  markers and a `NOT EXISTS` against holds.
- Offline eligibility was not broadened; service-item rules were not touched (this slice's scope is
  entirely within `track_stock` allocation accounting, which service items never enter).
- All prior BH-04B-1/1-R1/2 backend work and all pre-existing desktop working-tree state are
  preserved exactly as found (§1).

## 12. Remaining slice-4 and slice-5 work

**Slice 4** (cooperative sealing, finalization, targeted verification): the desktop seal
request/no-more-sales boundary and its own local persistence; the console finalizer; canonical
multi-allocation lock order (§8.2 of the contract); the six §10.3 guarantees' remaining
checkout-versus-seal proof; the disposable-MySQL release-race campaign (upload vs release, upload
vs acknowledgement, duplicate finalize, multi-allocation invoice vs release, top-up vs seal — both
commit orders).

**Slice 5** (activation, separately authorized): classifying every existing non-terminal allocation
as reconciled-v2 or legacy-hold; staged rollout of the compatible desktop cohort; only then, as a
separate authorization, enabling `release_enabled` for v2-proven rows. No migration in this slice
releases anything, bulk or otherwise.

## 13. Manual GUI acceptance evidence (`phase-3g-manual-gui-smoke-checklist.md`) — unresolved, not this slice's to close

That checklist is Phase-3G user-executed acceptance evidence, frozen against desktop commit
`9a1232ba90b3a2fe3799bc42d02bca1d14c79c22` — a commit *older* than this repository's current HEAD —
and its own header still reads `Status: NOT RUN`. It was not edited, no item was marked, and no
automated result from this slice is used to satisfy any item in it; none of that would be valid per
the checklist's own rules (an automated test or a `SELECT` is explicitly not a substitute for the
on-screen observation it asks for).

The document already contains user-entered results predating this session, recorded here as
observations this slice neither produced nor has resolved:

- **E1 (recorded FAIL):** attempting a sale while the backend is unavailable reported "One or more
  tracked products do not have enough stock allocated to this workstation," rather than the expected
  behavior (the sale completing locally with the sync indicator showing one pending invoice).
- **E2 (recorded PASS):** automatic upload on backend recovery, with the note that it synced "all
  invoices" once the backend returned.
- **E3 (recorded FAIL):** with the backend down, "all products DISABLED" and no product could be
  added to cart — the offline sale the restart scenario needs could not be created at all.

**What this slice does and does not say about those results.** E1's error text names an allocation-
eligibility rejection; E3 describes being unable to add any product to the cart at all while
offline, which — if accurate — would block ordinary offline selling entirely, independent of
allocation reconciliation specifically. Neither observation is proven, by this slice or any of its
tests, to have been caused by the BH-04B-3 changes: the checklist's own frozen commit predates this
work, its baseline/timing relative to any specific catalog or allocation state was not captured, and
"all products disabled" is not evidence that service-item (non-allocation) selling was independently
verified to work — it may equally indicate every seeded product in that manual session happened to
be tracked-stock, or a separate, pre-existing offline-eligibility condition. Investigating the actual
cause is separate work this slice does not undertake, and nothing here bypasses allocation, catalog,
or license checks to make either scenario pass. These two results stand as open, unresolved desktop
acceptance findings — not silently closed, not required to be re-run before this correction is
considered complete, and not claimed fixed by anything in BH-04B-3 or BH-04B-3-R1.

## 14. BH-04B-3-R1 — focused corrections (2026-09-06)

A follow-up review found four issues in this document's original evidence and wording. All are
closed below; §3, §6, §8, and §9 above carry the corrected text inline (marked where superseded),
and this section is the consolidated record. No production defect was found in the migration,
payload-negotiation, hash-parity, or reconciliation-predicate logic itself — R1's only production
change is two additional, targeted regression tests (§14.3) and doc-comment wording corrections
(§3, and the migrator/migration-0009 source comments); the migrator's actual behavior already
matched SQLite's own documented procedure before this review.

### 14.1 Confirmed issues and their resolution

| # | Area | Status |
| --- | --- | --- |
| 1 | The two-process concurrency test's only evidence was a timestamp comparison satisfiable by slow process startup alone | **Confirmed, corrected** — replaced with a `busy_timeout=0` probe giving direct, instant-in-time evidence of lock contention; see §9 and §14.2. |
| 2 | "Killed migration" / "ordinary crash and retry" wording described a thrown-exception rollback and a graceful close/reopen | **Confirmed, corrected** — §8 guarantee 6 now names exactly the two same-process mechanisms exercised (thrown-exception rollback, graceful close/reopen) and states plainly that no abrupt-termination (`SIGKILL`) or power-loss evidence exists for this slice's own paths. |
| 3 | The `defer_foreign_keys` explanation claimed `DROP TABLE` of an FK-referenced parent is refused unconditionally | **Confirmed inaccurate, corrected** — re-verified directly: `DROP TABLE` *succeeds* under `defer_foreign_keys=ON`; the actual, narrower defect is that `COMMIT` still fails afterward even when the data is provably self-consistent (`foreign_key_check` empty) mid-transaction. See §3 and §14.4. |
| 4 | The lint summary and this document's own test-count/lint rows were inconsistent or imprecise | **Confirmed, corrected** — §6 now reports the actual `npm run lint` exit code (1, from two confirmed-pre-existing, confirmed-untouched errors) rather than an unqualified "clean," and reports one accurate test count rather than "repeated three times" framed as if repetition itself were the concurrency proof. |

### 14.2 The corrected concurrency mechanism and its evidence

Covered in full in the rewritten §9. Summary of what changed mechanically: `allocationConcurrencyWorker.ts`'s
`hold-write` (fixed 400ms sleep, synthetic row insert) is replaced by `hold-lock` (bare
`BEGIN IMMEDIATE`, no synthetic row, holds until an explicit release file — never a sleep) plus
`probe-and-checkout` and `probe-only` (the `busy_timeout=0` contention probe, and the real
`setUpAuthorizedContext()`/`LocalSaleService.complete()` checkout path). The suite file
(`allocationCheckoutConcurrency.suite.ts`) was rewritten to match; its top-of-file doc comment
explains the mechanism and explicitly states what R1 changed and why.

### 14.3 Migration safety: the negative path, added

R1 adds one regression to `allocationLifecycleMigration.suite.ts` — "the FK-rebuild safety gate
genuinely refuses a real orphan and restores enforcement" — using a throwaway two-table toy schema
and a deliberately buggy toy migration that loses one row during its rebuild. It proves the exact
mechanism migration 0009 relies on (the migrator's `rebuildsForeignKeyReferencedTable` toggle plus
the migration's own `PRAGMA foreign_key_check` gate) actually refuses a genuine orphan: the gate
throws, `schema_migrations` never records the migration's version, both toy rows survive exactly,
`foreign_key_check` is empty afterward, `PRAGMA foreign_keys` reads back `1`, and a fresh orphan
insert against the unchanged toy schema still fails. R1 also added explicit
`PRAGMA foreign_keys`-value and orphan-insert-fails assertions to both of the pre-existing migration
tests (the successful-migration test and the thrown-exception test), so enforcement restoration is
checked directly rather than only implied by the absence of a later error. No real user database was
touched or ever at risk; every check in this section runs against disposable sandbox files.

### 14.4 The SQLite reference material used

Fetched and quoted directly from the two references named in this review's own task text:

- sqlite.org/foreignkeys.html §5 ("CREATE, ALTER and DROP TABLE commands") — confirms `DROP TABLE`
  performs an implicit `DELETE FROM` first, that plain (non-`DEFERRABLE`) foreign keys are checked
  immediately by default (failing `DROP TABLE` right away), and that `PRAGMA defer_foreign_keys`
  defers that check to `COMMIT` instead.
- sqlite.org/lang_altertable.html §8 ("Making Other Kinds Of Table Schema Changes") — the exact
  12-step procedure the migrator's `rebuildsForeignKeyReferencedTable` flag implements: disable
  `foreign_keys` before the transaction, rebuild, run `foreign_key_check` before `COMMIT`, commit,
  re-enable `foreign_keys` afterward.
- sqlite.org/pragma.html's `PRAGMA defer_foreign_keys` entry — confirms it defers *all* foreign key
  constraints for the current transaction (even non-`DEFERRABLE` ones), resets to `OFF` at every
  `COMMIT`/`ROLLBACK`, and must be re-enabled per transaction.

The exact linked SQLite version (`3.53.2`, via `better-sqlite3` under the Electron-node harness) and
the precise repro sequence (create/copy/drop/rename, `foreign_key_check` empty mid-transaction,
`COMMIT` still failing) are recorded in §3.

### 14.5 Verification for this correction

- `npx tsc --noEmit -p tsconfig.node.json --composite false` — clean.
- `node scripts/runElectronNode.mjs tests/electron/index.ts` — **281 tests, 247 passed, 0 failed, 34
  skipped** (net +2 over the pre-R1 280-test count reported the first time this suite existed: the
  rewritten concurrency suite now has 3 tests instead of 2, and the migration suite gained 1 orphan
  regression).
- `npx vitest run` — **906 tests, 906 passed** (unchanged).
- `npm run lint` — exit 1; see §6 for the exact, unchanged-from-before-R1 breakdown of what those two
  errors are and that they are confirmed untouched by any session.
- `git diff --check` — clean.
- No backend command was re-run for this correction: no backend file changed (this review found no
  backend-side defect, so §2.1 of this document is unaffected by R1).

No production defect in checkout, reconciliation, coverage validation, or the migration's actual SQL
was found or changed by this review. `release_enabled` remained `false` throughout; no slice-4 work
(desktop seal request, acknowledgement orchestration, finalizer, canonical lock order, release-race
campaign) was started; nothing was committed, pushed, or deployed; the manual GUI checklist (§13)
was read but not edited; all prior recovery work and all unrelated pre-existing working-tree state
were preserved exactly as found (§1).

## 15. Is slice 3 ready as a prerequisite for slice 4?

**Yes, with the concrete remaining items named below — no new blocker was found by this review.**

- The migration, wire-negotiation, journal/hash-parity, and coverage/terminal-marker logic itself
  was re-examined and not found defective; R1's changes are two additional regression tests and
  corrected documentation, not a behavior change to any of that logic.
- **Named verification gap, not a defect:** no abrupt-termination (`SIGKILL`)/power-loss evidence
  exists for the migration, coverage, or terminal-marker persistence paths specifically (§8
  guarantee 6). This is a legitimate candidate for slice 4 or a dedicated hardening pass, not a
  reason to withhold slice 3 as a prerequisite — slice 4 already owns the two-process
  checkout-versus-seal proof and the disposable-MySQL release-race campaign, both of which are
  larger, harder proofs than a same-repo crash-injection suite would be.
- Guarantee 5 (full declared-journal-before-acknowledgement) genuinely cannot be completed until
  slice 4 builds the acknowledgement flow it depends on — this is expected sequencing, not a defect
  in slice 3.
- The two unresolved manual GUI findings (§13, E1/E3) remain open desktop acceptance questions
  independent of this slice's own scope; they should be investigated on their own timeline and are
  not, on current evidence, shown to be caused by BH-04B-3.

No commit, push, deployment, or activation was performed. This report reflects a complete,
independently reviewable implementation and verification pass, ready for review.
