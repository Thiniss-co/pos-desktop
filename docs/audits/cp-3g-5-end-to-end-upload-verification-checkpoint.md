# CP-3G-5 — End-to-end upload verification (duplicate safety)

**Date:** 2026-09-03 · **Repository:** pos-desktop · **Phase:** 3G, checkpoint 5 of 7 · **Plan:**
`/var/www/html/thinis-pos/plans/POS_PHASE_3G_CONTROLLED_UPLOAD_PLAN.md` (revision 3) §9.1, §11 rows
7, 8, 17

## Scope

The phase's headline proof: a queued invoice uploads **exactly once**, a lost acknowledgment
converges on the server's duplicate answer instead of creating a second invoice, every guarded row
sends **zero** bytes, and no request ever leaves `/api/v1/desktop/*`.

Proven against a **real Laravel server** — backend HEAD `2bcce42`, running on a disposable SQLite
database — driven by the **real** `InvoiceUploadWorker`, the **real** `uploadInvoice` client, the
**real** `DesktopApiClient`, over **real Electron SQLite** with production migrations and production
repositories. The only instrumentation is a counting transport spy around `fetch`.

**Not here:** CP-3G-6 crash recovery, CP-3G-7 combined gate, BE-3F-4, allocation release, batch
upload, consumption acknowledgment, refunds, printing. No backend change, no migration, no
dependency, no new queue state, no new outcome policy, **no production code change of any kind**.

## Baseline

| Item | Value |
|---|---|
| Desktop HEAD (frozen CP-3G-4) | `400da5ffb2c0568573ebb1e03a4f2d8c0c6ff7ca`, worktree clean at start |
| Backend HEAD (read-only) | `2bcce42e9102d76eb57a24445791499989912a05` |
| Backend status digest | `0391b553c98196c7a92bb176c39accc626079f9d1428b6d0fe5f6f3966bbb13c` (only the untracked BE-3G-0 report) |
| Plan SHA-256 (revision 3) | `f99cd617b2cc29683c9251b83cba4ec391a5b7270255f31a7b39dfe24e1a0639` ✔ matches |
| BE-3G-0 report SHA-256 | `6c54a9c60bbf27937040627594edc2c911c1cf768efc785ff27c3879df1a2e42` ✔ matches |
| CP-3G-4 report SHA-256 | `4f7587d546b49e48f16e2aff31deb6b46a33a944ebb25e862fce01dd135dd241` ✔ matches |
| Baseline unit tests | 98 files / **867** (CP-3G-4) |
| Baseline real-SQLite tests | **188 pass / 0 fail** (CP-3G-4) |

All three prerequisite hashes were re-checked **after** the work: byte-identical. Backend HEAD and
status digest unchanged.

### Precondition gate step 5 — the live contract still matches BE-3G-0

Executed here, against the disposable server, before any desktop code was written:

| Probe | Result |
|---|---|
| Fresh upload | **HTTP 201**, `DESKTOP_INVOICE_UPLOADED` |
| Exact replay of the same body and key | **HTTP 200**, `DESKTOP_INVOICE_ALREADY_UPLOADED` |
| Replay identity | **same** invoice uuid, **same** server number |
| Rows after two requests | 1 invoice · 1 item · 1 payment · 1 sync · 1 movement · 1 consumption |
| Stock effect | `5.000 → 2.000`, applied **once** |
| Allocation consumed | `3000` milli, **once** |

BE-3G-0's frozen contract holds at the live endpoint. It was **not** re-proven or re-run as a
backend suite; this is a compatibility probe by the consumer.

## Changed files

Tests, test support and this report only. **No production file was modified.**

| File | Change |
|---|---|
| `tests/electron/suites/invoiceUploadDuplicateSafety.suite.ts` | **New, 1178 lines.** The 29-case CP-3G-5 suite |
| `tests/electron/support/uploadTransportSpy.ts` | **New.** Counting `fetch` spy with lost-ack / transport-failure / replace-body modes |
| `tests/electron/support/liveUploadBackend.ts` | **New.** Live fixture reader + read-only backend row/attribution/audit snapshot |
| `tests/electron/support/cp3g5/seedLiveBackend.php` | **New.** Disposable-backend fixture seeder (runs *from* pos-desktop, writes nothing into pos-backend) |
| `scripts/cp3g5LiveUpload.mjs` | **New.** Orchestrator: disposable DB → migrate → seed → serve → suite → verified teardown |
| `src/main/sync/invoiceUploadDispatchCardinality.test.ts` | **New.** Vitest arm using the **real** `CommercialAccessPublisher` |
| `tests/electron/support/sandbox.ts` | `databaseTest` gained an optional `{ skip }`, so a skip reports as a skip |
| `tests/electron/index.ts` | Registers the new suite |
| `src/main/testing/electronHarnessIntegrity.test.ts` | `liveUploadBackend.ts` added to the `new Database(` allowlist |

