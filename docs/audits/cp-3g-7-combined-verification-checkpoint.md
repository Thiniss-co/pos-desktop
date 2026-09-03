# CP-3G-7 — Combined two-repository verification checkpoint

> ## SUPERSEDED IN PART — read §18 before quoting anything below
>
> **§1–§17 are the original 2026-09-03 CP-3G-7 pass and are retained verbatim as the historical
> record.** Their headline verdict — *"CP-3G-7 automated verification: PASS"* — was **invalid** and
> is **withdrawn**: the live-harness gate had failed 6 of 15 executions and was reported as a
> finding (F2) while the gate itself was still called PASS. A gate with an unresolved intermittent
> failure is a **FAIL**, not a PASS with a footnote.
>
> **§18 is the F2 correction**: the root cause, the bounded change, the reliability evidence and the
> re-executed combined gate. Where §18 and §1–§17 disagree, **§18 wins**. Nothing in §1–§17 has been
> deleted or edited.

**Checkpoint:** CP-3G-7 — the final Phase 3G combined automated verification gate, plus emission of
the §12 manual GUI smoke checklist for the user.
**Session date:** 2026-09-03.
**Scope of authorization:** Revision 5 §9.6 — the combined verification gate and the manual
checklist, and **nothing else**.

This checkpoint changed **no application code, no backend code, no migration and no dependency**. It
ran commands and wrote two documents.

---

## 1. Frozen baseline and prerequisite hashes

All ten precondition rows were verified before any file was written.

| Precondition | Expected | Observed | Verdict |
|---|---|---|---|
| Desktop HEAD | `9a1232ba90b3a2fe3799bc42d02bca1d14c79c22` | `9a1232ba90b3a2fe3799bc42d02bca1d14c79c22` | **PASS** |
| Desktop worktree | clean | clean (`git status --porcelain` empty) | **PASS** |
| CP-3G-6 parent | CP-3G-5 `73912b1dbe22a9141b5d963e5e74829adca5fd72` | `73912b1dbe22a9141b5d963e5e74829adca5fd72` | **PASS** |
| Revision 5 plan SHA-256 | `58bcfd8911ee8082e0b583babc5aa07ecfb9fb238c564b6dda4a2226f1c8969e` | identical | **PASS** |
| CP-3G-6 report SHA-256 | `0c5cf154141737a4ea8a71977b78f6a845789f405ddc9dd74cf1bf90c77f2df2` | identical | **PASS** |
| Backend HEAD | `2bcce42e9102d76eb57a24445791499989912a05` | `2bcce42e9102d76eb57a24445791499989912a05` | **PASS** |
| Backend worktree | only the untracked BE-3G-0 report | `?? docs/audits/be-3g-0-controlled-upload-readiness.md` — nothing else | **PASS** |
| Exposed CP-3G-5 token | absent | absent — see §1.1 | **PASS** |
| Stale CP-3G-5/6 PHP server or owned listener | none | none — see §1.2 | **PASS (with one explained, unrelated process)** |
| CP-3G temporary directory | none | none (`/tmp/pos-desktop-cp3g5-*` and `/tmp/pos-desktop-electron-node-*` both absent) | **PASS** |
| Allocation release | disabled | `config/stock_allocations.php:7` → `'release_enabled' => false`, no `.env` override | **PASS** |
| BE-3F-4 | unimplemented | migration `0007_local_sale_persistence.ts:247-250` still excludes `'synced'` from the movement `sync_status` CHECK and pins `synced_at CHECK (synced_at IS NULL)` | **PASS** |

### 1.1 Token sweep

A sweep of `src/`, `tests/`, `scripts/` and `docs/` for `plainTextToken`, `Bearer <value>` and the
Sanctum `<id>|<40-char>` shape returned **five** matches, none of which is a token value:

- `tests/cp3g5HarnessLifecycle.test.mjs:40` and `tests/cp3g5HarnessSafety.test.mjs:260` — redaction
  **guard** regexes;
- `tests/electron/support/cp3g5/seedLiveBackend.php:240` — the seeder's own
  `$createdToken->plainTextToken` variable expression;
- `docs/audits/cp-3g-6-crash-recovery-checkpoint.md:46` — the prior sweep's own record;
- `docs/backend-contract/auth-device-contract.md:66` — contract prose.

The packaged `app.asar` was independently searched: `Bearer <value>` → **0 matches**; the Sanctum
`<id>|<40-char>` shape → **0 matches**.

### 1.2 The one explained process — not a CP-3G artefact

One `php artisan serve` supervisor (pid 39160) and its `php -S 127.0.0.1:8000` grandchild
(pid 39162) were running before this session began.

| Property | Observed |
|---|---|
| Started | 2026-09-03 14:10:31 — **before** this session's first live run (14:35:46) |
| Parent chain | `zsh` (6271) ← `gnome-terminal-server` (6073) ← `systemd --user` — the **user's own terminal** |
| Port | **8000**, the ordinary Laravel development port; every CP-3G run binds a per-run ephemeral port |
| Working directory | `pos-backend/public`, `APP_ENV=local` — the development server, not a disposable-SQLite harness process |

It is therefore the user's own development server, not a stale CP-3G-5/6 listener. It was **left
running and untouched**. Its survival across every live run is itself the live re-proof of CP-3G-6
harness-lifecycle regression 13 ("an unrelated `php -S` on another port survives a full harness run,
still alive and still holding its socket").

---

## 2. Evidence classification

Every result below is labelled with exactly one class.

| Class | Meaning |
|---|---|
| **executed now** | Run in this session, with its real output. |
| **carried forward** | Owned by a named earlier report; cited, never re-badged as executed. |
| **user-only / manual** | Only the user can produce it. Never claimed here. |
| **not executed** | Named and explicitly not run, with the reason. |

**No carried-forward figure in this report is presented as executed-now evidence.** Where a
carried-forward number is quoted, it is quoted only to say whether this session reproduced it.

---

## 3. CP-3G-7A — desktop complete gate (executed now)

All eleven gates were run sequentially from the frozen commit, in the order given.

| # | Command | Exit | Result |
|---|---|---|---|
| 1 | `npm run typecheck` | **0** | PASS — `tsc -p tsconfig.node.json` and `vue-tsc -p tsconfig.web.json`, no output |
| 2 | `npm run lint` | **0** | PASS — `eslint --cache .`, zero errors, zero warnings |
| 3 | `npm run test` | **0** | PASS — **100 test files / 879 tests passed / 0 failed / 0 skipped**, 9.71 s |
| 4 | `npm run test:cp3g5-harness` | **0** | PASS — **33 tests / 33 pass / 0 fail / 0 skipped / 0 todo**, 81.6 s, serialized (`--test-concurrency=1`) |
| 5 | `npm run verify:fixture` | **0** | PASS — **5 fixtures** byte-identical against pos-backend, hashes independently verified |
| 6 | `npm run smoke:database` | **0** | PASS — Electron SQLite migration smoke passed |
| 7 | `npm run test:sqlite:electron` | **0** | PASS — **237 registered / 203 passed / 0 failed / 34 skipped** (hermetic) |
| 8 | `npm run build` | **0** | PASS — 312 modules transformed; main, preload and renderer emitted |
| 9 | `npm run build:unpack` | **0** | PASS — electron-builder 26.15.3, `dist/linux-unpacked`, electron 39.8.10 |
| 10 | `npm run verify:cp3g5-package` | **0** | PASS — inspected **124 files** and **1 `app.asar`**; no forbidden CP-3G-5 asset |
| 11 | `git diff --check` | **0** | PASS — no output |

Every count reproduces CP-3G-6's frozen figures exactly (879/100, 33/33, 237/203/34, 124 files +
1 asar). **Worktree after the full build chain: still clean.**

**Naming.** The package-boundary command is `npm run verify:cp3g5-package`.
`verify:cp3g5-package-boundary` **does not exist** and is not cited as runnable anywhere in this
report; the underlying script file is `scripts/verifyCp3g5PackageBoundary.mjs`.

### 3.1 Hermetic versus live, in gate 7

The 34 skips in gate 7 are **intentional live-only gates**, reported as skips and never as passes,
which is what keeps `npm run test:sqlite:electron` hermetic. All 34 carry the skip reason
`no live CP-3G-5 backend provided`:

- 29 CP-3G-5 duplicate-safety / zero-send / malformed-success cases (tests 188-216);
- 5 CP-3G-6 `SIGKILL` crash cases (tests 225-229).

All 34 are executed under the live gate in §4.

### 3.2 Warnings

| Source | Line | Disposition |
|---|---|---|
| `npm run build:unpack` | electron-builder printed a `duplicate dependency references` informational line listing transitive duplicates (`debug@4.4.3`, `@types/node@22.20.1`, `vue@3.5.39`, …) | Informational packaging notice from electron-builder's module search, not a lint/compile warning. Pre-existing, unrelated to CP-3G. Recorded, not acted on. |
| every other gate | none | No gate emitted a warning. `npm run lint` reported zero warnings. |

### 3.3 Packaged-output audit (independent of the boundary script)

`npm run verify:cp3g5-package` checks five specific forbidden patterns. This session additionally
enumerated all **3,087** `app.asar` entries and the whole `dist` tree.

| Forbidden class | Result |
|---|---|
| PHP seeder (`seedLiveBackend.php`) | **ABSENT** — excluded by `!tests/electron/support/cp3g5/**` |
| Live test wrapper (`scripts/cp3g5LiveUpload.mjs`) | **ABSENT** |
| Tokens | **ABSENT** — `Bearer <value>` 0 matches, Sanctum `<id>|<40-char>` 0 matches |
| Temporary databases (`cp3g5-backend.sqlite`, `pos-desktop-cp3g5-*`) | **ABSENT** — no `.sqlite` anywhere under `dist` |
| CP-3G harness artefacts | **PRESENT — see finding F1** |

`/api/v1/admin` appears 23 times in the raw `app.asar`. Every occurrence is either the guard that
**rejects** it (`src/main/http/desktopApiClient.ts:50`), that guard's test, or shipped documentation
(`docs/`, `.ai/`). The only occurrences in `src/` are the guard and its test.

### 3.4 Requirement 7 — no generic `ipcRenderer`, no unrestricted network surface

