# CP-5e — Desktop corrective checkpoint

Date: 2026-09-02

Scope: CP-5e-1, the desktop half of CP-5e-3, CP-5e-4, CP-5e-5, and CP-5e-6
only. This checkpoint does not reimplement backend CP-5e-2, begin CP-5e-7 or Phase 3G, add a
sync/upload worker, enable allocation release, alter calculator arithmetic, or authorize production
activation.

## Baseline and authority

- Revision 4 was read completely before editing. Its checked-in SHA-256 is
  `279539d2992e1feb7d4f2c5afe1dc8485732abfcde40f2e002899c1cab923b0b`.
- Desktop baseline: branch `main`, HEAD `6fd3c790947e788eaa229b3c62859dd455a444d9`,
  89 pre-existing dirty porcelain entries, status checksum
  `5fe86e56825854f6d7e841a83121f95fcf9ec25e90dfa95eeb4c65728ece319d`.
- Backend read-only baseline: branch `main`, HEAD
  `a19bcdd243ed70497fed74d502db068f50733434`, 102 pre-existing dirty porcelain entries, status
  checksum `eed95cac7777c9691f078fc134f7f64a5659760d8cc9c06b4bb00470e61bbc8a`.
- The backend HEAD and status checksum remained exactly unchanged at every bounded recheck. No
  backend command, database write, formatter, test, or file mutation was performed.
- The prior backend report was read from
  `pos-backend/docs/audits/cp-5e-backend-legacy-allocation-enforcement-and-envelope-fixture.md`.
  Its full SQLite, strict MySQL, and five MySQL concurrency results are historical prerequisite
  evidence only; they were not rerun here.

## Implemented Revision 4 corrections

### CP-5e-1 — refresh cannot resurrect local consumption

The non-vacuous Electron test uses the production full-snapshot persistence entry point and a real
file-backed migrated SQLite database. It ingests one active 1000-milliunit grant, commits one
tracked 1000-milliunit sale through `LocalSaleService`, and observes one invoice, item, payment,
stock movement, pending allocation consumption, and invoice upload row. It then ingests a higher
revision whose stale backend projection still says active, consumed zero, and remaining 1000.

The refresh preserves the pending consumption and every business-table digest. Remaining authority
stays zero, an offline second sale is rejected as `stock-allocation-unavailable`, all business
tables remain byte-identical, and reopen still reports zero remaining. A second case proves two
partial pending consumptions are subtracted exactly once and an untracked sale creates neither an
allocation consumption nor a stock movement.

### Desktop CP-5e-3 — Laravel envelope parity

The immutable backend artifact was located at
`pos-backend/tests/Fixtures/stock-allocation-envelope-golden.json` and copied byte-for-byte to
`tests/fixtures/stock-allocation-envelope-golden.json`.

| Integrity property | Verified value |
| --- | --- |
| Raw SHA-256, both files | `ee71f33fa919983626fae769b831184b1bb47d44eb2de108a9bef995407fa049` |
| Independently recomputed canonical SHA-256 | `bdd091b018a08155b81f258167d56a926bd4520a88097a7c6f09c8b8ae9ae83b` |
| Schema version | `1` |
| Allocation contract version | `1` |
| Lifecycle statuses | `active`, `revocation_pending`, `seal_acknowledged`, `released`, `consumed` |

`verifyFixtureParity.mjs` now rejects missing/divergent bytes, wrong raw or canonical hashes,
unsupported versions/canonicalization, malformed fragments, and lifecycle drift. Vitest feeds every
Laravel resource case through the one strict allocation schema and feeds the supplied bootstrap and
top-up fragments through their actual consumer schemas. Unknown keys and string revision drift fail
closed.

### CP-5e-4 — deterministic allocation-consumption ordering

`StockAllocationRepository.consumptionsForInvoice()` now orders by the exact Revision 4 semantic
tuple: `item_local_uuid ASC, consumption_sequence ASC, allocation_uuid ASC`. The split-grant test
deliberately makes grant-selection order differ from payload order, permutes insertion order, runs
`ANALYZE`, closes/reopens via fresh Electron processes, replays integrity, and acknowledges the
immutable result. Allocation arrays, payload JSON, payload hash, and queue-table digest remain
byte-identical. No migration rewrites already committed payloads.

### CP-5e-5 — claim and commit epochs are distinct audit facts

The business transaction captures current main-owned session context at its authoritative boundary,
repeats user/company/device, sell, shift, branch, warehouse, catalog, and allocation guards, and
stores that current epoch as `commit_session_epoch`. `claim_session_epoch` remains immutable.

Real Electron coverage proves normal and same-session process-restart commits have equal epochs;
an actual end-session followed by same-owner relogin and fresh main-owned shift authority commits
with a later current epoch; replay cannot rewrite it. Different user ownership stays opaque,
foreign company/device and inactive sessions are policy-blocked, a revoked device is denied, and a
stale/changed shift is `context-changed`. IPC rejects renderer fields named `sessionEpoch`,
`claimSessionEpoch`, or `commitSessionEpoch`.