### Why the two harness edits were needed, and why they do not weaken a guard

`electronHarnessIntegrity.test.ts` caught both of them, which is the guard working:

1. Every `.suite.ts` must call `databaseTest(`. CP-3G-5 needs to **skip** when no live backend is
   present, so `databaseTest` gained an optional `skip`. The suite still goes through the sanctioned
   sandbox helper, and a skipped case is reported as **skipped**, never as a silent pass.
2. `new Database(` is restricted to sanctioned support modules. `liveUploadBackend.ts` was added
   because it opens the **disposable backend** database **read-only** to count real server rows
   mid-test. It never opens the desktop database, and the desktop side never writes to the server's.

## The environment — isolation and disposal

- The backend runs with `DB_CONNECTION=sqlite` and `DB_DATABASE` pointing inside a freshly created
  `mkdtemp` directory named `pos-desktop-cp3g5-*`. Laravel's immutable dotenv leaves those process
  variables in place, so `.env` is read but cannot override them.
- **No MySQL database was created, used, dropped or named.** The concurrency arm is BE-3G-0's and
  was not re-run. `INFORMATION_SCHEMA.SCHEMATA` after the work lists only the pre-existing
  development schema `thinis_pos` and other schemas predating this checkpoint — none of them named
  for CP-3G-5, none created, altered or dropped here, and none contacted by any test.
- Teardown refuses to remove anything whose parent is not the system temp directory or whose name
  lacks the `pos-desktop-cp3g5-` prefix, then re-checks with `existsSync` and fails loudly if the
  directory survives. Every run printed **"disposable database removed and verified absent"**.
- No leftover `pos-desktop-cp3g5-*` or `pos-desktop-itest-*` directory and no `php artisan serve`
  process remained after the final run.
- The desktop database is a `pos-desktop-itest-*` sandbox per case, on-disk (never `:memory:`), with
  production migrations, asserted inside the sandbox root, and leak-checked on dispose.

Each minted fixture gets its **own** product, stock item and allocation grant. The backend requires a
gap-free consumption sequence per grant, so a shared grant would have coupled every scenario to every
other scenario's outcome; one grant per payload makes each case independent.

## CP-3G-5A — normal synchronization

One committed local invoice, one queue row, one tracked line with allocation proof, dispatched
through the production worker.

| Proof | Result |
|---|---|
| Outbound requests | **1** |
| Method / path | `POST` `/api/v1/desktop/invoices/upload` |
| `Authorization` + `X-Device-UUID` present | yes |
| Request body vs frozen payload | **deep-equal**, and `idempotency_key === local_invoice_uuid` |
| Backend invoices created | **1** (items 1, payments 1, syncs 1, movements 1, consumptions 1) |
| Local invoice rows / queue rows | **1 / 1** |
| Queue state | `pending → uploading → synced`, lease cleared, `attempt_count = 1` |
| Invoice state | `synced` with `remote_uuid`, `server_number`, `synced_at` all written in one UPDATE |
| Remote identity | equals the identity the server actually holds |
| Conflict rows | **0** |
| Attribution | `shift_id`, `cashier_user_id`, `branch_id`, `warehouse_id` all derived from the **immutable shift** |
| Uploader audit (BE-3F-3) | one `desktop_invoice_syncs` row: same idempotency key, `origin_shift_id` and `uploader_user_id` from the shift, `client_contract_version = 2`, `legacy_path_used = 0` |
| Re-drain after success | **0** further requests, backend invoice count unchanged |

## CP-3G-5B — lost acknowledgment

The spy forwards the request to Laravel, lets it **really commit**, drains the real response, and
only then throws a transport error at the worker. Server truth and worker observation genuinely
disagree.

**Attempt 1 — the server commits, the answer is lost**

