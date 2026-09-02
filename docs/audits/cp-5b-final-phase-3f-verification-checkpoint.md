# CP-5b — Final Phase 3F Verification Checkpoint

Date: 2026-08-29

Scope: desktop CP-5b only — the final automated integration, security, compatibility, and handoff
gate for Phase 3F. This checkpoint verified the work reported through CP-5a and BE-3F-2B against the
files and tests those reports cite, implemented the CP-5b suites the approved plan names, corrected
the defects those suites exposed, and re-ran the full desktop gate plus the read-only backend gate.

**It does not start Phase 3G.** No synchronization/upload worker, allocation release, receipt,
refund, payment processing, or credit-sale behaviour was added, and PD-3G-1 remains undecided.
Nothing was staged, committed, pushed, or deployed in either repository.

---

## 1. Plan authority and provenance

| Check | Result |
| --- | --- |
| Claude source plan `/home/hossam/.claude/plans/create-the-implementation-plan-zippy-newell.md` | SHA-256 `6f661d0a381878d0b05787266934128049ab866051ef28450f012e22a33983b8` |
| Approved destination `/var/www/html/thinis-pos/plans/POS_PHASE_3F_LOCAL_SALE_PERSISTENCE_PLAN.md` | SHA-256 `6f661d0a381878d0b05787266934128049ab866051ef28450f012e22a33983b8` |
| `cmp` of the two copies | **Byte-identical** |

The hash matches the one carried in the CP-5b instruction and in the BE-3F-2B report exactly. No
plan authority, fixture-byte, or checkpoint-ownership conflict was found, so no reconciliation was
attempted.

### Decision ledger (unchanged by this checkpoint)

| ID | Decision | Status entering CP-5b | Status leaving CP-5b |
| --- | --- | --- | --- |
| D1-A | Owner-only discover/retrieve/acknowledge/abandon without `pos.sell`; new/retry stay sell-gated | APPROVED | Implemented; now proven end-to-end (§6) |
| D2-B | Server-backed allocations only; no cached/shared-stock fallback | APPROVED | Enforced; proven in every connectivity state |
| D3-A | Tri-state connectivity, pessimistic offline mapping | APPROVED | Implemented |
| D4-A | `POS-<dev6>-YYYYMMDD-NNNNNN`, always local/non-fiscal | APPROVED | Implemented |
| D5-A | Notes kept in contract, always `null` in 3F | APPROVED | Implemented |
| D6-A | Intent retained only while claimed/unacknowledged; terminal purge | APPROVED | Implemented; proven |
| BE-3F-3-A | Shift-derived history, narrow sync upload, uploader audit, append-only adjustment | POLICY APPROVED, backend implemented | Reverified read-only |
| PD-3G-1 | Operator policy for non-stock terminal upload outcomes | PENDING | **Still pending — Phase 3G** |

---

## 2. Repository baselines

| Repository | Branch | HEAD | Baseline porcelain | Final porcelain | Staged |
| --- | --- | --- | ---: | ---: | ---: |
| `pos-desktop` | `main` | `6fd3c790947e788eaa229b3c62859dd455a444d9` | 51 (28 M, 23 ??) | 72 (38 M, 34 ??) | 0 |
| `pos-backend` | `main` | `a19bcdd243ed70497fed74d502db068f50733434` | 85 (38 M, 47 ??) | 85 (38 M, 47 ??) | 0 |

Both HEADs are unchanged. **The backend porcelain count is identical at baseline and at the end: no
backend file was created, modified, or deleted by this checkpoint** — backend verification was
read-only throughout. Every pre-existing uncommitted Phase 3F change in both repositories was
preserved.

The desktop delta of +21 entries is exactly the CP-5b files listed in §4 plus the separately
requested workstation-refresh feature in §5.

---

## 3. Baseline reconciliation — what was re-run versus what was inherited

Evidence is classified honestly. Nothing below is reported as executed unless it was executed in
this session.