### CP-5e-6 — uniform tax mode

Invoice tax mode is derived from the authoritative resolved-product mode set, never from the first
intent item. Exactly one mode is required before persistence. The post-write invariant additionally
requires every stored item mode to equal the invoice mode inside the atomic transaction.

Coverage includes none, inclusive, exclusive, multiple same-mode products in both item
permutations, none/inclusive and inclusive/exclusive rejection before committed business writes,
and deliberate post-write item corruption rolling back with an invariant rejection. This preserves
the frozen `single_invoice_mode` policy. Supporting a mixed mode would require a new backend upload
contract version, fixture, and migration and remains outside Phase 3F.

The CP-5a artifact was not edited. Desktop and backend copies remain byte-identical at raw SHA-256
`f7456f37f9bf08af7d579df756cf92520f09cfff46a54b6d3912d3e6de328406`.

## Files changed by this checkpoint

Production:

- `src/main/repositories/stockAllocation.repository.ts`
- `src/main/services/localSale.service.ts`

Verification and support:

- `scripts/verifyFixtureParity.mjs`
- `src/main/http/desktopResources.contract.test.ts`
- `src/main/ipc/checkout.ipc.test.ts`
- `tests/electron/suites/bootstrapSnapshot.suite.ts`
- `tests/electron/suites/catalogRefresh.suite.ts`
- `tests/electron/suites/localSaleCompletion.suite.ts`
- `tests/electron/suites/localSaleRecovery.suite.ts`
- `tests/electron/support/failingDatabase.ts`
- `tests/electron/support/localSaleFixture.ts`
- `tests/electron/support/recoveryWorker.ts`
- `tests/fixtures/stock-allocation-envelope-golden.json`
- `docs/audits/cp-5e-desktop-corrective-checkpoint.md`

No dependency was added.

## Verification ledger

Every listed command ran in this checkpoint. The final results are:

| Command | Result |
| --- | --- |
| Focused Vitest, 16 exact files listed below | PASS — 16 files, 222 tests, 0 failed, 0 skipped |
| `npm run typecheck` | PASS — node TypeScript and renderer Vue TypeScript |
| `npm run lint` | PASS — 0 errors, 0 warnings |
| `npm run test` | PASS — 90 files, 730 tests, 0 failed, 0 skipped |
| `npm run verify:fixture` | PASS — all five fixtures byte-identical and independently verified |
| `npm run smoke:database` | PASS — Electron SQLite migration smoke |
| `npm run test:sqlite:electron` | PASS — 169 tests, 0 failed, 0 skipped |
| `npm run build` | PASS — main, preload, and renderer production bundles |
| `git diff --check` | PASS |

Focused Vitest files: `desktopResources.contract.test.ts`, `checkout.ipc.test.ts`,
`allocationAcquisition.service.test.ts`, `catalogRefresh.service.test.ts`,
`localSale.fingerprint.test.ts`, `localSale.payload.test.ts`, `saleCompletion.service.test.ts`,
`shiftAuthority.service.test.ts`, `stockAllocation.service.test.ts`,
`electronHarnessIntegrity.test.ts`, `payment.store.test.ts`, renderer `importBoundary.test.ts`,
`paymentCalculator.importBoundary.test.ts`, `posCalculator.golden.test.ts`,
`posCalculator.importBoundary.test.ts`, and `posCalculator.test.ts`.

The Electron command registers 23 suite files through `tests/electron/index.ts`; it reported 169
tests and zero skipped. The Electron bundler printed only its informational output-size marker. No
test, lint, typecheck, fixture, smoke, build, or diff warning remains.

One earlier lint invocation run concurrently with other gates exited 2 because the workspace's
read-only `.agents` directory was transiently absent while ESLint scanned the root. The directory
was present on the immediate bounded recheck, no checkpoint write-set file changed, and the
subsequent sequential lint plus the final lint both passed with zero findings. This was recorded as
an environment/transient invocation failure, not hidden as a source-code pass.

## Worktree, security, and remaining manual work

- Desktop HEAD remains unchanged. The final porcelain has the 89 baseline entries plus only the new
  copied fixture entry; existing dirty work was preserved. Nothing is staged.
- Backend HEAD and status checksum are unchanged; backend repository modified: no.
- Electron security boundaries remain intact: no new IPC channel, preload method, renderer
  authority, generic `ipcRenderer`, filesystem/SQLite/HTTP/token exposure, or admin endpoint.
- Allocation release remains disabled. No upload, sync, retry, seal, release, or Phase 3G worker was
  added.
- Manual GUI smoke was not run. Renderer visual/manual behavior remains pending for the final Phase
  3F gate; this checkpoint automates the high-risk persistence proofs.
- Nothing was staged, committed, pushed, deployed, or activated.

Phase 3F remains conditional; this desktop corrective checkpoint is green but is not production
authorization.