| Proof | Result |
|---|---|
| Outbound requests | **1** |
| Backend invoices / movements / consumptions created | **1 / 1 / 1** |
| Queue state observed by the worker | `retryable_error` — **not** `synced`, `conflict` or `rejected` |
| Lease | cleared — no orphaned `uploading` row |
| Invoice `remote_uuid` / `synced_at` | `null` / `null` — the desktop learned nothing |
| Conflict rows | **0** |

**Attempt 2 — the retry**

| Proof | Result |
|---|---|
| Outbound requests (cumulative) | **2** — exactly one per attempt |
| Idempotency key | **identical** to attempt 1, and equal to the local invoice uuid |
| Local invoice uuid / shift uuid / allocation proof | **identical** |
| Whole body | **deep-equal** to attempt 1 and to the committed payload |
| `payloadHash(body)` | **identical** — nothing regenerated |
| Backend invoices / items / payments / movements / consumptions | **1 / 1 / 1 / 1 / 1** — unchanged |
| Allocation consumed, stock quantity | unchanged from attempt 1 |
| Uploader audit rows for this invoice | **1** |
| Final queue state | `synced`, `attempt_count = 2`, lease cleared |
| Final `remote_uuid` / `server_number` | **the identity attempt 1 created** |
| Local invoice rows / queue rows / conflict rows | **1 / 1 / 0** |

Two dispatch attempts, one logical upload, one invoice.

## CP-3G-5C — a duplicate answer as first observable success

The invoice is committed server-side out of band, then a fresh local queue row is drained, so the
**only** answer this process ever sees is the 200 duplicate.

| Proof | Result |
|---|---|
| Outbound requests | **1** |
| Worker summary | `duplicates = 1`, `uploaded = 0`, `failed = 0`, `pausedReason = null` |
| Backend invoices / movements / consumptions created | **0 / 0 / 0** |
| Queue state | `synced`, `last_error_code = null` |
| Invoice | `synced` with remote uuid and server number written |
| Conflict rows / queue rows | **0 / 1** |

Treated identically to a 201. Never an error, never a conflict, never a second invoice. The full
`DesktopInvoiceResource` schema is validated before any SQLite write.

## CP-3G-5D — dispatch cardinality and single-flight

| Scenario | Triggers | Claims | Outbound | Queue transition | Backend invoices |
|---|---|---|---|---|---|
| Trigger storm (run + 3 access publications + 2 upload-now) | 6 | 1 | **1** | `pending → synced` | +1 |
| Post-success storm (2 publications + upload-now + 2 drains) | 5 | 0 | **0** | stays `synced` | +0 |
| Restart with a pending row (second worker, same database) | 2 | 1 | **1** | `pending → synced` | +1 |
| Two concurrent drains racing one row | 2 | 1 | **1** | `pending → synced` | +1 |

The trigger path is the production `subscribeInvoiceUploadTriggers()`, not a direct
`worker.requestRun()`. `attempt_count` stayed `1` in every coalescing case, so the coalescing is
real rather than a claim that silently failed.

**The real publisher arm.** `CommercialAccessPublisher.publish()` reaches `BrowserWindow`, which does
not exist under `ELECTRON_RUN_AS_NODE`, so it cannot run in the Electron harness. It is covered in
`src/main/sync/invoiceUploadDispatchCardinality.test.ts` (Vitest, 3 cases) with the **real**
publisher, the **real** trigger wiring, the **real** worker, the **real** upload client and the
**real** `DesktopApiClient`: six real `publishCurrent()` publications across an in-flight drain
produce **exactly one** `POST /api/v1/desktop/invoices/upload`; a queue with no claimable row
produces **zero**; and after disposal the publisher drives nothing.

## One-request-per-attempt ledger

Measured at the transport boundary (`CP3G5_LEDGER=1`), all 29 live cases:

```
requests  upload-route  scenario
1         1             5A normal synchronization
2         2             5B lost acknowledgment (1 per attempt, 2 attempts)
1         1             5C duplicate as first observable success
1         1             5D trigger storm
1         1             5D restart with a pending row
1         1             5D two concurrent drains
0         0             5E × 13 zero-send guards
1         1             5F malformed success × 4
1         1             5F transport failure
2         2             5F 5xx and unknown code (1 each)
1         1             5F authorization denial
1         1             5F real 422 catalog revision
1         1             5F real 422 allocation proof
1         1             5F real 409 idempotency conflict
--------------------------------------------------
18        18            total
```