| Check | Evidence |
|---|---|
| Preload exposes exactly one surface | `src/preload/index.ts:9` — `contextBridge.exposeInMainWorld('posApi', posApi)`, and no other `exposeInMainWorld` call |
| No generic invoke passthrough | `src/preload/posApi.ts` imports `ipcRenderer` but exposes only frozen per-capability methods bound to `IPC_CHANNELS` constants; `ipcRenderer` itself is never re-exported |
| `sync:*` channels are trusted-sender guarded | `src/main/ipc/sync.ipc.ts:44,54,68` — `assertTrustedSender(event)` on all three invoke handlers |
| Network surface | one client, `src/main/http/desktopApiClient.ts` |

### 3.5 Requirement 8 — every upload route under `/api/v1/desktop/*`

Structural, not conventional. `desktopApiClient.ts:16` fixes
`const DESKTOP_API_PREFIX = '/api/v1/desktop'`; `resolveDesktopApiUrl()` rejects any path that is not
relative, that contains `..`, `\`, `//` or `://`, or that starts with `/api/v1/admin` or
`/api/v1/auth`, then asserts that the resolved URL's origin is unchanged **and** its pathname starts
with `/api/v1/desktop/`. A non-desktop path cannot be constructed. The upload call itself is
`src/main/sync/invoiceUpload.client.ts` → `DESKTOP_API_ROUTES.invoicesUpload`.

---

## 4. CP-3G-7B — live disposable-Laravel gate (executed now)

Command form: `CP3G5_PAYLOADS=<n> CP3G6_EVIDENCE=<path outside the sandbox> node scripts/cp3g5LiveUpload.mjs`.

**Fifteen live executions** were performed in this session. Their aggregate is reported honestly,
including the failures.

### 4.1 Harness safety properties (all nine required properties, every run)

| Required property | Result |
|---|---|
| Unique nonce-bound temporary directory | **PASS** — `mkdtemp` `pos-desktop-cp3g5-*`, nonce carried through owner-only file IPC |
| Absolute disposable SQLite backend database | **PASS** — `DB_CONNECTION=sqlite`, `DB_DATABASE=<sandbox>/cp3g5-backend.sqlite`, `APP_ENV=testing` |
| Per-run loopback port | **PASS** — 42095, 39891, 39229, 46349, 36765, 41625, … all distinct, none reused |
| Owner-only secret transport | **PASS** — fixture file mode asserted `0600` and non-symlink before use |
| Pre-bootstrap and post-bootstrap database validation | **PASS** — the seeder's fail-closed checks (17 `rejectSeeder` points) precede Laravel bootstrap, and the active connection is re-verified after it |
| Complete owned process-group cleanup | **PASS** — every run, success and failure alike |
| Port-release verification | **PASS** — every run's port confirmed released afterwards |
| Temporary-directory removal verification | **PASS** — wrapper printed `temporary directory removed and verified absent` on every run, failures included |
| Zero token/payload leakage | **PASS** — wrapper output searched for `Bearer`, `plainTextToken` and Sanctum token shapes: zero matches on every run |

The final listener set is **byte-identical** to the pre-live baseline captured at 14:35:39.

### 4.2 Coverage gate — the payload budget

The CP-3G-6 live crash arms self-skip unless the minted fixture budget exceeds
`LIVE_PAYLOAD_BASE + 4 = 20` (`tests/electron/suites/invoiceUploadCrashRecovery.suite.ts:63-75`).
The wrapper's default is `CP3G5_PAYLOADS ?? 16`.

