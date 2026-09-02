# CP-1 Durable Schema and Repository Foundation Checkpoint

Date: 2026-08-29

Scope: desktop CP-1 only — migration 0007, the four new repositories, the two additive existing-
repository changes, the shared row-shape contract, and real Electron-ABI schema tests. Explicitly
**out of scope, not touched**: services, IPC, renderer — those are CP-2/CP-3/CP-4. No production
database was touched; every test ran against a disposable sandboxed SQLite file (never `:memory:`,
per the harness's own integrity checks) using the real shipped Electron better-sqlite3 build via
`scripts/runElectronNode.mjs`, not a separate system SQLite.

Depends on (both implemented and reverified this session in the backend repo): BE-3F-5 (allocation
persistence/conservation) and BE-3F-3 (historical upload authority, D2-B allocation-consumption
wire contract) — see `pos-backend/docs/audits/be-3f-3-historical-upload-checkpoint.md` and
`phase-3f-execution-ledger.md`. BE-3F-2A's golden fixture (`desktop-invoice-upload-request-golden.json`)
was consulted for the exact `items.*.allocations.*` field names and bounds so the local schema's
allocation-consumption row shape is wire-compatible with what BE-3F-2B will eventually validate.

## Result

- Migration `0007_local_sale_persistence`: PASS — transcribes the plan's §5.3/§5.4 DDL exactly
  (`sale_attempts`, `local_invoices`, `local_invoice_items`, `local_invoice_payments`,
  `stock_allocation_grants`, `local_stock_allocation_consumptions`, `local_stock_movements`, plus the
  additive partial unique index on the shipped `sync_queue`). Every new table is `STRICT`; every
  integer quantity/money column carries an additional `typeof(x)='integer'` guard. No shipped
  migration (0001-0006) was edited.
- Fresh install: PASS — all seven tables present, all `STRICT`, migration count deep-equals exactly
  `databaseMigrations` in order.
- Version-6 upgrade path: PASS — a database migrated only through 0006 (`session_epoch` etc.)
  receives migration 0007 additively; its pre-existing `session_epoch` row is byte-identical
  afterward.
- Schema-vs-service invariant split (plan §5.2) holds exactly as specified: every row-local CHECK
  named by the plan is proven by a real failing INSERT on the shipped ABI; invariants the plan marks
  "not enforced by schema" (at-least-one-movement-per-tracked-line, allocation-consumption-sum-equals-
  line-quantity, invoice-discount-vs-taxable-base, `Σ items = grand_total`, payload reconstruction)
  are correctly left to CP-2's service layer and are not falsely asserted here.
- §5.5 regression coverage (real Electron ABI, `tests/electron/suites/localSalePersistenceSchema.suite.ts`,
  28 cases): fractional-value rejection on STRICT integer columns; `local_stock_movements` can never
  be `synced` or carry `synced_at` (§3.7 safety interlock); `local_invoices.sync_status='synced'`
  requires non-null `synced_at`; fixed/percentage discount bounds; untrimmed/blank payment reference
  rules; one movement per item; the partial unique index on `sync_queue` invoice/upload rows; at most
  one `claimed` attempt per owner with any number of valid committed-unacknowledged rows; every
  attempt state/timestamp/intent-retention CHECK pairing named by the plan; the exact UTF-8
  **byte** boundary at 65,536/65,538 bytes (plan probe P7, reusing its own `'é'` vector rather than a
  hand-derived one); connectivity-state/`sold_while_offline` pairing; allocation grant
  finalization-triple and lifecycle-generation/sealed_at pairing; allocation-consumption FK, gap-free
  sequence, and acknowledged-identity rules; zero-row assertions in every new business table on a
  fresh database (replacing the retired absence-of-nonexistent-table assertions, per plan §7b).
- Repository foundation (`tests/electron/suites/localSaleRepositories.suite.ts`, 5 cases, constructed
  exclusively through `realRepositories()` per the harness's own construction-integrity rule):
  `SaleAttemptRepository` claim → commit → acknowledge, and independently reject/abandon, each
  purging `intent_json` exactly where D6-A requires; `StockAllocationRepository.remainingMilli()`
  computed from immutable grant and committed-consumption rows only, never a mutable cache;
  `BootstrapSnapshotRepository.getBranch()/getWarehouse()` reading the existing singleton tables;
  the `sync_queue` partial unique index enforced end-to-end through the repository.
- No repository opens its own transaction; every write method is a single prepared statement, so the
  caller's (CP-2's) business transaction owns atomicity, per the plan's stated invariant.
- `syncQueue.repository.ts` now takes an injected clock (`now: () => string`, defaulting to
  `() => new Date().toISOString()`), matching the pattern already used for `createUuid` elsewhere in
  this codebase (`DeviceIdentityService`) — the one behavioral change to a shipped file, and purely
  additive (existing callers keep identical behavior since the default is unchanged).

## What changed

New:

- `src/main/database/migrations/0007_local_sale_persistence.ts`
- `src/main/repositories/{saleAttempt,localSale,localStock,stockAllocation}.repository.ts`
- `src/shared/contracts/sale.contract.ts`
- `tests/electron/suites/localSalePersistenceSchema.suite.ts` (28 tests)
- `tests/electron/suites/localSaleRepositories.suite.ts` (5 tests)

Modified:

- `src/main/database/migrations/index.ts` — registers migration 0007.
- `src/main/repositories/bootstrapSnapshot.repository.ts` — `getBranch()`, `getWarehouse()`.
- `src/main/repositories/syncQueue.repository.ts` — injected clock.
- `tests/electron/index.ts` — registers the two new suites.
- `tests/electron/suites/schema.suite.ts` — the 7 new tables and their indexes added to the existing
  exact-alphabetical `deepEqual` assertions.
- `tests/electron/support/openTestDatabase.ts` — `openPreLocalSalePersistenceTestDatabase()`
  (migrations 0-6, for the version-6-upgrade test).
- `tests/electron/support/realRepositories.ts` — wires the four new repositories, with the same
  `instanceof` assertions as every existing entry.
- `scripts/databaseSmoke.ts` — the 7 new tables added to the smoke check.

## Incident: unintended reformatting, caught and reverted before this report

While iterating, `npm run format -- <file>` was run intending to format only the new schema suite;
the underlying script is `prettier --write .` and the extra argument did not scope it — it
reformatted the entire repository. This silently rewrote three committed cross-repo golden fixtures
(`pos-calculator-golden.json`, `pos-calculator-exceptions-golden.json`,
`pos-request-validation-golden.json`, 4-space → 2-space indentation, no content change) and 19
documentation files including `CLAUDE.md` (Markdown table re-padding, no content change). Caught by
running `npm run verify:fixture`, which failed on the resulting byte mismatch against the backend
copies. All 22 affected files were reverted with `git checkout --` before proceeding; `verify:fixture`
and `git status` were re-run clean afterward. No content change survived; the lesson is recorded here
rather than repeated silently.

## Verification evidence

All commands actually executed, in this repository, after the revert above:

| Command | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run lint` | PASS (0 errors, 0 warnings) |
| `npm run test` (vitest) | PASS — 524 tests, 81 files |
| `npm run smoke:database` | PASS |
| `npm run test:sqlite:electron` | PASS — 78 tests (50 pre-existing + 28 new schema + repository-foundation cases folded in), 0 failures |
| `npm run verify:fixture` | PASS — all three existing cross-repo fixtures byte-identical (unaffected by CP-1; BE-3F-2A's new fixture is not yet a desktop-side cross-check target, since CP-5a has not run) |
| `npm run build` | PASS |
| `git diff --check` | PASS |

## Security boundary confirmation

No IPC channel, `contextBridge` surface, or renderer file was touched. No SQLite access was added
outside the main-process repository layer. No new dependency was added. The desktop app's
`contextIsolation`/`nodeIntegration`/`sandbox` settings were not touched.

## Explicitly deferred to CP-2 (not implemented here, per plan scope)

Existing-state dispatcher, semantic intent fingerprinting, retry/context-changed handling, the
atomic business transaction (steps 1-18 of the plan's transaction sequence), allocation-splitting
across multiple usable grants for one cart line, post-write invariant reconciliation, D3/D4/D5
metadata mapping, and all IPC/service/renderer work. `applicationServices.ts` was deliberately not
touched — CP-2 wires the new repositories into it alongside the new services.