**18 outbound requests across 18 dispatch attempts — exactly one per attempt.** All 18 were
`POST /api/v1/desktop/invoices/upload`; **zero** requests went anywhere else.

CP-3G-5C and the 5F 409 case each additionally make one deliberate out-of-band priming `fetch`
directly in the test, to commit an invoice as a previous process would have. Those are test setup and
are not worker dispatches; they are excluded from the ledger above and are not routed through the
spy.

## Outbound namespace proof

Every recorded request is asserted to start with `/api/v1/desktop/`, and never to touch
`/api/v1/admin`, `/api/v1/auth`, a traversal segment, or anything matching `batch`. Every request
whose path mentions an invoice must be exactly `POST /api/v1/desktop/invoices/upload`.

Separately, the production `DesktopApiClient` was asked for six forbidden paths — `/api/v1/admin/…`,
`/api/v1/auth/login`, `/../../etc/passwd`, a protocol-relative host, an absolute foreign origin, and
a traversal that climbs out of the upload route. **All six were refused, and the transport observed
zero requests.**

Queue claims, retry release, status reads, failure-list reads and outcome recording produced no HTTP
traffic — the zero-send cases exercise all of them and record 0.

## Zero-send matrix

Each case runs in its own sandbox database with its own committed sale. `Δ` is measured against a
full backend snapshot taken before the drain.

| Guard | Outbound | Backend Δ | Queue state before → after | Local rows |
|---|---|---|---|---|
| Payload hash no longer matches | **0** | none | `pending → retryable_error` (held, not rejected) | preserved |
| Stored payload is not valid JSON | **0** | none | `pending → retryable_error` | preserved |
| Terminal `synced` row | **0** | none | `synced → synced` | preserved |
| Terminal `rejected` row | **0** | none | `rejected → rejected` | preserved |
| Terminal `conflict` row | **0** | none | `conflict → conflict` | preserved |
| Row owned by another company | **0** | none | `pending → pending` | preserved |
| Row owned by another device | **0** | none | `pending → pending` | preserved |
| Cleared / unauthenticated session | **0** | none | `pending → pending` | preserved |
| Session with no device identity | **0** | none | `pending → pending` | preserved |
| Missing `pos.invoice.upload` | **0** | none | `pending → pending` | preserved |
| Commercial access denies `canSync` | **0** | none | `pending → pending` | preserved |
| Offline connectivity precondition | **0** | none | `pending → pending` | preserved |
| Forbidden endpoint namespaces (6 shapes) | **0** | none | n/a | n/a |

In every row: backend counts deep-equal before and after, exactly one local invoice and one queue
row exist, and **no second queue row was ever created**. A hash mismatch is *held* and preserved for
evidence, never terminally rejected — repair remains a separately authorized workflow.

## CP-3G-5F — response and error safety

| Case | Source | Outbound | Queue result | Invoice result |
|---|---|---|---|---|
| Success envelope that is not an envelope | injected 200 | 1 | `retryable_error` | no remote identity |
| Unrecognized success `code` | injected 200 | 1 | `retryable_error` | no remote identity |
| Success body with **no** invoice id | injected 201 | 1 | `retryable_error` | no remote identity |
| Success body with wrong-typed identity fields | injected 201 | 1 | `retryable_error` | no remote identity |
| Transport failure | injected | 1 | `retryable_error` + backoff scheduled | payload, hash and key **byte-identical** |
| 503 `SERVICE_UNAVAILABLE` | injected | 1 | `retryable_error` | no remote identity |
| Unknown backend code (`DESKTOP_SOMETHING_THE_DESKTOP_HAS_NEVER_SEEN`) | injected 418 | 1 | `retryable_error` — **never** terminal | no remote identity |
| 403 `FORBIDDEN` | injected | 1 | **not** `rejected`/`conflict`/`synced`; worker **paused** | untouched |
| 422 `DESKTOP_CATALOG_REVISION_INVALID` | **real Laravel** | 1 | `rejected` (terminal) | sale preserved, `remote_uuid` null |
| 422 allocation proof missing on a tracked line | **real Laravel** | 1 | `rejected` (terminal) | sale preserved |
| 409 `IDEMPOTENCY_CONFLICT` (same key, drifted payload) | **real Laravel** | 1 | `conflict` (terminal), 1 `sync_conflicts` row | sale preserved, `remote_uuid` null |