| Claim | Source | Classification |
| --- | --- | --- |
| CP-1 migration/schema/repository foundation | `cp-1-schema-repositories-checkpoint.md` | **Source-inspected + re-executed** — its 28 schema and 5 repository cases run inside the 129-test Electron suite below |
| CP-2 attempt lifecycle and atomic persistence | `cp-2-attempt-lifecycle-checkpoint.md` | **Source-inspected + re-executed**, and extended (§6) |
| CP-3 IPC/security boundary | `cp-3-completion-recovery-ipc-checkpoint.md` | **Source-inspected + re-executed** in the vitest gate |
| CP-4 renderer completion/recovery | `cp-4-renderer-completion-recovery-checkpoint.md` | **Source-inspected + re-executed** in the vitest gate |
| CP-5a artifact integrity | `cp-5a-desktop-artifact-checkpoint.md` | **Re-executed now** — drift test green, artifact bytes unchanged |
| BE-3F-2A request-rule fixture | backend `be-3f-2a-request-fixture-checkpoint.md` | **Re-executed now** (read-only) |
| BE-3F-2B endpoint compatibility | backend `be-3f-2b-real-endpoint-compatibility-checkpoint.md` | **Re-executed now** (read-only) |
| BE-3F-3 historical upload | backend `be-3f-3-historical-upload-checkpoint.md` | **Re-executed now** (read-only) |
| BE-3F-5 allocation conservation | backend `be-3f-5-stock-allocation-checkpoint.md` | **Re-executed now** (read-only) |
| Historical desktop counts (596 tests / 85 files, 98 Electron tests) | CP-4/CP-5a reports | **Historically reported.** Re-measured from scratch in this session; both baselines reproduced exactly before any CP-5b change, then grew (§7) |

### Mandatory pre-gate checks

Both were run **before** any CP-5b change, and both passed:

| Check | Result |
| --- | --- |
| CP-5a Electron drift-detection test | **PASS** — "the committed CP-5a fixture is byte-identical to a freshly committed sale, never hand-authored" |
| `npm run verify:fixture` | **PASS** — all four artifacts byte-identical against `pos-backend` |

### Fixture parity

| Property | Value |
| --- | --- |
| Raw file SHA-256 (desktop) | `f7456f37f9bf08af7d579df756cf92520f09cfff46a54b6d3912d3e6de328406` |
| Raw file SHA-256 (backend) | `f7456f37f9bf08af7d579df756cf92520f09cfff46a54b6d3912d3e6de328406` |
| `cmp` | **Byte-identical** |
| Embedded canonical payload SHA-256 | `e5db457ee5e7eeb34d4fd9e01205fa31d43109156f58f8da1c7a1f9fe97a8bd4` |
| `schemaVersion` | `1` |
| `generatedFrom` | `pos-desktop` @ `6fd3c790947e788eaa229b3c62859dd455a444d9` |
| `emittingSuite` | `tests/electron/suites/cp5aArtifact.suite.ts` |
| BE-3F-2A golden request fixture | `5a23816b66244386c9c813769ec5d221e7075b240ff3e11a707c775e85d14ad2` |
| BE-3F-5 journal vector fixture | `e35378a68810682833655be16aa9423ac137692c80c2993575fbb6bdc67482c0` |

BE-3F-2B's endpoint fixture is the same bytes the desktop service produces: the backend copy hashes
identically, and the desktop drift test independently re-derived the payload from a freshly
committed sale through `LocalSaleService.complete()`.

**The CP-5a artifact was not edited, and its hash is unchanged after every CP-5b correction.** No
return through CP-5a, and therefore no BE-3F-2B re-run for artifact drift, was required. Neither
fixture copy was modified to make any test pass.

### Interlocks confirmed

- **Allocation release remains hard-disabled**: `config/stock_allocations.php` still has
  `'release_enabled' => false`. No desktop seal/release/revocation code path exists.
- **No Phase 3G worker or caller was introduced.** `SyncQueueRepository.enqueue` still has exactly
  **one** production call site — the completion transaction. No upload worker, scheduler, drain, or
  queue processor exists (source sweep for `uploadWorker|startUpload|drainQueue|processQueue` and
  timer-driven sync: zero hits).
- **Generated contracts use the approved schema versions** and no hand-authored fixture replaced a
  generated artifact — `verify:fixture` verifies each artifact's hash independently before comparing
  bytes across repositories.

---

## 4. Defects CP-5b found and corrected

Both are narrow corrections inside already-approved Phase 3F desktop scope, exposed by writing the
CP-5b gates the plan requires. Each has a regression test that fails without the fix.