| Budget | Evidence lines | Live crash arms |
|---|---|---|
| 16 (default) | 15 | **skipped** |
| 17 | 15 | **skipped** |
| 21 | **20** | **executed** |
| 32 (CP-3G-6's documented invocation) | **20** | **executed** |

The first run of this session used the default and is therefore recorded as **partial coverage**,
not as gate evidence. All gate evidence below comes from runs at 21 or 32.

### 4.3 Live runs — the complete ledger, failures included

| # | Budget | Exit | Evidence lines | Failure lines | Outcome |
|---|---|---|---|---|---|
| 1 | 16 | 0 | 15 | 0 | Suite passed; live crash arms skipped (partial coverage) |
| 2 | 32 | 1 | — | — | **Fixture seeding failed**; cleanup verified |
| 3 | 32 | 0 | 20 | 0 | Full coverage |
| 4 | 21 | 0 | 20 | 0 | Full coverage |
| 5 | 17 | 0 | 15 | 0 | Live arms skipped |
| 6-8 | 32 ×3 | 1,1,1 | — | — | **Fixture seeding failed** ×3; cleanup verified each time |
| 9 | 21 | 0 | 20 | 0 | Full coverage |
| 10 | 32 | 0 | 20 | 0 | Full coverage |
| 11 | 21 | 0 | 20 | 0 | Full coverage |
| 12 | 32 | 1 | — | — | **Fixture seeding failed**; cleanup verified |
| 13 | 21 | 0 | **20** | **0** | **Gate run 1** — full coverage |
| 14 | 21 | 0 | **20** | **0** | **Gate run 2** — full coverage, consecutive, no manual intervention |
| 15 | 21 | 1 | — | — | **Fixture seeding failed**; cleanup verified |

**Nine of fifteen runs reached the suite; six failed at fixture seeding.** Every failure was a
*setup* failure inside the harness's own seeding step — never a product assertion. See finding
**F2**. When the harness did reach the suite, it passed **every time**, with **zero failure-ledger
lines** across all seven full-coverage runs.

Two consecutive full-coverage runs (13 and 14) completed with **no manual intervention between
them**, on distinct ports (36765 and 41625), each leaving no sandbox, no listener and no owned
process.

### 4.4 What the live evidence proves

Twenty evidence records per full-coverage run, each a redaction-safe object of counts, states and
booleans. All twenty cases, from gate run 1:

```
 1  CP-3G-6E-claim-boundary                          11  CP-3G-6E-in-flight
 2  CP-3G-6B-lease-not-expired                       12  CP-3G-6E-before-outcome
 3  CP-3G-6B-expired-lease-release                   13  CP-3G-6E-during-outcome
 4  CP-3G-6F-reclaim-isolation                       14  CP-3G-6H-owner-scoped-reclaim
 5  CP-3G-6F-foreign-expired-lease                   15  CP-3G-6H-no-session-owner
 6  CP-3G-6G-repeated-restart                        16  CP-3G-6H-cross-user-and-epoch
 7  CP-3G-6G-single-flight                           17  CP-3G-6H-later-login-recovers
 8  CP-3G-6G-synced-never-resent                     18  CP-3G-6H-concurrent-owners
 9  CP-3G-6A/6C-server-committed-ack-lost            19  CP-3G-6H-atomic-owner-predicate
10  CP-3G-6D-pre-commit-crash                        20  CP-3G-6H-idempotent-owner-scoped-reconciliation
```

| Required proof | Live evidence |
|---|---|
| No stale listener contaminates the next run | Runs 13→14 consecutive, distinct ports, no manual cleanup, identical final listener set |
| Normal 201 synchronization | `CP-3G-6D-pre-commit-crash` → `convergedAs: "created"`, `backendInvoices: 1` |
| Exact 200 duplicate convergence | `CP-3G-6A/6C`, `6E-in-flight`, `6E-before-outcome`, `6E-during-outcome` → `convergedAs: "duplicate"`, `backendInvoices: 1` |
| Lost acknowledgment | `CP-3G-6A/6C-server-committed-ack-lost` → `backendCommittedBeforeKill: true`, `requestsBeforeCrash: 1`, `requestsOnRetry: 1`, `identicalBodyDigest: true` |
| Crash before commit | `CP-3G-6D` → `backendCommittedBeforeKill: false` → 201 created |
| Crash after commit | `CP-3G-6A/6C`, `6E-before-outcome`, `6E-during-outcome` → `backendCommittedBeforeKill: true` → 200 duplicate |
| All recorded `SIGKILL` boundaries | Six: `before-dispatch`, `in-flight`, `response-received`, `before-outcome`, `during-outcome`, and the pre-commit arm — every one `"killed": "SIGKILL"` |
| Owner-scoped lease recovery | `6H-owner-scoped-reclaim` → 4 unscoped candidates, exactly 1 reclaimed, `foreignRowsByteIdentical: true`; `6H-atomic-owner-predicate` → `updateRefused: true`, `requests: 0` |
| One request per dispatch attempt | `requestsOnRetry: 1` on every recovered case; `6G-single-flight` → 3 concurrent triggers, **1** request |
| No post-success redispatch | `requestsAfterSuccess: 0` on every case; `6G-synced-never-resent` → 3 restarts, **0** requests |
| Exactly-once server and local effects | See §7 |

**Per-test tally for the live arm is NOT claimed.** The wrapper captures the suite's output as part
of its redaction boundary, so no TAP tally is observable. The live arm is evidenced by exit code
plus the redaction-safe evidence ledger, exactly as CP-3G-6 established.

### 4.5 Recovery-path invariant

Every live crash case recorded the transition chain

```
pending → uploading → retryable_error → pending → uploading → synced
```

A direct `uploading → pending` was **never observed**, and no orphaned `uploading` row survived any
restart.

---

## 5. CP-3G-7C — backend full SQLite gate (executed now)

| Arm | Command | Result |
|---|---|---|
| Complete backend suite | `php artisan test` | **691 tests / 686 passed / 0 failed / 5 skipped / 3,051 assertions**, exit 0, 36.8 s |
| Focused controlled-upload set (14 files) | `php artisan test --compact <14 paths>` | **122 tests / 122 passed / 835 assertions / 0 skipped**, exit 0 |

**The 5 skips are identified, not assumed.** Running the three MySQL concurrency files alone under
SQLite returns `tests: 5, passed: 0, skipped: 5` — so the full suite's 5 skips are exactly those
arms, and they are executed under MySQL in §6.

### 5.1 Required coverage, per file (each executed individually)

| File | Tests | Assertions |
|---|---|---|
| `DesktopInvoiceUploadTest.php` | 6 | 36 |
| `DesktopInvoiceHistoricalUploadTest.php` | 28 | 127 |
| `DesktopCommittedInvoiceArtifactTest.php` | 34 | 306 |
| `DesktopStockAllocationApiTest.php` | 11 | 86 |
| `DesktopSellableCatalogContractTest.php` | 7 | 81 |
| `DesktopShiftContractTest.php` | 5 | 67 |
| `DesktopAuthorizationTest.php` | 3 | 21 |
| `ArchitectureScanRoutesTest.php` | 3 | 3 |
| `ArchitectureScanPermissionMatrixTest.php` | 4 | 8 |
| `RouteSeparationTest.php` | 6 | 13 |
| `PlatformDesktopBoundaryTest.php` | 4 | 4 |
| `FeaturePermissionGateTest.php` | 5 | 5 |
| `GenerateInvoiceUploadRequestGoldenFixtureTest.php` | 3 | 61 |
| `GenerateStockAllocationEnvelopeGoldenFixtureTest.php` | 3 | 17 |
| **Total** | **122** | **835** |

### 5.2 Required coverage areas → named tests

| Area | Covering test (named, executed now) |
|---|---|
| Request validation | *"every accept case is actually accepted and every reject case actually fails on its named field, from the real FormRequest"* |
| Historical shift attribution | *"scenario 2: the historical cashier is attributed even when a different authorized user uploads"*; *"scenario 3: device reassignment never changes the historical branch/warehouse/stock scope"* |
| Uploader audit | *"a closed CP-5a shift accepts a different sync-authorized uploader after reassignment while preserving signed-off history"* |
| Closed-shift append-only adjustment | *"scenario 1: a late upload against a closed originating shift is attributed to it, not the new open shift"* (table `shift_post_close_adjustments`) |
| Allocation-proof enforcement | *"a legacy tracked desktop sale cannot reach stock costing without allocation proof"*; *"allocation proof defects reject the artifact with zero partial writes"* |
| Allocation consumption | *"a v2 tracked line consumes its exact allocation proof atomically, with one stock movement per line"*; *"allocation consumption conserves physical and reserved stock and exact replay is inert"* |
| Idempotent replay | *"an identical idempotent upload returns the original invoice without another stock deduction"*; *"an exact artifact replay returns the same resource identity and changes no persisted upload effect"* |
| Idempotency conflict | *"reusing an idempotency key with a different payload is rejected"*; *"changed content under the artifact idempotency key returns 409 and changes no persisted upload effect"* |
| Committed artifact compatibility | `DesktopCommittedInvoiceArtifactTest.php` — 34 tests / 306 assertions |
| Rejection rollback | *"every material write boundary rolls the entire closed-shift artifact upload back"*; *"allocation consumption rolls every effect back on failure"* |
| Route and permission contracts | `ArchitectureScanRoutesTest` (3), `ArchitectureScanPermissionMatrixTest` (4), `RouteSeparationTest` (6), `PlatformDesktopBoundaryTest` (4), `FeaturePermissionGateTest` (5) |
| Allocation-envelope fixtures | `GenerateStockAllocationEnvelopeGoldenFixtureTest` (3 / 17) |

---

## 6. CP-3G-7D — strict-MySQL gate (executed now)

### 6.1 Disposable database lifecycle

| Step | Evidence |
|---|---|
| Generated name | `thinis_pos_cp3g7_20260903144842` |
| Validated against `^thinis_pos_cp3g7_[0-9]{14}$` | **PASS** — validated before creation **and re-validated immediately before the `DROP`** |
| Credentials | The repository's own `.env` credential (`DB_USERNAME` / `DB_PASSWORD`). **No credential was guessed**, and none appears in any command, log or this report. Transported through an owner-only (`0600`) `--defaults-extra-file` and an owner-only env file, both **shredded** after the gate. |
| `SHOW GRANTS` | `CREATE, DROP … ON *.*` held — no privilege escalation, no `sudo`, no interactive password |
| Pre-creation collision check | `SELECT COUNT(*) FROM INFORMATION_SCHEMA.SCHEMATA` → **0** before `CREATE` |
| Normal development database | `thinis_pos` — **never named by any command in this gate**; verified still present with **74 tables** before and after |

### 6.2 Environment proof, read from Laravel itself

```
driver                 = mysql
configured_database    = thinis_pos_cp3g7_20260903144842
strict_flag            = true
active_database        = thinis_pos_cp3g7_20260903144842
sql_mode               = ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,
                         NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION
server_version         = 8.4.11-0ubuntu0.26.04.1
tables_before_migrate  = 0
```

All six strict modes present, **`ONLY_FULL_GROUP_BY` included**.

### 6.3 Migration and suites

| Arm | Result |
|---|---|
| `php artisan migrate --force --no-interaction` | exit 0 — **74 tables** created in the disposable database |
| Complete backend suite under strict MySQL | **691 tests / 686 passed / 0 failed / 5 skipped / 3,051 assertions**, exit 0, 536 s |
| MySQL concurrency arms — `BE3F3_MYSQL_CONCURRENCY=1 BE3F2B_MYSQL_CONCURRENCY=1 BE3F5_MYSQL_CONCURRENCY=1` over the three concurrency files | **5 tests / 5 passed / 0 failed / 0 skipped / 56 assertions**, exit 0, 140 s |

Counts are **identical** between SQLite and strict MySQL (686/5/3,051), so no portability
divergence exists at this build. The concurrency arms ran with **zero skipped** — they executed
rather than being gated out.

**Revision 5 names no additional controlled-upload MySQL gate beyond these five arms**, so none was
invented.

### 6.4 Verified removal

| Step | Result |
|---|---|
| Name re-validated against the regex immediately before `DROP` | **PASS** |
| `DROP DATABASE` | executed |
| `SELECT COUNT(*) FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME='thinis_pos_cp3g7_20260903144842'` | **0** — a positive absence check, not a shell echo |
| Remaining `thinis_pos%` schemas | **`thinis_pos` only** |
| Development database after cleanup | 74 tables, intact |
| Credential files | shredded |

**Disposable MySQL cleanup: PASS.**

---

## 7. CP-3G-7E — backend static / quality gates (executed now)

| Gate | Command | Exit | Result |
|---|---|---|---|
| Pint (check-only) | `vendor/bin/pint --test --format agent` | **1** | **PRE-EXISTING TEST-FIXTURE FINDING** — see below |
| Route contract | `php artisan architecture:scan-routes` | 0 | **PASS** — "No API route boundary violations found." |
| Permission matrix | `php artisan architecture:scan-permission-matrix` | 0 | **PASS** — "No permission matrix violations found." |
| Controller scan | `php artisan architecture:scan-controllers` | 0 | 1 violation across 46 controllers — pre-existing |
| Architecture report | `php artisan architecture:report` | 0 | routes 0, permissions 0, controller-length 1 |
| Route surface | `php artisan route:list --path=api/v1/desktop` | 0 | **78 desktop routes**, including `POST api/v1/desktop/invoices/upload` |
| OpenAPI validation | — | — | **NOT EXECUTED — no validator exists** |
| `git diff --check` | `git diff --check` | 0 | **PASS** — no output |

### 7.1 Pre-existing findings preserved, distinctly from regressions

| Finding | This session | BE-3G-0 baseline | Verdict |
|---|---|---|---|
| Pint: `tests/Fixtures/routes/api.php`, fixer `braces_position` | reproduced exactly | BE-3G-0 **F3**, recorded as `PRE-EXISTING TEST-FIXTURE FINDING`, "Pint is not reported as an unqualified PASS" | **Pre-existing, unchanged. Not a regression. Not fixed here.** |
| Architecture: `CompanyUserPermissionController::assignableRoles` spans 25 lines (max 20), `…Controller.php:20` | reproduced exactly | BE-3G-0 §`architecture:report`, "known and pre-existing … not newly introduced. Non-blocking." | **Pre-existing, unchanged. Not a regression.** |

**New backend regressions introduced or discovered: none.** Both files remain unmodified — backend
`git status --porcelain` shows only the untracked BE-3G-0 report.

### 7.2 OpenAPI

`docs/api/openapi/pos-backend-v1.openapi.yaml` exists, but no validator does: no `openapi` /
`swagger` / `spectral` / `redocly` dependency in `composer.json` or `package.json`, nothing matching
in `vendor/bin/`, and no such binary on `PATH`. **No OpenAPI command was manufactured.** Classified
**not executed**.

---

## 8. CP-3G-7F — cross-repository invariant matrix (re-proven from frozen source)

| # | Invariant | Evidence | Verdict |
|---|---|---|---|
| 1 | One local invoice and one `sync_queue` row per sale | `0007_local_sale_persistence.ts:257-259` — partial `CREATE UNIQUE INDEX idx_sync_queue_invoice_upload ON sync_queue(aggregate_type, local_aggregate_uuid, operation) WHERE aggregate_type='invoice' AND operation='upload'`; live `localCounts` `local_invoices: 1`, `sync_queue: 1` on every case | **PASS** |
| 2 | `idempotency_key === local_invoice_uuid` | `localSale.payload.ts:32` — `idempotency_key: invoice.localUuid`; live `identicalIdempotencyKey: true` after every crash | **PASS** |
| 3 | Frozen payload hash-verified, sent without reconstruction | `invoiceUploadWorker.ts:318` — `payloadHash(JSON.parse(claimed.payloadJson)) === claimed.payloadHash`; `:268` sends `claimed.payloadJson`; `invoiceUpload.client.ts:84` — `const body = parseFrozenUploadPayload(payloadJson)`, then the request is that parsed object. Live: `identicalPayloadJson`/`identicalPayloadHash`/`identicalBodyDigest` all `true` | **PASS** |
| 4 | Laravel `request_hash` not reproduced in TypeScript | Repo-wide grep for `request_hash`/`requestHash` in `src/` → **zero** non-test matches | **PASS** |
| 5 | No SQLite transaction spans an HTTP call | `invoiceUploadWorker.ts:59-60` states it; structurally, the worker contains **no** `transaction(` call — the claim commits, `await upload(...)` runs outside any transaction, and the outcome is written afterwards through the recorder | **PASS** |
| 6 | Authorization rechecked before every dispatch | `invoiceUploadWorker.ts:159-160` — `authorize()` is the first statement of every `while` iteration, never hoisted; `assertAllowed('sync')` + `hasPermission(INVOICE_UPLOAD_PERMISSION)`, fail-closed | **PASS** |
| 7 | Company/device ownership checked before dispatch | `currentUploadOwner()` reads main-owned session metadata on every call; `claimNextInvoiceUpload(owner, …)` enforces it in SQL. Live `6F-foreign-expired-lease` → `claimableByThisSession: false`, `startupRequests: 0` | **PASS** |
| 8 | Cross-user upload on the same device still supported | The owner tuple is company + device only — `user_uuid` and session epoch deliberately excluded. Live `6H-cross-user-and-epoch` → `committedByAnotherCashier: true`, `sessionEpochAfterRotation: 2`, still reclaimed, `requests: 1` | **PASS** |
| 9 | Lease reclaim and retry release atomically company/device scoped | Both writers carry the predicate **inside the `UPDATE`**: `syncQueue.repository.ts` reclaim → `UPDATE sync_queue SET state='retryable_error' … WHERE local_queue_uuid=? AND EXISTS (SELECT 1 FROM local_invoices i WHERE i.local_uuid=sync_queue.local_aggregate_uuid AND i.company_uuid=? AND i.device_uuid=?)`; `releaseDueRetries` → the same `EXISTS` predicate. Live `6H-atomic-owner-predicate` → ownership revoked between read and write, `updateRefused: true`, `queueRowsByteIdentical: true` | **PASS** |
| 10 | 201 and 200 duplicate produce the same local synced outcome | Both `created` and `duplicate` fall through the single `recorder.record(claimed, { kind: 'synced', … })` at `invoiceUploadWorker.ts:273-277`. Live: `convergedAs: "created"` and `convergedAs: "duplicate"` both end `state: synced`, `backendInvoices: 1` | **PASS** |
| 11 | Terminal `rejected`/`conflict`/`synced` rows are not retried | The eligible/claim queries admit only `state='pending'` (claim) and `state IN ('pending','retryable_error')` (release). Live `6G-synced-never-resent` → 3 restarts, **0** requests; `6F-reclaim-isolation` → 10 protected shapes incl. `synced`, `rejected`, `conflict`, `startupRequests: 0` | **PASS** |
| 12 | Local rows preserved on backend rejection | No `DELETE FROM local_invoice*`, `local_stock_*` or `sync_queue` statement exists anywhere in `src/main`; rejection writes `sync_status` only | **PASS** |
| 13 | Stock/allocation effects occur exactly once | Live, every committed case: `backendInvoices/Items/Payments/UploadAudits/Movements/Consumptions = 1,1,1,1,1,1`, `allocationConsumedMilli: 1000`, `stockQuantity: 9` (from 10) — unchanged by the retry | **PASS** |
| 14 | Movements and consumptions remain pending after upload | The upload path never references `local_stock_movements` or `local_stock_allocation_consumptions` — zero matches in `src/main/sync/` and the queue repository | **PASS** |
| 15 | Allocation release remains impossible | Backend `config/stock_allocations.php:7` → `'release_enabled' => false` with no `.env` override; `StockAllocationService.php:259` returns early without releasing. Desktop has no release writer at all | **PASS** |
| 16 | Successful upload is not treated as bootstrap inclusion | The worker never consults or writes bootstrap inclusion; migration `0007` still forbids `'synced'` for movements (BE-3F-4 not started) | **PASS** |
| 17 | Only typed preload and trusted IPC surfaces exposed | Single `exposeInMainWorld('posApi', …)`; three `sync:*` invoke handlers, all `assertTrustedSender`-guarded | **PASS** |
| 18 | No `/api/v1/admin/*` request possible from the upload path | `resolveDesktopApiUrl()` rejects the prefix explicitly **and** asserts the resolved pathname starts with `/api/v1/desktop/`. Live `assertEveryRequestInDesktopNamespace()` holds on every dispatch; `requestPaths: ["/api/v1/desktop/invoices/upload"]` | **PASS** |

---

## 9. CP-3G-7G — row-count and cleanup proof

### 9.1 Live before/after counts (sanitized; from the evidence ledger of gate run 1)

**Backend**, `CP-3G-6A/6C-server-committed-ack-lost` — server committed, acknowledgment lost,
identical-key replay, then a further restart:

| Backend effect | Before | After first commit | After replay | After a further restart |
|---|---|---|---|---|
| Invoices | 0 | 1 | **1** | 1 |
| Invoice items | 0 | 1 | **1** | 1 |
| Payments | 0 | 1 | **1** | 1 |
| Stock movements | 0 | 1 | **1** | 1 |
| Allocation consumptions | 0 | 1 | **1** | 1 |
| Uploader audits | 0 | 1 | **1** | 1 |
| Post-close adjustments | 0 | 0 | **0** | 0 |
| Allocation consumed (milli) | 0 | 1000 | **1000** | 1000 |
| Stock quantity | 10 | 9 | **9** | 9 |

`CP-3G-6D-pre-commit-crash` (crash **before** the server committed) converged as **created**, ending
at the same one-of-each shape: `backendInvoices: 1`, `backendConsumptions: 1`,
`allocationConsumedMilli: 1000`.

**Desktop**, after every live case:

| Local table | Count |
|---|---|
| `local_invoices` | **1** |
| `local_invoice_items` | 0 |
| `local_invoice_payments` | 0 |
| `local_stock_movements` | 0 |
| `local_stock_allocation_consumptions` | 0 |
| `sync_queue` | **1** |
| `sync_conflicts` | **0** |

**Read this precisely.** The crash suite seeds a queue row plus its local invoice directly from the
frozen payload; it does not replay the whole Phase 3F sale-completion path, so items, payments,
movements and consumptions are legitimately **0** in its local fixture, not "lost". The *server*
side is where one-of-each is asserted. The full 3F local shape is the concern of the CP-5a/3F
fixtures, verified separately by `npm run verify:fixture` (5 fixtures byte-identical) and by the
hermetic Electron suite.

### 9.2 Cleanup proof

| Must not remain | Result |
|---|---|
| A running Laravel server | **NONE** — the only `php -S` is the user's pre-existing port-8000 development server (§1.2), which predates this session |
| An occupied test port | **NONE** — every per-run port confirmed released; final listener set byte-identical to the 14:35:39 baseline |
| A temporary SQLite database | **NONE** — no `pos-desktop-cp3g5-*` sandbox, no `cp3g5-backend.sqlite` |
| A CP-3G sandbox | **NONE** — verified after every run, failures included |
| A bearer token in output | **NONE** — wrapper output searched every run: zero matches |
| A disposable MySQL database | **NONE** — `INFORMATION_SCHEMA` returns 0 rows; only `thinis_pos` remains |
| Credential material | **SHREDDED** — the `0600` defaults file and env file removed |
| Electron temp dirs | **NONE** — no `pos-desktop-electron-node-*` |

---

## 10. Findings

### F1 — The packaged `app.asar` still ships repository test, script and documentation trees

**Class:** packaging hygiene. **Severity:** low. **Status:** reported, **not fixed** (fixing means
editing `electron-builder.yml`, which is a production packaging change and outside CP-3G-7's grant).

`npm run verify:cp3g5-package` passes because its `FORBIDDEN` list names five specific CP-3G-5
assets. An independent enumeration of all 3,087 `app.asar` entries shows `electron-builder.yml`'s
`files:` block contains **only negations**, so electron-builder's include-everything default applies
and these ship inside the application archive:

```
/AGENTS.md  /CLAUDE.md  /CODEX.md  /.ai  /.claude  /docs  /scripts  /tests
/vitest.config.ts  /tsconfig.web.tsbuildinfo
```

60 entries under `tests/` and `scripts/`, including the two **CP-3G-5 harness regression files**
`tests/cp3g5HarnessLifecycle.test.mjs` and `tests/cp3g5HarnessSafety.test.mjs`, plus
`tests/electron/support/liveUploadBackend.ts` and the five golden fixtures.

**What is *not* shipped**, because CP-3G-5's exclusions do cover them: the PHP seeder, the live
upload wrapper, the disposable database, the private fixture and every `pos-desktop-cp3g5-*`
artefact. **No token, credential or payment reference is present.** So the CP-3G-5 safety boundary
holds; what leaks is ordinary repository text and test code.

**Recommendation (Phase 6 packaging/hardening, not now):** convert `files:` to an allowlist, or add
`'!tests'`, `'!scripts'`, `'!docs'`, `'!.ai'`, `'!.claude'`, `'!*.md'`.

### F2 — The live harness fails intermittently at fixture seeding (~40% of runs)

**Class:** live-test-harness reliability. **Severity:** medium — it makes the live gate
non-repeatable on demand. **Status:** reported, **not fixed** (the fix is a code change to
`tests/electron/support/cp3g5/seedLiveBackend.php`, outside CP-3G-7's grant).

**Observed:** 15 live executions, **6 failures**, all at the same stage, all with the same opaque
message `[cp3g5] fixture seeding failed with no child output forwarded`. The failure is
**independent of `CP3G5_PAYLOADS`** (observed at both 21 and 32) and **not reproducible on demand** —
the identical command alternates pass and fail with no input change:

```
32 → FAIL     32 → PASS     21 → PASS     17 → PASS     32 → FAIL ×3
21 → PASS     32 → PASS     21 → PASS     32 → FAIL     21 → PASS ×2     21 → FAIL
```

**Why the cause is not stated here.** The seeder sets `display_errors=0` and buffers output, and the
wrapper discards the child's stdout/stderr as part of its redaction boundary
(`sanitizedChildFailure`). The failure therefore surfaces only as a non-zero exit. Diagnosing it
further would require running the seeder outside the wrapper — **exactly the CP-3G-5 incident that
the frozen harness-safety correction exists to prevent** — so it was not done.

**What was established, read-only:** the seeding stage takes ≈0.65 s wall-clock, and pass/fail does
not correlate with that duration, which is consistent with a **timing-phase-sensitive** failure
rather than a load or resource one (`/tmp` 1% used, 7.3 GB free, 1,046,223 free inodes, 7.3 GB RAM
available). A **candidate, explicitly unconfirmed** mechanism sits in the seeder's use of a single
fixed `$soldAt = $shift->opened_at` for every minted payload while each product's revision-validity
window starts at its own creation time — `SellableProductResolver::resolveCurrent()` throws
`SellableCatalogUnavailable` when `$asOf->lt($validFrom)`, and the seeder's outer
`catch (Throwable)` converts any such throw into `rejectSeeder('fixture creation failed')`. **This
is a hypothesis from source reading, not an observed exception, and is labelled as such.**

**What this does *not* undermine.** The failure is a *setup* failure, never a product assertion. On
all seven full-coverage runs that reached the suite, the suite passed with **zero failure-ledger
lines**. Every failure **failed closed** and cleaned up completely — sandbox removed and verified
absent, port released, no owned process, no secret in output.

**Relationship to CP-3G-6.** CP-3G-6 reported "two consecutive authorized live runs, exit 0 / exit 0,
no manual cleanup". This session reproduced two consecutive full-coverage runs (gate runs 1 and 2),
so that claim holds — but **at roughly a 60% per-run success rate**, which CP-3G-6 did not record.
Per §9.5.1's own precedent of preserving unreproducible-gate history rather than rewriting it, this
is recorded as a **new finding against the harness**, not as a contradiction of CP-3G-6's product
conclusions.

**Recommendation:** a separately authorized harness fix — make the seeder's `$soldAt` derive from
each product's own revision window (or pin the products' revision start to the shift's
`opened_at`), and widen the wrapper's failure channel to carry a redaction-safe *reason code* rather
than only an exit status.

---

## 11. Complete command ledger

Chronological, with exit codes. Every line is **executed now**.

```
14:30:12  npm run typecheck                                              exit 0
14:30:23  npm run lint                                                   exit 0
14:30:24  npm run test                                                   exit 0
14:30:34  npm run test:cp3g5-harness                                     exit 0
14:32:11  npm run verify:fixture                                         exit 0
14:32:11  npm run smoke:database                                         exit 0
14:32:11  npm run test:sqlite:electron                                   exit 0
14:32:41  npm run build                                                  exit 0
14:32:54  npm run build:unpack                                           exit 0
14:33:13  npm run verify:cp3g5-package                                   exit 0
14:33:13  git diff --check                          (desktop)            exit 0
14:33:20  asar list dist/linux-unpacked/resources/app.asar               3087 entries
14:35:46  node scripts/cp3g5LiveUpload.mjs                     [16]      exit 0   (partial coverage)
14:37:02  CP3G5_PAYLOADS=32 node scripts/cp3g5LiveUpload.mjs             exit 1   (seeding)
14:37:37  CP3G5_PAYLOADS=32 node scripts/cp3g5LiveUpload.mjs             exit 0
14:37:55  CP3G5_PAYLOADS=21 node scripts/cp3g5LiveUpload.mjs             exit 0
14:38:14  CP3G5_PAYLOADS=17 node scripts/cp3g5LiveUpload.mjs             exit 0
14:38:47  CP3G5_PAYLOADS=32 node scripts/cp3g5LiveUpload.mjs  ×3         exit 1,1,1 (seeding)
14:39:xx  CP3G5_PAYLOADS=21|32 node scripts/cp3g5LiveUpload.mjs ×4       exit 0,0,0,1
14:41:06  CP3G5_PAYLOADS=21 … cp3g5LiveUpload.mjs   GATE RUN 1          exit 0   20 evidence / 0 failures
14:41:24  CP3G5_PAYLOADS=21 … cp3g5LiveUpload.mjs   GATE RUN 2          exit 0   20 evidence / 0 failures
14:41:43  CP3G5_PAYLOADS=21 … cp3g5LiveUpload.mjs                        exit 1   (seeding)
14:42:xx  CP3G5_PAYLOADS=21 … cp3g5LiveUpload.mjs   ×4 timed            exit 0,0,0,1
14:45:58  php artisan test                          (SQLite, full)       exit 0
14:47:12  php artisan test --compact <14 focused files>                  exit 0
14:47:30  php artisan test --compact <each of the 14, individually>      exit 0 ×14
14:48:42  CREATE DATABASE thinis_pos_cp3g7_20260903144842                created
14:49:36  php artisan migrate --force --no-interaction   (strict MySQL)  exit 0
14:50:02  php artisan test                          (strict MySQL, full) exit 0
14:59:12  php artisan test --compact <3 concurrency files> + 3 flags     exit 0
15:02:1x  DROP DATABASE thinis_pos_cp3g7_20260903144842 + IS verify      0 rows
15:02:28  vendor/bin/pint --test --format agent                          exit 1   (pre-existing)
15:02:42  php artisan architecture:scan-routes                           exit 0
15:02:42  php artisan architecture:scan-permission-matrix                exit 0
15:02:42  php artisan architecture:scan-controllers                      exit 0
15:02:43  php artisan architecture:report                                exit 0
15:02:43  git diff --check                          (backend)            exit 0
15:03:xx  php artisan route:list --path=api/v1/desktop                   78 routes
```

---

## 12. Evidence classification summary

### Executed now

Everything in §3-§9: all 11 desktop gates; 15 live harness executions; the full SQLite backend
suite and 14 focused suites (individually and together); disposable-MySQL creation, migration, full
suite, concurrency arms, drop and `INFORMATION_SCHEMA` verification; all backend static gates;
`route:list`; both `git diff --check` runs; the packaged-output audit; and every §8 invariant.

### Carried forward (cited, not re-badged)

| Source | What it owns |
|---|---|
| CP-3G-5 report (`73912b1`, SHA-256 `89b3a53c…`) | The original 18-requests/18-attempts transport ledger; the harness-safety correction; the 217/217 authorized live gate |
| CP-3G-6 report (`9a1232b`, SHA-256 `0c5cf154…`) | The frozen crash-recovery conclusions and the owner-scoped reclaim correction; ports 37937/38321; the superseded-claim history in §9.5.1 |
| BE-3G-0 report (backend `2bcce42`) | The ten-row contract proof; the earlier disposable database `thinis_pos_be3g0_20260902224201`; findings F3 (Pint) and the controller-length baseline |

This session **reproduced** CP-3G-6's desktop figures (879/100, 33/33, 237/203/34, 124+1) and
BE-3G-0's backend figures (686/5/3,051 on both engines, 5/56/0 concurrency) — but they are reported
above as *executed now* because they were re-run here, not because the earlier reports asserted them.

### User-only / manual

The thirteen GUI observations **E1-E13**. **Zero are marked.** See §13.

### Not executed

| Item | Reason |
|---|---|
| OpenAPI schema validation | No validator exists in the repository (§7.2). Not manufactured. |
| BE-3F-4 | Out of scope by Revision 5 §10. |
| Allocation release | Disabled and out of scope. |
| Development-fixture cleanup from the CP-3G-5 incident | Explicitly a separate maintenance item; **still NOT CLEANED**. |
| Any staging, commit, push or deployment | Out of scope. |

---

## 13. Manual GUI checklist

Emitted, unrun and unmarked:

**`docs/audits/phase-3g-manual-gui-smoke-checklist.md`**

Thirteen items E1-E13, every box unchecked. **AUTOMATED GATE PASS DOES NOT COMPLETE THAT
CHECKLIST.** No agent may mark any item. CP-3G-6's crash-recovery proof establishes E4's *property*
at the process, transport and database level; that is **not** the on-screen observation and does not
close E4.

---

## 14. Every warning and skipped test

| Item | Count | Disposition |
|---|---|---|
| `npm run test` skips | 0 | — |
| `npm run test:cp3g5-harness` skips | 0 | — |
| `npm run test:sqlite:electron` skips | **34** | Intentional live-only gates, all reason `no live CP-3G-5 backend provided`; all executed under the live gate (§4) |
| Backend SQLite suite skips | **5** | The MySQL-gated concurrency arms; executed with zero skips under MySQL (§6.3) |
| Backend strict-MySQL suite skips | **5** | The same arms — they need the three activation flags, not merely a MySQL connection |
| Backend concurrency arms skips | **0** | Executed |
| electron-builder `duplicate dependency references` | 1 informational line | Pre-existing packaging notice (§3.2) |
| Pint | 1 failing file | Pre-existing test-fixture finding, not a regression (§7.1) |
| `architecture:scan-controllers` | 1 violation | Pre-existing, not on the desktop route surface (§7.1) |
| Live runs skipping the CP-3G-6 crash arms | 2 of 15 (budgets 16 and 17) | Recorded as partial coverage; not counted as gate evidence (§4.2) |

---

## 15. Remaining blockers

| Blocker | Owner | Status |
|---|---|---|
| **Manual GUI smoke E1-E13** | **the user** | **NOT RUN** — the only thing standing between CP-3G-7 and Phase 3G closure |
| F2 — live-harness fixture-seeding flake | separate authorization | Open; does not invalidate the product evidence obtained |
| F1 — packaged repository trees | Phase 6 packaging | Open; low severity, no secret exposure |
| CP-3G-5 accidental development fixtures | separate maintenance item | **STILL NOT CLEANED** — no deletion authorized, executed or verified here |
| BE-3F-4 | out of scope | NOT STARTED |
| Allocation release | out of scope | DISABLED |

Acceptance-matrix row 20 ("full gate green in both repositories in one session") is **satisfied on
its automated half by this session**; the row's checkpoint stays open until the user returns E1-E13.

---

## 16. Final status — **SUPERSEDED, retained as the historical record**

> **This verdict was wrong and is withdrawn.** It reported `PASS` while §10's finding F2 recorded
> six live-harness failures in fifteen executions. The corrected verdict is in §18.13. The block is
> preserved exactly as written so the error stays visible rather than being quietly rewritten.

```
CP-3G-7 automated verification:   PASS          <-- SUPERSEDED: should have been FAIL/BLOCKED
CP-3G-7 overall:                  AWAITING USER GUI SMOKE
Phase 3G closure:                 BLOCKED ON E1–E13 USER RESULTS
Production activation:            NOT AUTHORIZED
```

---

## 17. Verification summary — **SUPERSEDED, retained as the historical record**

> Superseded by §18.14. Its `Live disposable-Laravel gate: PASS` line is the specific error: the
> gate was not passing. Retained unedited.

```
Revision 5 read completely:             PASS
Frozen CP-3G-6 baseline:                PASS
Desktop full gate:                      PASS   (11/11 commands, exit 0)
Live disposable-Laravel gate:           PASS   (product evidence; harness reliability = finding F2)
Backend full SQLite gate:               PASS   (691/686/5, 3,051 assertions)
Backend strict-MySQL gate:              PASS   (691/686/5, 3,051 assertions, six strict modes)
Backend MySQL concurrency:              PASS   (5/5, 56 assertions, 0 skipped)
Backend static/architecture gates:      PASS   (pre-existing Pint + controller findings preserved)
Cross-repository invariants:            PASS   (18/18)
Exactly-once effects:                   PASS
Owner-scoped recovery:                  PASS
Harness process cleanup:                PASS   (15/15 runs, failures included)
Temporary SQLite cleanup:               PASS
Disposable MySQL cleanup:               PASS   (INFORMATION_SCHEMA: 0 rows)
Outbound desktop namespace:             PASS
Manual GUI checklist generated:         PASS
Manual GUI items passed:                0/13 — USER ONLY
Production application code modified:   NO
Tests/support/docs modified:            docs/audits/cp-3g-7-combined-verification-checkpoint.md (new)
                                        docs/audits/phase-3g-manual-gui-smoke-checklist.md (new)
                                        — no test, script, source or configuration file changed
Plan modified:                          NO
Migration added:                        NO
Dependencies added:                     NO
CP-3G-7 automated verification:         PASS
CP-3G-7 overall:                        AWAITING USER GUI SMOKE
Phase 3G closure:                       BLOCKED ON E1–E13 USER RESULTS
Allocation release enabled:             NO
BE-3F-4 implemented:                    NO
Production activation authorized:       NO
Files staged/committed/pushed:          NO
```

**No backend code was modified. No forbidden action occurred.** The backend worktree carries only
the untracked BE-3G-0 report, exactly as CP-3G-5 and CP-3G-6 recorded it.

**Recommended next step.** The user runs `docs/audits/phase-3g-manual-gui-smoke-checklist.md` from
their own terminal and returns the E1-E13 results. Phase 3G may not be declared complete on this
automated evidence alone. Findings F1 and F2 should each be given their own authorization rather
than folded into a later checkpoint.

---

# 18. CP-3G-7 evidence correction — finding F2 diagnosed, corrected and re-verified

**Session date:** 2026-09-03 (same day, later session).
**Frozen baseline:** desktop `9a1232ba90b3a2fe3799bc42d02bca1d14c79c22`, backend
`2bcce42e9102d76eb57a24445791499989912a05`. Both unchanged throughout.
**Authorization:** the CP-3G-7 live-harness reliability correction for F2 only. **F1 was explicitly
not authorized** and remains open.

---

## 18.1 What the original run reported, and why its PASS was invalid

The original CP-3G-7 gate ran the authorized live harness **15 times**:

- **9 succeeded**, and every one that reached the suite passed with zero failure-ledger lines;
- **6 failed during fixture seeding**, each failing closed with complete cleanup;
- the failure was **not reproducible on demand**;
- **the cause was unknown**.

§10's finding F2 recorded all of this accurately. §16 and §17 nevertheless reported
`CP-3G-7 automated verification: PASS` and `Live disposable-Laravel gate: PASS`.

**That was the error.** A gate is not passing because a subset of its reruns passed. With a 40%
per-run failure rate and no diagnosis, the correct verdict was:

```
CP-3G-7 live harness gate:        FAIL
CP-3G-7 automated verification:   BLOCKED
CP-3G-7 overall:                  BLOCKED
Phase 3G closure:                 BLOCKED
```

Three specific reasoning faults produced the invalid PASS:

1. **Selective rerun.** Two consecutive green runs were promoted to gate evidence while six red runs
   were demoted to a "finding". Consecutive success is a *property of the sample*, not of the gate.
2. **Misclassification as non-product.** "It is a setup failure, never a product assertion" is true
   but irrelevant to the gate's verdict: a gate that cannot start reliably cannot certify anything.
3. **Unknown cause treated as bounded risk.** An undiagnosed intermittent failure inside the very
   harness that produces the duplicate-safety and crash-recovery evidence can never be bounded in
   advance — it could equally have been a lock, a race, or a lost write.

The original text stands in §1–§17. This section supersedes its verdict only.

---

## 18.2 The diagnostic channel added to reach a root cause

The failure was invisible by construction: the seeder sets `display_errors=0` and buffers output,
and the wrapper discards the child's stdio as part of its redaction boundary. A diagnostic channel
was therefore added on both sides, **without opening that boundary**.

### Seeder side (`tests/electron/support/cp3g5/seedLiveBackend.php`)

- Three run-scoped globals track the lifecycle position: `$cp3g5Phase`, `$cp3g5Operation`,
  `$cp3g5Iteration`, updated at each step of authorization, bootstrap, minting and fixture writing.
- `cp3g5Diagnostic()` emits **one** line, `CP3G5-DIAG {json}`, containing only:
  `phase`, `operation`, `iteration`, `code`, `exception`, `sqlstate`, `driver_code`,
  `transaction_level`, `identifier`.
- Every string value must match `\A[A-Za-z0-9_.\\-]{1,120}\z` at the source. A message, a SQL
  binding, a token or a payment reference cannot satisfy that shape.
- `cp3g5DatabaseIdentifier()` recognises only fixed constraint markers (`UNIQUE constraint failed:`,
  `NOT NULL constraint failed:`, `CHECK constraint failed:`, `no such table:`, `no such column:`,
  `FOREIGN KEY constraint failed`, `database is locked`, `database table is locked`,
  `attempt to write a readonly database`, `disk I/O error`) and captures only the bare
  `table.column` text that follows one. Every other message shape yields nothing.
- The former `catch (Throwable)` — which discarded the exception entirely — now captures the
  **class name**, the **SQLSTATE**, the **driver error code** and the **transaction level**, and
  still never the message.
- **The channel is silent unless the authorized wrapper switches it on** (`CP3G5_DIAGNOSTICS=1`).
  An unauthorized direct invocation therefore still produces exactly the single low-information
  rejection line CP-3G-5 froze — asserted byte-for-byte by an existing, unmodified test.

### Wrapper side (`scripts/cp3g5LiveUpload.mjs`)

- `LIFECYCLE_PHASES` enumerates the eleven required positions: `sandbox-create`, `authorization`,
  `pre-bootstrap-check`, `laravel-bootstrap`, `migrate`, `seed`, `fixture-write`, `server-start`,
  `electron-run`, `server-stop`, `cleanup`. `setPhase()` rejects anything else.
- `parseChildDiagnostics()` accepts **only** exact `CP3G5-DIAG {json}` lines and then re-validates
  every key and value against the same allowlist. Everything else in the captured buffer — a
  warning, a stack frame, a leaked value — is discarded. The check is deliberately **double-sided**:
  the seeder emits only safe fields, and the wrapper independently accepts only safe fields.
- `sanitizedChildFailure()` surfaces the parsed diagnostics **before cleanup runs**, while cleanup
  still removes every temporary resource.
- Each run prints an opaque `run identity` — `sha256(sandbox basename)` truncated to 12 hex — so a
  repetition driver can prove no two iterations shared a sandbox **without disclosing the sandbox
  path or the run nonce**.

### What a failing run can now distinguish

| Class | How it shows |
|---|---|
| migration failure | `phase: migrate`, `code: child-failed` |
| factory/model failure | `phase: seed` + the exact `operation` + exception class |
| uniqueness collision | `sqlstate: 23000`, `driver_code: 19`, `identifier: <table.column>` |
| transaction/locking failure | `identifier: database-locked` / `table-locked`, plus `transaction_level` |
| filesystem race | `phase: fixture-write`, `operation: response-reservation` / `write-fixture` |
| nonce/marker failure | `phase: authorization`, `code: rejected` |
| result-file race | `phase: fixture-write`, `operation: response-reservation` |
| process lifecycle failure | wrapper-side `code: child-failed` with the child's exit status |
| port/server failure | `phase: server-start` |

---

## 18.3 The bounded reproduction driver

`tests/electron/support/cp3g5/seedReliability.mjs` (191 lines), run through
`npm run test:cp3g5-reliability`.

- It **only spawns the authorized wrapper**. It never touches the seeder, the sandbox, the nonce,
  the database or the fixture, so every wrapper guarantee holds for every iteration.
- **Bounded by construction**: `--iterations` must be an integer in `1..500`, and the loop has no
  other exit path. There is no unbounded retry anywhere.
- Every iteration gets a fresh mkdtemp directory, nonce, SQLite file, result file and port —
  supplied by the wrapper, and *proved* by the driver: it collects each run's opaque identity and
  port and fails if any repeats.
- It **refuses to start** if any harness temporary directory already exists, and re-checks after
  every single iteration, so a leftover is always attributable to the iteration that just ended.
- `CP3G5_SEED_ONLY=1` exercises `sandbox-create → migrate → seed → fixture-write → cleanup` and
  skips only the server and the Electron suite. It **relaxes no authorization check, no path guard
  and no cleanup step** — it stops earlier, nothing more.

It lives under `tests/electron/support/cp3g5/`, which `electron-builder.yml` already excludes via
`!tests/electron/support/cp3g5/**`. That keeps the new asset out of `app.asar` **without editing
packaging configuration**, which the unauthorized F1 finding still owns.

---

## 18.4 Reproduction ledger

Every line executed now, through the authorized wrapper only.

| # | Mode | Payloads | Iterations | Pass | Fail | Diagnostic on failure |
|---|---|---|---|---|---|---|
| R1 | seed-only | 21 | 25 | 25 | 0 | — |
| R2 | full live | 21 | 6 (stop-on-failure) | 5 | **1** | `seed / sellable-resolve / fixture-creation-failed` |
| R3 | full live | 21 | 15 | 15 | 0 | — |
| R4 | **seed-only** | **100** | 10 | 1 | **9** | `seed / sellable-resolve / fixture-creation-failed / App\Modules\Catalog\Exceptions\SellableCatalogUnavailable` |

**R2 reproduced the original 6/15 failure with a definitive diagnostic.** Its exception class was
initially dropped by a too-strict PHP value-shape regex (a single-quoted `\\-` put an escaped hyphen,
not a backslash, in the character class), so namespaced class names could not survive. That was
corrected and R4 carried the class name through.

**R4 is the decisive experiment.** Raising the payload count from 21 to 100 — which lengthens the
minting loop and nothing else — moved the failure rate from ~40% to **90%**. The failing loop index
varied run to run (14, 15, 16, 16, 16, 19, 20, 20, 78) while wall-clock duration clustered at
**~1000 ms** in every failing run and the single passing run completed the whole loop. A defect that
fires at a different item each time, always about one second in, is a clock-boundary defect — not a
collision, not a lock, not a lost write.

---

## 18.5 Root cause — established, not speculated

> **The seeder's fixture time basis was nondeterministic.**
>
> `$soldAt` was pinned to `$shift->opened_at` — one second-precision timestamp written **once**,
> before the minting loop (`shifts.opened_at` is `$table->timestamp(...)`; `ShiftFactory` sets
> `now()`). Each minted product's catalog-revision validity window instead began at **that
> product's own** second-precision `updated_at`, because `ProductFactory` never sets
> `sellable_revision_started_at`, so `SellableProductResolver::resolveCurrent()` fell through to
> `$product->updated_at`:
>
> ```php
> $validFrom = CarbonImmutable::instance(
>     $product->sellable_revision_started_at ?? $product->updated_at ?? $product->created_at ?? $asOf
> );
>
> if ($asOf->lt($validFrom) || $validUntil->lte($asOf)) {
>     throw new SellableCatalogUnavailable('The product revision is unavailable at the requested time.');
> }
> ```
>
> Seeding therefore succeeded **only while every product was created inside the same wall-clock
> second as the shift row**, and threw the moment the clock ticked past it. The seeder's outer
> `catch (Throwable)` converted that into `rejectSeeder('fixture creation failed')`.

**Exact failing operation:** `SellableProductResolver::resolveCurrent()`, reached from the seeder's
minting loop at `$cp3g5Operation = 'sellable-resolve'`.
**Exception category:** a **domain** exception, `App\Modules\Catalog\Exceptions\SellableCatalogUnavailable` —
not a `QueryException`, no SQLSTATE, no driver code, `transaction_level: 1` (the fixture transaction
was open and was rolled back correctly).

Against the categories the mission asked to separate:

| Candidate cause | Verdict |
|---|---|
| **Nondeterministic generated test values** | **CONFIRMED — this is the cause** |
| Invalid randomly generated model relationships | Ruled out — relationships are explicit; the same graph succeeds when the loop stays inside one second |
| Duplicate generated values | Ruled out — no SQLSTATE `23000`, no `driver_code 19`, no `UNIQUE`/`identifier` in any diagnostic; `price_revision` and `catalog_revision` both hash `product_uuid`, which is unique per product |
| Transaction behaviour / SQLite contention | Ruled out — no `database-locked`, no `table-locked`; a single process owns the disposable file; the transaction rolled back cleanly (`transaction_level: 1`) |
| File IPC ordering | Ruled out — failure is inside `phase: seed`, before `write-fixture`; the reservation succeeded |
| Premature cleanup | Ruled out — cleanup runs strictly after, and verified absent on every failure |
| Child-process ordering | Ruled out — no server or Electron process exists yet at `phase: seed` |
| Port/server failure | Ruled out — no port is reserved until after seeding |

The earlier CP-3G-7 §10 text offered this mechanism as an explicitly **unconfirmed hypothesis**. It
is now confirmed by diagnostic, by exception class, and by the R4 dose-response experiment.

---

## 18.6 The correction

**One idea, applied in one file:** give the run a single deterministic, run-scoped time anchor, and
pin both sides of the comparison to it.

`tests/electron/support/cp3g5/seedLiveBackend.php`:

1. `$runAnchor = CarbonImmutable::instance($shift->opened_at ?? now())`, computed **once**, after
   the shift is created and before the minting loop.
2. Every minted product is created with `'sellable_revision_started_at' => $runAnchor`, so
   `$validFrom` is the anchor for **every** product instead of that product's own creation instant.
3. `$soldAt = $runAnchor` replaces the per-iteration
   `CarbonImmutable::instance($shift->opened_at ?? now())`.

`$asOf` and `$validFrom` are now the same value for every payload, so `$asOf->lt($validFrom)` is
false regardless of how long minting takes. The comparison no longer depends on wall-clock timing at
all.

This also removes the same latent fragility from the **upload** path: the backend re-resolves the
snapshot at upload time using the payload's `sold_at`, and that re-resolution previously carried the
identical timing dependency.

### Against every constraint the mission set

| Requirement | Held |
|---|---|
| 1. Production Electron code unchanged | **YES** — no file under `src/` is touched |
| 2. Backend code unchanged | **YES** — backend worktree still carries only the untracked BE-3G-0 report |
| 3. Nonce-bound authorization preserved | **YES** — untouched; still asserted by the frozen safety tests |
| 4. Pre/post-bootstrap SQLite verification preserved | **YES** — untouched, now additionally phase-labelled |
| 5. Owner-only file IPC preserved | **YES** — the `0600` reservation and permission re-check are unchanged |
| 6. Atomic fixture transaction preserved | **YES** — same single transaction, same rollback path |
| 7. Process-group cleanup and per-run ports preserved | **YES** — untouched; re-proven 15/15 |
| 8. Unauthorized direct-invocation rejection preserved | **YES** — diagnostics are gated behind `CP3G5_DIAGNOSTICS=1`, so the frozen byte-exact rejection assertion passes unmodified |
| 9. Token redaction and packaging exclusions preserved | **YES** — packaged set is byte-identical to baseline (124 files, 1 asar, same six `/scripts/` entries) |
| 10. No blind retries | **YES** — **no retry of any kind was added**. The driver is a bounded *measurement* tool; the fix removes the failure mode rather than re-attempting it |
| 11. Deterministic, run-scoped generated values | **YES** — this is precisely the fix |
| 12. Explicit handshake rather than a sleep | N/A — ordering was not the cause; no sleep was added |
| 13. No blind timeout increases | **YES** — no timeout anywhere was changed |

---

## 18.7 Before / after on the identical adversarial case

| Case | Before the fix | After the fix |
|---|---|---|
| seed-only, 100 payloads, 10 iterations | **1 pass / 9 fail** | **10 pass / 0 fail** |

Same command, same payload count, same machine, same session. The only change is the run anchor.

---

## 18.8 Reliability acceptance — all criteria met

### 1. Fifty consecutive authorized seed-only iterations

```
npm run test:cp3g5-reliability -- --iterations 50 --seed-only --payloads 21
```

| Criterion | Required | Observed |
|---|---|---|
| Successes | 50 | **50** |
| Failures | 0 | **0** |
| Unique sandboxes / databases | 50 | **50 distinct run identities, no duplicate** |
| Leftovers | 0 | **0** — checked after every single iteration |

### 2. Fifteen consecutive complete live harness executions

Fifteen consecutive wrapper invocations at `CP3G5_PAYLOADS=21` (full CP-3G-6 coverage), each with
its own evidence file, **no manual cleanup between any of them**.

| Criterion | Required | Observed |
|---|---|---|
| Successes | 15 | **15** |
| Setup failures | 0 | **0** |
| Product failures | 0 | **0** |
| Failure-ledger lines | 0 | **0** across all 15 |
| Evidence lines per run | full coverage | **20 in every run** (15 × 20 = 300) |
| Manual cleanup between runs | none | **none** |
| Unique run identity | 15 | **15** |
| Unique port | 15 | **15** — 46367, 37921, 37649, 37335, 46133, 38827, 39437, 43453, 39255, 40861, 37091, 41883, 33361, 43213, 44691 |
| Stray temporary directories | 0 | **0** after every run |

### 3. Two consecutive full-coverage CP-3G-6 crash runs

Runs 1 and 2 above — and in fact every consecutive pair of the fifteen. Each carries all **six real
`SIGKILL` boundaries**:

| Case | Stage | Converged as | Backend invoices | Requests after success |
|---|---|---|---|---|
| `CP-3G-6E-claim-boundary` | before-dispatch | — (never sent) | — | — |
| `CP-3G-6D-pre-commit-crash` | before-dispatch | **created** (201) | **1** | **0** |
| `CP-3G-6E-in-flight` | in-flight | **duplicate** (200) | **1** | **0** |
| `CP-3G-6A/6C-server-committed-ack-lost` | response-received | **duplicate** (200) | **1** | **0** |
| `CP-3G-6E-before-outcome` | before-outcome | **duplicate** (200) | **1** | **0** |
| `CP-3G-6E-during-outcome` | during-outcome | **duplicate** (200) | **1** | **0** |

201/200 convergence and exactly-once effects hold in both runs, identically.

### 4–8. Cleanup and redaction

| Criterion | Result |
|---|---|
| Unique port per run | **PASS** — 15/15 distinct; seed-only runs reserve no port at all |
| Unique database per run | **PASS** — 65 distinct run identities across both acceptance suites, zero repeats |
| Every port released | **PASS** — final listener set byte-identical to the pre-session baseline |
| Every server process group terminated | **PASS** — no owned `artisan`/`php -S` process survives any run |
| Every temporary directory removed | **PASS** — 0 strays after all 65 iterations plus the harness gate |
| No token in stdout, stderr, reports or retained files | **PASS** — see below |

**Token sweep.** Every wrapper log, every evidence file and every driver log was searched for
`plainTextToken`, `Bearer <value>`, the Sanctum `<id>|<40-char>` shape, `Stack trace` and 64-hex
nonce material: **zero matches**. The only hits anywhere in the session were two occurrences of the
*name of a passing test* — "wrapper output stays free of tokens and stack traces on every failure
path" — in the harness TAP output.

---

## 18.9 Regression tests

`npm run test:cp3g5-harness` → **38 tests / 38 pass / 0 fail / 0 skipped**, exit 0, serialized with
`--test-concurrency=1`.

**All 33 frozen CP-3G-5/6 cases still pass, unmodified.** Five were added:

| New test | Proves |
|---|---|
| *seeding survives a minting loop that spans several wall-clock seconds* | The root cause directly: 100 payloads guarantee a second-boundary crossing on any machine; asserts exit 0 and that no `sellable-resolve` / `fixture-creation-failed` diagnostic appears |
| *seed-only mode still performs the complete cleanup and leaks nothing* | Skipping the server skips no cleanup step |
| *every run reports a distinct opaque identity, and never its sandbox path or nonce* | Two runs never share an identity; output never contains the sandbox directory name or 64-hex material |
| *the diagnostic channel accepts only whitelisted, shape-checked fields* | Nine hostile inputs — a Sanctum-shaped token, a `Bearer` value, a SQL statement with bindings, a spaced string, a 500-char value, malformed JSON, a JSON array, a raw `PDOException` line, a stack frame — all lose their unsafe fields or are dropped whole |
| *a genuine seeder diagnostic survives the parser intact* | The channel is actually useful: a real record keeps phase, operation, code, exception class, SQLSTATE, driver code, identifier, iteration and transaction level |

Explicitly preserved and re-proven green in the same gate: direct seeder invocation rejection
(byte-exact), unrelated PHP server protection, timeout cleanup, SIGTERM→SIGKILL escalation,
sequential test-file execution, cleared timeout behaviour, package-boundary verification.
Owner-scoped reclaim/retry release, the six SIGKILL boundaries, 201/200 convergence and
exactly-once effects are re-proven by the fifteen live runs in §18.8.

---

## 18.10 Files changed

| File | Change |
|---|---|
| `tests/electron/support/cp3g5/seedLiveBackend.php` | Diagnostic primitives, lifecycle phase/operation tracking, safe exception extraction, and the deterministic run anchor (**the fix**) |
| `scripts/cp3g5LiveUpload.mjs` | Lifecycle phases, `parseChildDiagnostics()`, diagnostic surfacing before cleanup, opaque run identity, seed-only mode, `CP3G5_DIAGNOSTICS=1` |
| `tests/cp3g5HarnessLifecycle.test.mjs` | Five F2 regression tests, a seed-only cleanup assertion, and two env names added to the scrub list |
| `tests/cp3g5HarnessSafety.test.mjs` | One env name added to the scrub list (`CP3G5_DIAGNOSTICS`) |
| `package.json` | One script line: `test:cp3g5-reliability` |
| `tests/electron/support/cp3g5/seedReliability.mjs` | **New** — the bounded repetition driver (191 lines) |

**501 insertions, 8 deletions across 5 modified files, plus 1 new file.**

**Not touched:** any file under `src/` (no production Electron code), `electron-builder.yml`, any
migration, `package-lock.json`, any dependency, and the entire pos-backend repository.

---

## 18.11 Final combined gate, re-executed against the corrected worktree

### Desktop — all eleven, exit 0

| Command | Result |
|---|---|
| `npm run typecheck` | **PASS**, exit 0 |
| `npm run lint` | **PASS**, exit 0 — zero errors, zero warnings |
| `npm run test` | **PASS — 100 files / 879 tests**, 0 failed, 0 skipped |
| `npm run test:cp3g5-harness` | **PASS — 38 / 38**, 0 fail, 0 skipped (33 frozen + 5 new) |
| `npm run verify:fixture` | **PASS** — 5 fixtures byte-identical, hashes independently verified |
| `npm run smoke:database` | **PASS** |
| `npm run test:sqlite:electron` | **PASS — 237 registered / 203 passed / 0 failed / 34 intentional live-only skips** |
| `npm run build` | **PASS**, exit 0 |
| `npm run build:unpack` | **PASS**, exit 0 |
| `npm run verify:cp3g5-package` | **PASS** — 124 files and 1 `app.asar`, no forbidden asset |
| `git diff --check` | **PASS** — no output |

The packaged set is **byte-identical to the pre-correction baseline**: 124 files, one `app.asar`,
the same six `/scripts/` entries. The new driver ships nowhere, because it lives inside the already
excluded `tests/electron/support/cp3g5/**`.

### Backend

| Gate | Result |
|---|---|
| Full SQLite suite | **691 tests / 686 passed / 0 failed / 5 skipped / 3,051 assertions**, exit 0 |
| Focused upload / allocation / history suites (14 files) | **122 / 122 passed / 835 assertions / 0 skipped**, exit 0 |
| Full strict-MySQL suite | **691 / 686 / 0 / 5 skipped / 3,051 assertions**, exit 0 |
| MySQL concurrency (all five BE-3F-2B/3/5 cases, three activation flags) | **5 / 5 passed / 56 assertions / 0 skipped**, exit 0 |
| Pint | **PRE-EXISTING TEST-FIXTURE FINDING** — `tests/Fixtures/routes/api.php`, `braces_position`; identical to BE-3G-0 F3, not a regression |
| `architecture:scan-routes` | **PASS** — no violations |
| `architecture:scan-permission-matrix` | **PASS** — no violations |
| `architecture:report` | routes 0, permissions 0, controller-length **1** — `CompanyUserPermissionController::assignableRoles`, identical to the BE-3G-0 baseline |
| `git diff --check` | **PASS** — no output |

The 5 SQLite skips are the MySQL-gated concurrency arms, executed with **zero skips** under MySQL.

### Disposable MySQL lifecycle

| Step | Evidence |
|---|---|
| Generated name | `thinis_pos_cp3g7_20260903155030` — **newly generated**, distinct from the original session's database |
| Validated against `^thinis_pos_cp3g7_[0-9]{14}$` | **PASS** — before creation **and again immediately before the `DROP`** |
| Pre-creation collision check | `INFORMATION_SCHEMA` → **0** |
| Credentials | The repository's own `.env` credential, staged in a `0600` defaults file and a `0600` env file, **never printed**, both shredded afterwards |
| Strict SQL mode | `ONLY_FULL_GROUP_BY, STRICT_TRANS_TABLES, NO_ZERO_IN_DATE, NO_ZERO_DATE, ERROR_FOR_DIVISION_BY_ZERO, NO_ENGINE_SUBSTITUTION` — all six |
| Laravel's own view | driver `mysql`, configured **and** active database both exactly the disposable name, 0 tables before migrate |
| Migration | exit 0 |
| Verified removal | `DROP` executed; `INFORMATION_SCHEMA` → **0 rows**; remaining `thinis_pos%` schemas: **`thinis_pos` only** |
| Normal development database | `thinis_pos` — **never named in any destructive command**; 74 tables before and after |

---

## 18.12 Cleanup and repository state

| Check | Result |
|---|---|
| Harness sandboxes (`pos-desktop-cp3g5-*`) | **NONE** |
| Electron temp dirs (`pos-desktop-electron-node-*`) | **NONE** |
| Owned Laravel server / listener | **NONE** — the only `php -S` is the user's own pre-existing port-8000 development server (pid 39162, started 14:10:31, before this work), left untouched |
| Loopback listener set | **byte-identical** to the pre-session baseline |
| Disposable MySQL database | **REMOVED**, verified through `INFORMATION_SCHEMA` |
| Credential material | **SHREDDED** |
| Desktop HEAD | `9a1232ba90b3a2fe3799bc42d02bca1d14c79c22` — unchanged |
| Backend HEAD / status | `2bcce42…`, only the untracked BE-3G-0 report — unchanged |
| Files staged / committed / pushed | **NONE** |

---

## 18.13 Corrected final status

```
CP-3G-7 live harness gate:        PASS  (was FAIL — 6/15; now 15/15 live + 50/50 seed-only)
CP-3G-7 automated verification:   PASS
CP-3G-7 overall:                  AWAITING USER GUI SMOKE
Phase 3G closure:                 BLOCKED ON E1–E13 AND ANY OPEN AUTOMATED DEFECT
Production activation:            NOT AUTHORIZED
```

### Open automated defect carried forward

**F1 — the packaged `app.asar` ships repository test, script and documentation trees.**
`electron-builder.yml`'s `files:` block is negations-only, so electron-builder's include-everything
default applies and `AGENTS.md`, `CLAUDE.md`, `CODEX.md`, `.ai/`, `.claude/`, `docs/`, `scripts/`
and `tests/` ship inside the archive. **This correction was not authorized to fix it, did not edit
`electron-builder.yml`, and did not enlarge it** — the packaged set is byte-identical to the
pre-correction baseline. F1 remains **OPEN — DEFERRED to Phase 6 packaging/release**.

No secret, token, credential or fixture is exposed by F1; the CP-3G-5 safety exclusions (seeder,
live wrapper, disposable database, private fixture, sandbox artefacts) all still hold.

### E1–E13

**Entirely unchecked.** `docs/audits/phase-3g-manual-gui-smoke-checklist.md` is unmodified by this
correction. Automated evidence does not satisfy a GUI observation, and no agent may mark one.

---

## 18.14 Corrected verification summary

```
Original 6/15 setup failures reproduced:   PASS   (R2: 1/6 with diagnostic; R4: 9/10 at 100 payloads)
Exact root cause established:              PASS
Speculative retry introduced:              NO
Production Electron code modified:         NO
Backend code modified:                     NO
Authorized seed-only reliability:          50/50
Complete live reliability:                 15/15
Live setup failures after correction:      0
Live product failures after correction:    0
Failure-ledger lines after correction:     0
Manual cleanup between runs:               NO
Unique database per run:                   PASS   (65 distinct run identities, zero repeats)
Unique port per run:                       PASS   (15/15 distinct)
Process cleanup:                           PASS
Port cleanup:                              PASS
Temporary-directory cleanup:               PASS
Token redaction:                           PASS
Harness safety/lifecycle gate:             PASS   (38/38; all 33 frozen cases unmodified)
SIGKILL crash gate:                        PASS   (six boundaries, both consecutive runs)
201/200 convergence:                       PASS
Exactly-once effects:                      PASS
Desktop full gate:                         PASS   (11/11 exit 0)
Backend SQLite gate:                       PASS   (691/686/5, 3,051 assertions)
Backend strict-MySQL gate:                 PASS   (691/686/5, 3,051 assertions, six strict modes)
Backend concurrency gate:                  PASS   (5/5, 56 assertions, 0 skipped)
F1 packaging finding:                      OPEN — DEFERRED
Manual GUI items passed:                   0/13 — USER ONLY
CP-3G-7 automated verification:            PASS
CP-3G-7 overall:                           AWAITING USER GUI SMOKE
Phase 3G closure:                          BLOCKED ON E1–E13 AND ANY OPEN AUTOMATED DEFECT
Allocation release enabled:                NO
Production activation authorized:          NO
Files staged/committed/pushed:             NO
```

### Evidence classification for this correction

| Class | Content |
|---|---|
| **Initially failed CP-3G-7 evidence** | §10 F2's 6/15 live failures and the invalid PASS in §16/§17 — retained, labelled superseded, never deleted |
| **Corrective evidence** | §18.4 reproduction ledger (R1–R4), §18.5 root cause, §18.6 the fix, §18.7 before/after |
| **Final executed evidence** | §18.8 acceptance (50/50, 15/15), §18.9 (38/38), §18.11 the full re-executed combined gate |
| **Carried-forward evidence** | CP-3G-5 (`73912b1`), CP-3G-6 (`9a1232b`) and BE-3G-0 conclusions, cited and not re-badged |
| **User-only GUI evidence** | E1–E13 — **0/13, unchecked** |

**No live per-test count is claimed.** The wrapper still captures the Electron suite's output as
part of its redaction boundary, so the live arm is evidenced by exit code plus the redaction-safe
evidence ledger — 20 records per run, zero failure lines — exactly as CP-3G-6 established.