Every malformed 2xx asserts `queue.state !== 'synced'` explicitly: a 2xx the desktop cannot read is
never success, because the server may well hold the invoice — the row stays retryable so the next
attempt replays the same key and converges on the duplicate answer.

For both real 422s the backend snapshot is **deep-equal** before and after: Laravel really answered
and created nothing. For the real 409, backend invoice count delta is **0** — no second invoice, and
both sides are preserved for a human. In all three terminal cases a further drain produced **0**
additional requests, and the local sale, its items and its payments are untouched (PD-3G-1).

## Real-SQLite row-count proof

Asserted in every live case, on the production schema through the production repositories:

- `local_invoices` count · `sync_queue` count · `sync_conflicts` count
- queue `state`, `attempt_count`, `upload_lease_at`, `last_error_code`, `next_attempt_at`
- invoice `sync_status`, `remote_uuid`, `server_number`, `synced_at`, `sync_attempts`
- server-side `pos_invoices`, `pos_invoice_items`, `pos_payments`, `desktop_invoice_syncs`,
  `stock_movements`, `stock_allocation_consumptions`, `shift_post_close_adjustments`, stock quantity,
  allocation consumed milli, invoice attribution and uploader audit

No case ends in a partial-success state: migration `0007`'s CHECK constraints make `sync_status`,
`synced_at` and `remote_uuid` move in a single UPDATE, and the outcome recorder writes the queue row
and the invoice row in one transaction. The seeder tripped one of those CHECKs during development
(`sold_while_offline = 1` with `connectivity_state_at_sale = 'online'`), which is the constraint
doing its job on test data, not a production finding.

## Production changes

**None.** No file under `src/main` outside `*.test.ts` was modified. No production defect was found:
every CP-3G-5 assertion passed against unmodified CP-3G-4 code. Two test-side corrections were made
during development and are recorded rather than hidden — an incorrect expectation that a retryable
outcome leaves `local_invoices.sync_status` at `pending` (production correctly mirrors the queue
state, `retryable_error`), and a fixture that shared one allocation grant across scenarios and so
violated the backend's gap-free consumption-sequence rule.

## Verification ledger — all executed in this session

| Command | Result |
|---|---|
| `npm run typecheck` | **PASS**, exit 0 (node + web) |
| `npm run lint` | **PASS** — 0 errors, 0 warnings |
| `npm run test` | **PASS — 99 files / 870 tests** (was 98 / 867; **+3**) |
| `npm run verify:fixture` | **PASS** — 5 fixtures byte-identical |
| `npm run smoke:database` | **PASS** |
| `npm run test:sqlite:electron` (hermetic, no backend) | **PASS — 188 pass / 0 fail / 29 skipped** |
| `node scripts/cp3g5LiveUpload.mjs` (live Laravel) | **PASS — 217 pass / 0 fail / 0 skipped** |
| `npm run build` | **PASS**, exit 0 |
| `git diff --check` (pos-desktop) | **PASS**, exit 0 |
| `git diff --check` (pos-backend) | **PASS**, exit 0 |

Backend read-only compatibility probes executed here: fresh 201, exact-replay 200 with identical
identity, and post-replay row counts (table above). **No backend test suite was run or modified**;
BE-3G-0 remains the backend evidence of record.

The hermetic and live numbers are both reported deliberately: `188 / 29 skipped` is what
`npm run test:sqlite:electron` gives anyone without a backend — the CP-3G-4 baseline exactly, with
the CP-3G-5 cases honestly reported as skipped — and `217 / 0 skipped` is the same suite with the
live server attached. **29** new real-SQLite cases, plus **3** new Vitest cases.

## Out-of-scope confirmation

Not implemented: CP-3G-6 (`SIGKILL`/fresh-process recovery), CP-3G-7, BE-3F-4, marking movements
synced, allocation-consumption acknowledgment, allocation seal/acknowledge/release, forced or
timeout release, automatic reallocation, refund upload, batch upload, corrective/void sales, receipt
printing, automatic conflict resolution, production activation.