### Defect 1 — post-write invariants were incomplete (plan step 18 / §5.2)

`runBusinessTransaction` asserted only two of the plan's enumerated invariants (`Σ items.total =
grand_total` and `Σ payments.amount = paid_total`). Missing were: row cardinality; `due_amount = 0`;
**one movement for every tracked line**; allocation-consumption sums equalling each tracked line and
being zero for every untracked line; every grant matching the immutable
company/device/warehouse/product origin; **exactly one `invoice`/`upload` queue row**; and the
plan's byte-for-byte payload reconstruction check.

This matters because plan §5.2 states explicitly that several of these *cannot* be schema-enforced:
`UNIQUE(item_local_uuid)` bounds movements from above but never guarantees a tracked line has one,
and no row-local CHECK can compare a consumption sum to its line quantity or a queued payload to the
rows it came from. Without them a tracked line could in principle commit with no stock movement, or
with allocation consumption that did not cover it, and nothing would notice.

Fixed by `LocalSaleService.assertPostWriteInvariants()`, called at step 18 inside the business
transaction, so any violation throws and rolls the entire sale back.

### Defect 2 — committed-result integrity was weaker than plan §1.6 item 3

`requireResultIntegrity()` — the check guarding **every** replay, retry, and acknowledgment of a
committed result — verified only that the attempt and invoice pointed at each other. Plan §1.6 item
3 requires it to independently verify the immutable rows, **exactly one invoice-upload queue row**,
`payload_hash` against canonical `payload_json`, and row-to-payload reconstruction equality.

As written, a corrupted or tampered queued payload, a mismatched payload hash, or a missing queue row
would have replayed as a normal, healthy `committed` result rather than the non-mutating
`integrity-inconsistency` the plan mandates. Plan §2.11 lists "bad payload hash" as a required test
and the cross-document consistency table requires exactly that outcome.

Fixed by extending `requireResultIntegrity()` with the full §1.6(3) verification, sharing one
`reconstructPayloadJson()` helper with the post-write invariants so the commit path and the replay
path can never disagree about what the payload should be.

Supporting change: `SyncQueueRepository.invoiceUploadRowsFor()` — a narrow, additive, read-only
accessor returning **all** matching rows (never `LIMIT 1`) so "exactly one" is genuinely assertable.

> **Note for the plan's §7f evidence.** `sync_queue` now has two production readers rather than one:
> `getStatus()` (a COUNT) and this integrity accessor. Neither consumes, transitions, uploads, or
> deletes a row. The concurrency suite pins this: every queued row stays `pending` with
> `attempt_count = 0`, and a behavioural network spy proves completion makes no outbound call.

---

## 5. Separately requested work — workstation-data refresh (stale catalog + overdue license)

Mid-checkpoint the user requested two related recovery flows: a stale-catalog refresh, then an
overdue-license recovery. Both are served by **one** action — "Refresh workstation data" — because
they are the same recovery: an overdue license denies `canSync`, which is exactly what blocks the
catalog refresh, so the chain has to fix the license first or nothing downstream can succeed.

This is **new user-facing capability, not a CP-5b verification defect**, and is recorded separately
for that reason. It does not alter the CP-5a artifact (hash re-verified unchanged afterwards) or any
Phase 3F sale path.

| Requirement | How it is met |
| --- | --- |
| Visible action beside the stale warning | `CatalogRefreshPanel.vue` replaces the bare stale `AppInlineError` in `PosPage.vue` |
| Narrow typed preload method, no direct HTTP/SQLite | `posApi.catalog.refresh()` → `catalog:refresh`; the renderer service is argument-free |
| Trusted sender, session, device/company, refresh authorization | `assertTrustedSender` **before** parse; `auth.ensureCatalogReadContext()` (authenticated session + active user + company/device); `bootstrap.refresh()`'s own activation and `assertCanSync()` gates |
| Reuse the authoritative refresh service | `CatalogRefreshService` composes the existing `BootstrapService.refresh()`; no new route, no new authority |
| Loading, success, timestamp, actionable error | Four mutually exclusive rendered states, each explicit |
| Prevent duplicate requests | Coalesced in `CatalogRefreshService` **and** guarded in the store; the control is disabled while pending |
| Atomic replacement of catalog/payment methods/customers/metadata/warehouse stock | `persistSnapshot()`'s single transaction; the store then swaps every cached view together |
| Recalculate stale/ready immediately | Status is re-read *after* persistence and returned in the result |
| Never silently reprice a cart | The service only *reports* `revisionChanged`; the existing `cart.setContract()` path raises `CART_CATALOG_CHANGED` and the page's existing rebuild-or-clear flow is the only way forward |

**Bug found by the user during this checkpoint and fixed.** The first implementation validated the
channel input as `z.object({}).strict()` while `posApi.catalog.refresh()` invokes with no argument,
so every real click returned "The request is invalid" before reaching the service. Corrected to
`z.undefined()`, matching this codebase's convention for no-input channels, which also rejects any
payload at all — including an empty object. The IPC test now invokes exactly as the preload does,
and an `['an empty object', {}]` rejection case was added, so this cannot regress silently.

### Overdue-license recovery

| Requirement | How it is met |
| --- | --- |
| Action beside the overdue message | `AccessBlockedPage.vue` renders **Refresh workstation data** next to the blocking message, alongside the existing Retry |
| Renderer invokes a narrow typed preload method | The same argument-free `posApi.catalog.refresh()`; the page and store send nothing |
| Main calls the existing license-validation endpoint | `LicenseService.validate()` → `DESKTOP_API_ROUTES.licenseValidate`. No new route was added |
| Securely and atomically persist license state + server-derived timestamp | `LicenseService.validate()` already owns this: OS-secured token via `secureStorage`, then `setValidatedStatus(status, trustedTimeAnchor)` where the anchor is derived from the **server's** `server_time` (monotonic against the existing anchor) |
| Never accept `lastValidatedAt` or license authority from the renderer | The channel input is `z.undefined()` — there is no field to send. `licenseValidatedAt` travels **outward only**, for display |
| Refresh the main-owned commercial-access decision | `commercialAccessPublisher.begin()/publish()` around validation, and again after bootstrap |
| Notify/refetch so the warning disappears immediately | Access is published straight after validation (pushed on `license:access-changed`) **and** returned in the result, so the store clears the block without a second round trip; the page then re-evaluates startup and routes back to POS |
| Continue with session, bootstrap, catalog, stock-allocation, stale-status refresh | Steps 3–6 of the chain: `ensureCatalogReadContext()` → `bootstrap.refresh()` (catalogue, payment methods, customers, warehouse stock) → recalculated catalog status |
| On failure retain fail-closed state and show the real error | Validation failure short-circuits the chain, publishes nothing, and rethrows the real error; the store keeps the block and replaces the message with that error (localized through the app's existing `localizeAppError` rules) |

Ordering is asserted directly, not assumed: tests prove `validate` precedes both the session step
and the bootstrap, that the access snapshot is published *between* validation and bootstrap, and
that a failed validation reaches neither.

A deliberate honesty detail: if validation succeeds as a *request* but the workstation is still
denied (an expired subscription, say), the store **does not** clear the block — it reports the
current decision. A completed request is not the same as a recovered workstation.

**Naming caveat.** The channel is still `catalog:refresh` and the class `CatalogRefreshService`,
which now understates what they do (license validation is the first step). The user-facing label is
correct — "Refresh workstation data" — but renaming the internals to `workstation:refresh` would be
a worthwhile, purely mechanical follow-up, and is deliberately left as a separate change rather than
churned in at the end of a verification checkpoint.

**Honest limitation — allocation data.** The requirement mentioned refreshing "allocation data
provided by bootstrap". The desktop bootstrap resource **carries no allocation subresource today**,
and `StockAllocationRepository.upsertGrant` has **zero production callers** (source-verified). A
refresh therefore neither grants nor revokes allocation rights. That is BE-3F-5 desktop-integration
work which has not landed, not something this checkpoint could invent without inventing backend
behaviour. It is pinned as an executable fact by an Electron-SQLite test asserting a refresh leaves
allocation grants, consumptions, invoices, and attempts untouched. The refresh therefore performs
"stock-allocation refresh" to the exact extent the server offers one today: none.

---

## 6. Functional, recovery, race, and security evidence

All evidence below is from tests executed in this session against the real shipped Electron
`better-sqlite3` ABI, in disposable sandbox databases under the system temporary directory. The
production workstation database was never opened, reset, migrated, or inspected.

### Suites added by CP-5b (the plan's own CP-5b suite list)

| Suite | Tests | Covers |
| --- | ---: | --- |
| `localSaleRecovery.suite.ts` (**fresh-process**) | 7 | SIGKILL before/after commit; discovery from disk alone; retry driven to completion; abandon; lost reply and lost acknowledgment; two committed-unacknowledged results across restart acknowledged independently; complete keyset pagination; new-session-epoch retrieval |
| `localSaleConcurrency.suite.ts` | 7 | Two completions in one tick; double-submit commits once and replays once; completion racing a bootstrap write; `SQLITE_BUSY` clean typed failure leaving `claimed` with zero partial rows; retry after that failure; behavioural no-outbound-network spy; queued rows never consumed |
| `localSaleAttempts.suite.ts` | 11 | Instrumented dry run enumerating real write boundaries; fault injection swept across **every** boundary; tampered payload / tampered hash / missing queue row; malformed and fingerprint-mismatched retained intent; impossible claimed-with-invoice shape; D1-A rights matrix; rejected and abandoned tombstones |
| `catalogRefresh.suite.ts` | 6 | Atomic catalogue replacement; stale→ready recalculation; revision-change reporting; rejected older snapshot; allocation evidence untouched; survives reopen |

`localSaleCompletion.suite.ts` (18 tests, the fourth suite the plan names) was preserved unchanged in
behaviour; its shared fixture was extracted to `tests/electron/support/localSaleFixture.ts` so the
new suites and the fresh-process workers build byte-identically the same state through the same
production code path. All 18 tests still pass.

### Fresh-process recovery is genuinely fresh

`runFreshProcess()` spawns a real separate Electron process per step. The crashing process is
hard-killed with `SIGKILL` at a chosen write boundary — a real process death, not a caught
exception. The recovering process shares no variable, service instance, or handle with it and finds
every attempt through `pendingAttempts()`, the same read-only discovery channel the recovery banner
uses. Per plan §2.11, each test drives recovery to a real retry, abandon, or acknowledgment rather
than stopping at a banner.

### Atomicity and failure boundaries

- The instrumented dry run counts the write boundaries actually issued (≥ 6: claim, invoice, item,
  payment, attempt update, queue insert), and the sweep injects a fault at **every** one of them.
- Every boundary leaves **zero** invoices, items, payments, movements, and queued uploads. No
  boundary produced a committed sale or a silent success.
- A precondition failure (`permission-denied`, `shift-unavailable`, `context-changed`,
  `refresh-required`) performs **zero writes** and leaves the row `claimed` — never mislabelled as a
  durable T3 rejection. Verified directly in the D1-A test.
- A post-rollback business rejection follows T3: `state='rejected'`, `failure_code` set,
  `intent_json` purged (D6-A), business tables empty.
- A storage failure (`SQLITE_BUSY`) is correctly distinguished from a rejection: it leaves the
  attempt `claimed` with its retained intent, and the same attempt then retries to exactly one sale.

### Tracked stock

Tracked-stock completion requires a matching, sufficient, unexpired allocation bound to the
originating company/device/warehouse/product. Insufficient, absent, and non-matching allocations are
refused before any durable write, **in every connectivity state including online** — the completion
suite asserts this explicitly against an online connectivity snapshot. Connectivity is recorded as
audit metadata only and is never stock authority. There is no cached/shared-stock fallback path.

### D1-A rights matrix

With `pos.sell` revoked mid-session: a new sale and a retry are both refused with a non-terminal,
zero-write code, and the blocking attempt remains `claimed`; discovery, retrieval, acknowledgment,
and abandonment all continue to work for the exact owner. No new sale resulted.

One honest detail: `commercialAccess.evaluate('sell')` consults `pos.sell` itself and is checked
first, so a revoked permission surfaces as `context-changed` rather than `permission-denied`. Both
are non-terminal and both preserve the recovery guarantees the plan requires, so the test asserts
that property rather than a specific code.

### Integrity inconsistencies fail closed

Tampered payload, mismatched payload hash, deleted queue row, malformed retained intent,
fingerprint-mismatched intent, and an impossible claimed-with-invoice shape all return non-mutating
`integrity-inconsistency`. Table digests taken before and after are identical: evidence is preserved,
never silently repaired or promoted.

### Security and architecture sweep

| Check | Result |
| --- | --- |
| Generic `ipcRenderer` exposure | **None** — `contextBridge.exposeInMainWorld('posApi', posApi)` only |
| `ipcRenderer` referenced anywhere in the renderer | **Zero hits** |
| Renderer SQLite/filesystem access | **None** in production renderer code |
| Token in `localStorage`/`sessionStorage` | **None** |
| Desktop request to `/api/v1/admin` | **None** — the string appears only in `desktopApiClient`'s blocklist and its test |
| Trusted-sender check on new write channel | `catalog:refresh` asserts **before** parse, like the five checkout channels |
| Renderer-supplied authority | Rejected: fabricated company/device/warehouse/revision/force payloads all fail validation before the service |
| Import boundaries / EN-AR parity / RTL / a11y / localized errors | Enforced by the existing suites, all still green |

Main re-derives and re-checks commercial access, session/device/user, `pos.sell`, shift authority,
originating context, catalog revision, payment methods, customer, allocation, totals, and tenders
inside the business transaction immediately before persistence. A checkout preview grants no
completion authority. No security test was weakened and no import/security exception was added.

---

## 7. Desktop automated gate — commands actually run

| Command | Result |
| --- | --- |
| `npm run typecheck` | **PASS** |
| `npm run lint` | **PASS** — 0 errors, 0 warnings |
| `npm run test` (vitest) | **PASS** — **649 tests, 87 files** (baseline 596/85 reproduced first) |
| `npm run verify:fixture` | **PASS** — 4 artifacts byte-identical across repositories |
| `npm run smoke:database` | **PASS** |
| `npm run test:sqlite:electron` | **PASS** — **129 tests, 0 failures** (baseline 98 reproduced first) |
| `npm run build` | **PASS** — 311 renderer modules |
| `git diff --check` | **PASS** — clean |

Electron test growth: 98 baseline → 129 (+7 recovery, +7 concurrency, +11 attempts, +6 workstation
refresh). Vitest growth: 596 → 649, measured per file: `catalogRefresh.service.test.ts` 17,
`catalog.ipc.test.ts` 33 (22 pre-existing + 11 refresh-security), `catalog.store.test.ts` 9 (1
pre-existing + 8), `CatalogRefreshPanel.test.ts` 9, `access/store.test.ts` 8 (3 pre-existing + 5),
plus 2 picked up automatically by `importBoundary.test.ts`'s directory sweep (31, was 29).

`npm run format` was **not** used — CP-1's recorded incident is that its underlying
`prettier --write .` reformats the whole repository including cross-repo golden fixtures. Only the
files this checkpoint touched were formatted explicitly, and `verify:fixture` was re-run afterwards
to prove no fixture byte moved.

---

## 8. Database and migration verification

| Check | Result |
| --- | --- |
| Fresh install through the final migration | **PASS** — `openTestDatabase` asserts the applied migration list deep-equals `databaseMigrations` in order, on every one of the 129 Electron tests |
| Upgrade from the exact pre-Phase-3F version (0006) with populated data preserved | **PASS** — CP-1's version-6 upgrade case, re-executed |
| `STRICT`, `typeof()`, range, FK, uniqueness, partial-index, state/retention constraints | **PASS** — CP-1's 28 shipped-ABI schema cases, re-executed |
| Relationship/existence invariants (not only "at most one") | **PASS** — now genuinely enforced by the completed post-write invariants (§4, Defect 1) |
| Movement `synced` forbidden (§3.7 interlock) | **PASS** |
| Warehouse-scoped stock display and enforcement use the same projection | **PASS** — `CatalogService.getAllocationRemaining()` uses the same read path as the commit-time split |
| Production path isolation | **PASS** — `assertDefaultDatabasePathIsUnavailable()`; every database is a disposable temp file, never `:memory:`, never userData |
| Temporary-directory cleanup | **PASS** — sandbox disposal is guarded by `assertDisposableRoot`, and a leaked handle fails the test |
| Downgrade below 0007 | **PROHIBITED** by the plan's rollback contract; not attempted |

System SQLite was not used as a substitute anywhere; every assertion above ran on the shipped
Electron ABI.

---

## 9. Backend read-only final gate

No backend file was created, modified, or deleted (§2 porcelain counts identical). No production or
development business database was used; the MySQL leg ran only against the previously documented
disposable database `thinis_be3f5_test_20260827_172616_1e82fd`.

| Command | Result |
| --- | --- |
| Full SQLite `php artisan test --compact` | **PASS** — 678 total; 673 passed, 5 intentional MySQL-only skips; 2,984 assertions |
| Focused BE-3F-2A/2B/3/5 + invoice/reference suites (SQLite) | **PASS** — 91 tests, 625 assertions |
| Full strict-mode MySQL `php artisan test --compact` | **PASS** — 678 total; 673 passed, 5 opt-in concurrency skips; 2,984 assertions |
| BE-3F-5 + BE-3F-3 + BE-3F-2B real MySQL concurrency (all three opt-in flags set) | **PASS** — 5 tests, 56 assertions |
| `architecture:scan-routes --strict` | **PASS** — no route-boundary violations |
| `architecture:scan-permission-matrix --strict` | **PASS** — no permission-matrix violations |
| `architecture:scan-controllers --strict` | 1 violation — the unchanged, previously documented `CompanyUserPermissionController::assignableRoles` long method (25 lines vs 20). **Still the only finding; no Phase 3F file introduced another.** |
| `git diff --check` (backend) | **PASS** — clean |
| MySQL preflight (read-only) | MySQL 8.4.10; `ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION`. No credential printed. |

BE-3F-2A generator integrity was verified read-only via its own Pest test
(`GenerateInvoiceUploadRequestGoldenFixtureTest`, which asserts the on-disk fixture matches the
generator) rather than by re-running the writing command, and the fixture hash was confirmed
unchanged at `5a23816b66244386c9c813769ec5d221e7075b240ff3e11a707c775e85d14ad2`.

No backend defect was discovered, so no backend handoff is required.

---

## 10. Manual GUI smoke — NOT RUN

`npm run dev` cannot launch a usable Electron window from this agent/VSCode shell
(`ELECTRON_RUN_AS_NODE` is set in the environment; it is required by the Electron-node test harness
and breaks the GUI launcher). This is the previously recorded limitation of this environment, and the
approved plan states plainly that the manual checklist is **user-only** and that "nothing below may
be claimed by an agent."

**No GUI result is claimed. This is separate from, and does not qualify, the automated CP-5b
verdict.** Manual smoke must use an isolated test profile/database and test credentials; it must not
reset the working workstation database, run an older build against it, or treat connectivity alone as
authorization or invalidation of valid offline access.

### Checklist for the user to run (plan's own 19 items, plus the catalog-refresh flow)

1. Open a shift; cart with a fractional quantity, a line discount, and an invoice discount.
2. Disconnect the network; confirm the offline indicator and that pricing still works.
3. Split cash + card with a reference; confirm change/due in the preview.
4. Complete once — the number appears **labelled local/offline**, and the cart clears.
5. Double-click Complete on a fresh cart — exactly one sale.
6. **Hard-kill mid-completion (`kill -9`), relaunch.** The recovery banner appears and offers the
   D1-permitted action(s), or explains the policy block. Confirm no second sale exists.
7. From that banner, **retry** — exactly one sale results, totals match what was rung.
8. Repeat 6, then **abandon** — no sale exists, the till unblocks, the tender warning was shown.
9. With a `claimed` attempt outstanding, try to start a new sale — blocked, recovery route offered.
10. Log out and back in as the same cashier with an unacknowledged sale — still recoverable.
11. Log in as a **different** cashier — the first cashier's attempt is not offered; the new cashier
    can sell normally.
12. Complete two sales while suppressing each response/ack, restart, discover both, acknowledge one,
    prove the other remains, then acknowledge it independently.
13. Claim in S1, kill before commit, close S1 and open S2, then retry — `context-changed`; no S2 sale.
14. Repeat with branch/warehouse reassignment — `context-changed`; no re-scoped stock movement.
15. Hard-kill mid-completion, then change the catalog before retrying — `refresh-required`, no
    repricing.
16. Pause the shift; attempt completion — refused, cart retained.
17. With no allocation, a tracked cart is blocked even while connected. With a valid grant, sell up to
    its remaining quantity; the next unit is refused, cart retained, message names the product.
18. Device with no assigned branch or warehouse — **every** sale is refused cleanly.
19. Confirm no network request was attempted and nothing touched `/api/v1/admin/*`.
20. **Catalog refresh (new):** with a stale catalog, confirm the warning shows a **Refresh
    workstation data** action → click it → the control disables and shows progress → on success the
    status leaves stale, the refresh timestamp appears, and a new sale becomes possible. With an open
    cart whose revision changed, confirm the cart is **not** repriced and that rebuild-or-clear is
    required. Disconnect and click refresh to confirm the actionable error state and that the previous
    catalog stays readable.
21. **Overdue-license recovery (new):** with a workstation blocked by "License validation is
    overdue", confirm **Refresh workstation data** appears beside the message → click it → on
    success the block clears immediately and the app returns to the POS with selling enabled.
    Disconnect and click it to confirm the block is **retained** and the real transport error is
    shown rather than the stale overdue text.

---

## 11. Deferred to Phase 3G / production gates

- **PD-3G-1** — operator policy for non-stock terminal upload outcomes (catalog drift, customer
  deletion, payment-method deactivation, authorization failures). **Undecided.**
- **Allocation release** — backend `release_enabled` stays `false`; desktop durable sealing, trusted
  state, restored-state rejection, and the cross-language journal implementation are not built.
- **BE-3F-4** — snapshot-inclusion contract; until it lands, `local_stock_movements` stays
  pending-only and no allocation-consumption cleanup may occur.
- **Upload/sync worker, receipts, refunds, payment processing, credit sales** — none started.
- **Desktop allocation delivery** — bootstrap carries no allocation subresource; grants have no
  production writer (§5).
- **Production upload eligibility** requires BE-3F-3 and BE-3F-5 *released*, not merely implemented.

Phase 3F completion authorizes none of the above. Production readiness remains blocked.

---

## 12. Remaining known baseline architecture finding

`app/Modules/Identity/Http/Controllers/CompanyUserPermissionController.php:20` —
`assignableRoles` spans 25 lines against a configured maximum of 20. Pre-existing, unchanged, and
still the **only** architecture finding across 46 controllers. No Phase 3F file introduced another.

---

## 13. Confirmation of boundaries

No backend code was written, modified, or deleted. No forbidden action occurred: the app was not
rescaffolded or converted to Nuxt; `/api/v1/admin/*` is neither called nor referenced; no generic
`ipcRenderer` was exposed; no renderer touches SQLite or the filesystem; no token reaches
`localStorage`; no dependency was added; no destructive git operation was run; nothing was staged,
committed, pushed, or deployed; no production or workstation database was opened, reset, or migrated.

---

## 14. Recommended next step

Have a human run the §10 checklist against an isolated test profile. Phase 3G remains unauthorized
until that is done and separately approved; PD-3G-1 must be decided before reconciliation UX work
begins, and BE-3F-3/BE-3F-5 must be *released* before any real upload is enabled.

---

```text
BE-3F-5 conservation reverified: PASS
BE-3F-3 historical upload reverified: PASS
BE-3F-2A request evidence reverified: PASS
CP-1 schema/repositories: PASS
CP-2 atomic persistence/state machine: PASS
CP-3 IPC/security: PASS
CP-4 renderer/recovery: PASS
CP-5a artifact integrity: PASS
BE-3F-2B endpoint compatibility: PASS
CP-5b combined automated gate: PASS
Full MySQL backend suite: PASS
Full SQLite backend suite: PASS
Desktop full gate: PASS
Manual GUI smoke: NOT RUN
Allocation release remains disabled: YES
Tracked-stock completion requires allocation: YES
Phase 3F implementation: COMPLETE
Phase 3F automated acceptance: PASS
Production readiness: BLOCKED pending stated gates
Phase 3G implementation: NOT STARTED
Backend staged/committed/pushed: NO
Desktop staged/committed/pushed: NO
```