Verified by command: backend HEAD `2bcce42` with an unchanged status digest and a byte-identical
BE-3G-0 report; the plan is byte-identical; the CP-3G-4 report is byte-identical; **no** migration;
**no** dependency or lock-file change; `syncQueueStates.ts` untouched; no production `src/main` file
changed. Nothing staged, committed or pushed. `local_stock_movements` and allocation consumptions
remain `pending` locally, by design.

## Remaining Phase 3G work

- **CP-3G-6 — crash recovery. NOT AUTHORIZED.** `SIGKILL` mid-flight, restart, expired lease
  reclaimed `uploading → retryable_error → pending`, same key re-sent, converge on the 200 duplicate,
  no orphaned `uploading` row. `tests/electron/support/freshProcess.ts` and `recoveryWorker.ts` were
  read for architectural context only and are untouched; the live harness added here is directly
  reusable for it.
- **CP-3G-7 — combined verification + smoke. NOT AUTHORIZED.** Both repositories' gates in one
  session, plus the 3G manual GUI smoke.
- **Manual GUI smoke: NOT RUN.** Plan §12 items **E1–E13** remain user-owned. CP-3G-5 proves E2, E3,
  E4's convergence property and E13's namespace restriction *at the transport and database level* —
  that is explicitly **not** the same fact as the on-screen item, and no agent may mark one passed.

## Reproducing this checkpoint

```bash
node scripts/cp3g5LiveUpload.mjs          # disposable DB → migrate → seed → serve → suite → teardown
CP3G5_LEDGER=1 node scripts/cp3g5LiveUpload.mjs   # with the per-scenario request ledger
node scripts/cp3g5LiveUpload.mjs --keep   # retain the sandbox for inspection
```

Requires `php` and the pos-backend vendor directory. Without them, and without the `CP3G5_*`
environment variables, `npm run test:sqlite:electron` skips the 29 cases and stays hermetic.

No token, credential, full payment reference or customer-identifying value appears in this report or
in any test failure output; the transport spy records header **presence**, never header values.

---

## Append-only harness-safety correction — 2026-09-03

After the evidence above was recorded, the PHP fixture seeder was invoked directly, outside the
Node parent. That direct invocation exposed a missing internal fail-closed guard: the seeder
bootstrapped Laravel, wrote test fixtures into the backend's configured development database, and
printed a real Sanctum token. The user separately revoked the exposed token. Its value is not
recorded here, in source, or in a fixture.

This correction does **not** claim that the accidentally created company or any dependent database
record was removed. Database cleanup was not authorized, executed, or verified as part of this
work. The original end-to-end duplicate-safety results remain evidence about upload correctness;
they are distinct from this test-harness safety defect and do not erase it.

The seeder now requires a per-run authorization marker, canonical `mkdtemp` root, cryptographically
random nonce, owner-only marker file, exact on-disk SQLite filename, and owner-only private response
file before Laravel can load. After Laravel loads, it independently verifies the testing
environment, SQLite driver, default connection, configured database and active database against the
same approved canonical file before the first fixture write. The parent captures child output,
does not forward failure output, and removes and verifies the exact generated temporary directory on
success, failure and handled signals. Direct invocation has no authorized defaults.

Executable regressions cover the original command, missing or invalid authorization state, MySQL
and backend-default selection, relative/outside/in-memory/wrong-name SQLite paths, missing or wrong
nonce and marker state, symlinks, lexical traversal, Laravel `DB_URL` connection replacement,
zero-write rejection, token/stack-trace redaction, and wrapper failure cleanup. Electron-builder
also carries explicit exclusions, with the final `app.asar` and unpacked artifact inspected by the
package-boundary verifier.

**Freeze correction:** CP-3G-5 must not be treated as frozen until this corrective gate and its full
verification matrix pass. CP-3G-6 remains **NOT AUTHORIZED**.

### Corrective gate result

The correction passed on 2026-09-03: **15 / 15** dedicated harness-safety regressions, **217 / 217**
authorized live Electron/SQLite/Laravel cases, verified removal on success and forced failure, and
inspection of **123** files plus the final `app.asar` with no forbidden harness asset present.
CP-3G-5 is ready to freeze on the corrected evidence. This result does not authorize CP-3G-6.

The earlier `--keep` reproduction line above is superseded by this correction. The wrapper now
rejects that option before creating a sandbox because retaining a directory containing temporary
credentials is incompatible with the corrective cleanup gate.
