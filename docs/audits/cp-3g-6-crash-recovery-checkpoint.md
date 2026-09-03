# CP-3G-6 — Crash recovery (real process death, expired lease, identical replay)

**Date:** 2026-09-03 · **Repository:** pos-desktop · **Phase:** 3G, checkpoint 6 of 7 · **Plan:**
`/var/www/html/thinis-pos/plans/POS_PHASE_3G_CONTROLLED_UPLOAD_PLAN.md` (**revision 4**) §4.3, §9.1,
§9.4, §11 rows 8 and 13

## Scope

The proof that a real process crash during an invoice upload cannot orphan a queue row, cannot lose
the committed local sale, cannot alter the frozen payload or its idempotency identity, cannot create
a second Laravel invoice, cannot consume allocation or stock twice, and cannot let a timeout or an
expired lease be mistaken for success.

The required production path is proven end to end and nothing else was allowed:

```
uploading → retryable_error (upload_lease_expired) → pending → uploading → synced
```

A direct `uploading → pending` never occurred and remains forbidden by the frozen state machine.

**Verification-led.** The checkpoint body below was written against unmodified CP-3G-5 production
code. It then **discovered one production defect** — expired-lease reclamation was not owner-scoped
— which was corrected under separate authorization and is recorded in full in
**[the appended correction](#appended-correction--owner-scoped-lease-reclamation-2026-09-03)**. Two
production files changed, both listed there; nothing else in `src/main` outside `*.test.ts` was
touched. **Not here:** CP-3G-7, BE-3F-4, allocation release, movement/consumption acknowledgment,
batch upload, conflict repair, voids, compensating sales, production activation, and every manual
GUI item.

> **Reading order.** Everything from here to "Result" is the original checkpoint, retained
> unaltered except where a statement it made is now factually wrong; those places say so and point
> forward. The appended correction is authoritative wherever the two differ.

## Baseline (verified before any edit, and re-verified after)

| Check | Result |
|---|---|
| Desktop HEAD (frozen CP-3G-5) | `73912b1dbe22a9141b5d963e5e74829adca5fd72` — **exact match** |
| Desktop worktree before the work | **clean** (`git status --porcelain` empty) |
| Plan SHA-256 (revision 4) | `eec49ab74d1b515eda65c6bb317733763378cfbb7b840a919c9689055958045d` ✔ |
| CP-3G-5 report SHA-256 | `89b3a53ce54fa14c156ecadbfd2a916132df64beca97f5d1a22c6ae4619f8b75` ✔ |
| Backend HEAD (read-only) | `2bcce42e9102d76eb57a24445791499989912a05` — unchanged |
| Backend status | only the untracked `docs/audits/be-3g-0-controlled-upload-readiness.md`, exactly as CP-3G-5 recorded |
| Backend `git diff --check` | exit 0, before and after |
| Exposed CP-3G-5 token | **absent** — a sweep of `tests/`, `scripts/`, `src/` and the CP-3G-5 report for `sanctum` / `plainTextToken` / `Bearer <value>` / 40-char token shapes returns only redaction guards, the seeder's own `$createdToken->plainTextToken` variable, and unrelated placeholder strings in `apiError`/`apiTrace`/`companyUsers` tests. No token value is recorded in source, fixture, report or evidence |

Both hashes were recomputed **after** the work and are byte-identical. CP-3G-5 remains isolated in
its own commit; nothing in this checkpoint edits it.

### Harness safety, re-verified before use (precondition gate step 6)

`npm run test:cp3g5-harness` → **15 / 15 pass, 0 fail, 0 skipped**, executed in this session against
the unmodified seeder and wrapper. The four properties the gate demands were re-proven by that run,
not assumed: direct PHP execution is rejected before Laravel bootstrap (`CP-3G-5 seeder rejected:
authorization marker missing`, exit 1, zero writes); only the nonce-bound, owner-only, canonical
`pos-desktop-cp3g5-*` disposable SQLite path is accepted; the wrapper removes and re-verifies its
exact temporary directory on failure; and no token, stack trace or sentinel appears in wrapper
output.

**Nothing in the CP-3G-5 safety boundary was weakened, and the PHP seeder
(`tests/electron/support/cp3g5/seedLiveBackend.php`) was not modified.** The seeder remains
impossible to invoke directly.

> **Superseded in part.** This paragraph also said the wrapper `scripts/cp3g5LiveUpload.mjs` was not
> modified. That was true of the original checkpoint and of the owner-scoping correction. It is
> **no longer true**: the second appended correction rewrites the wrapper's process lifecycle. Every
> safety property listed above still holds and is re-proven there, and the count is now **33 / 33**
> — the original 15 safety regressions plus 18 new lifecycle regressions.

**The accidental development fixtures were not touched, inspected or cleaned**, per the standing
instruction; they remain a separate maintenance item.

## Changed-file ledger

Tests, narrow test support, one suite registration, and this report — **plus the two production
files the appended correction changed**, listed first.

| File | Change |
|---|---|
| `src/main/repositories/syncQueue.repository.ts` | **Production. Modified by the correction.** `reclaimExpiredUploadLeases` and `releaseDueRetries` take the authoritative owner and carry the company/device predicate inside their `UPDATE` statements |
| `src/main/sync/invoiceUploadWorker.ts` | **Production. Modified by the correction.** Startup reconciliation resolves the owner from main-owned session metadata first and does nothing when there is none; `currentUploadOwner()` extracted and reused by the dispatch gate |
| `tests/electron/support/freshProcess.ts` | **Modified, +163 / -2 lines.** Adds `startFreshProcess()` — an asynchronous launcher that returns the live child so the *test* can deliver `SIGKILL` — plus `realElectronBinary()` and a shared `bundleWorker()`. `runFreshProcess()` is unchanged in behaviour |
| `tests/electron/support/liveUploadBackend.ts` | **Modified, +108 lines, purely additive.** `readScenarioEffects()` counts one scenario's server effects by its own offline number, allocation grant and local invoice uuid. Read-only, same connection discipline as `readBackendSnapshot()` |
| `tests/electron/support/uploadCrash.ts` | **New, 359 lines.** Shared crash support: the seed shape, the production worker builder, the coordination-marker contract, the park primitives, the row readers and the evidence writer |
| `tests/electron/support/uploadCrashWorker.ts` | **New, 276 lines.** The fresh-process upload worker: `crash` (five stages), `drain`, `reclaim-only`, `inspect` |
| `tests/electron/suites/invoiceUploadCrashRecovery.suite.ts` | **New, 1,745 lines.** The **20-case** CP-3G-6 suite (15 hermetic, 5 live). *Line and case counts corrected in the third appended correction; the pre-correction figures were 1,223 and 13* |
| `tests/electron/index.ts` | Registers the new suite (one line) |
| `tests/electron/suites/invoiceUploadQueue.suite.ts` | **Modified by the correction.** CP-3G-2's existing cases pass the owner tuple to the two reconciliation calls; no assertion or expectation changed |
| `src/main/sync/invoiceUploadCrashRecovery.test.ts` | **New, 278 lines.** **Nine** Vitest cases pinning the frozen transition table, the lease predicate, the drain ordering and the production startup call, plus timer/subscription disposal |
| `scripts/cp3g5LiveUpload.mjs` | **Modified by the second correction.** Owned process groups, per-run loopback port, ordered and verified cleanup, suite timeout, and exported primitives for the lifecycle regressions |
| `tests/cp3g5HarnessLifecycle.test.mjs` | **New, 530 lines, 18 cases.** The process-lifecycle and port-isolation regressions |
| `package.json` | `test:cp3g5-harness` now runs the safety **and** lifecycle regression files, serialized with `--test-concurrency=1`. Scripts only — no dependency, no lock-file change |
| `docs/audits/cp-3g-6-crash-recovery-checkpoint.md` | This report |

Confirmed by command: the only `src/` changes are the two production files above and `*.test.ts`
files; the only `package.json` change is one `scripts` line; no change to `package-lock.json`,
`electron-builder.yml`, `src/main/database/migrations` or
`src/shared/constants/syncQueueStates.ts`. **No migration. No dependency. No backend file.**

### One deliberate, documented deviation from the plan's shorthand

Revision 4 §9.4 says to reuse `tests/electron/support/recoveryWorker.ts` and
`tests/electron/support/freshProcess.ts`. `freshProcess.ts` **is** the launcher used here, extended.
`recoveryWorker.ts` was **not modified**: it rebuilds Phase 3F's sale-completion fixture at module
load, which would run on every CP-3G-6 command and has nothing to do with an invoice upload. The
CP-3G-6 child is therefore a sibling, `uploadCrashWorker.ts`, following the identical contract — a
standalone Electron process that holds nothing from its parent and rebuilds everything it acts on
from the sandbox database on disk. Phase 3F's crash evidence is left byte-identical.

## How the crash is made real

Every crash in this checkpoint is a **`SIGKILL` delivered by the test to a different process**:

1. The suite seeds one committed sale and its single immutable `sync_queue` row.
2. `startFreshProcess()` spawns the **real** Electron binary — `node_modules/electron/dist/electron`,
   resolved through `path.txt`, deliberately **not** `node_modules/.bin/electron`. That bin is a Node
   wrapper which spawns the real binary as its own child and forwards only `SIGINT`/`SIGTERM`, so a
   `SIGKILL` aimed at it would kill the wrapper and orphan the process holding the SQLite handle.
3. The child runs the **production** `InvoiceUploadWorker` over **production** repositories on a
   **file-backed** sandbox database with **production** migrations, and the **production**
   `DesktopApiClient` / `uploadInvoice` against the **real** disposable Laravel endpoint. Only the
   clock (through the worker's own `now` injection) and the counting transport are instrumented.
4. At the requested boundary the child publishes an atomic coordination file and **parks**.
5. The parent verifies the outside world — including reading the server's own database — and only
   then calls `child.kill('SIGKILL')`.
6. The exit is asserted: `signal === 'SIGKILL'`, and the killed worker produced **no** result line.
   Nothing catches the signal, nothing unwinds, no `finally` runs, no cleanup executes.
7. The aftermath is read back by **further separate processes** that were not alive when the worker
   died and that open the database file themselves.

**No same-process thrown exception is used as a crash proof anywhere in this checkpoint.**

The coordination file carries states, counts, hashes, request paths and business identifiers only —
never a token, a header value or a payment reference — and lives inside the per-case
`pos-desktop-itest-*` sandbox, which is removed on dispose.

## SIGKILL boundaries covered

| # | Boundary | Stage | Arm | Pre-crash queue state | Laravel committed before the kill | State found by a fresh process | Requests before crash |
|---|---|---|---|---|---|---|---|
| 1 | Claim committed, nothing dispatched | `before-dispatch` | hermetic | `uploading` (lease set) | n/a | `uploading` | **0** |
| 2 | Claim committed, nothing dispatched | `before-dispatch` | **live** | `uploading` | **no** (0 server invoices, verified) | `uploading` | **0** |
| 3 | Request handed to the transport, no answer observed | `in-flight` | **live** | `uploading` | **no** (measured at the kill) | `uploading` | **1** |
| 4 | Server's response bytes at the transport, nothing parsed | `response-received` | **live** | `uploading` | **yes** (verified from the server's database while parked) | `uploading` | **1** |
| 5 | Answer parsed and accepted, outcome transaction not started | `before-outcome` | **live** | `uploading` | **yes** | `uploading` | **1** |
| 6 | Inside the outcome transaction, after the queue row was written | `during-outcome` | **live** | `synced` *as seen from inside the still-open transaction* | **yes** | **`uploading`** — the transaction never committed | **1** |

Boundary 6 is the atomicity proof: the child published a marker showing the queue row already
carrying `state = 'synced'` inside its own open transaction, was killed there, and a reopened
database shows `uploading` with its lease intact, `remote_uuid` null and `synced_at` null. No
half-applied success survived.

## CP-3G-6A — crash after the server commits, before the local acknowledgment

Live, payload 16. The child dispatched, Laravel committed, and the child was killed holding the
response bytes.

**Test-side confirmation of the backend commit was obtained *before* the kill**, by reading the
disposable server's own database while the worker was still parked: 1 invoice, 1 item, 1 payment,
1 uploader audit, 1 stock movement, 1 allocation consumption, `consumed_quantity_milli = 1000`.

Immediately after the `SIGKILL`, read back by a process that was never alive during the crash:

| Assertion | Result |
|---|---|
| Local invoice exists exactly once | **PASS** — `local_invoices = 1` |
| Queue row exists exactly once | **PASS** — `sync_queue = 1` |
| Queue state | **`uploading`** |
| `upload_lease_at` | present (`2026-09-03T00:57:16.284Z`) |
| `remote_uuid` | **null** |
| `synced_at` | **null** |
| Frozen `payload_json` | **byte-identical** to the committed payload |
| `payload_hash` | **valid and unchanged** |
| `idempotency_key` | **unchanged**, and still equal to the local invoice uuid |
| `attempt_count` | 1 — the crash is not a second attempt |
| Laravel invoices for this payload | **1**, with its single set of effects unchanged by the crash |
| Any local business record lost or reconstructed | **none** |

## CP-3G-6B — the lease boundary, on the production policy

The frozen duration is `UPLOAD_LEASE_DURATION_MS = 60_000`
(`src/main/sync/invoiceUploadWorker.ts`), and the predicate is the production
`isUploadLeaseExpired`. No sleeps were added and no production timing was weakened: only the
worker's own `now` injection point moves.

| Boundary | Behaviour | Result |
|---|---|---|
| lease + 59 999 ms | `isUploadLeaseExpired` | **false** |
| lease + 60 000 ms (exact) | `isUploadLeaseExpired` | **true** (`>=`, as the contract states) |
| lease + 60 001 ms | `isUploadLeaseExpired` | **true** |
| lease is `null` or unparseable | `isUploadLeaseExpired` | **true** — fail-closed |
| Startup drain at lease + 30 000 ms (fresh process) | no reclaim, state stays `uploading` | **0 requests** |
| Production `reclaimExpiredUploadLeases` at lease + 59 999 ms | returns `[]`, state stays `uploading` | **0 requests** |
| Production reclaim at the boundary (fresh process) | `uploading → retryable_error`, `last_error_code = upload_lease_expired`, lease cleared, `attempt_count` still **1** | **0 requests** |
| `releaseDueRetries` one millisecond before `next_attempt_at` | returns `[]`, state stays `retryable_error` | **0 requests** |
| `releaseDueRetries` at `next_attempt_at` | `retryable_error → pending` | **0 requests** |
| Worker claim and dispatch after release | `pending → uploading`, `attempt_count` 1 → **2** | **exactly 1** request, `POST /api/v1/desktop/invoices/upload` |

Reclaim writes `next_attempt_at` equal to the reclaim instant itself — due immediately, but reachable
only through `pending`. `SYNC_QUEUE_TRANSITIONS.uploading` is exactly
`['synced','retryable_error','conflict','rejected']`, `retryable_error → ['pending']`, and
`isSyncQueueTransitionAllowed('uploading','pending')` is **false**.

**Direct `uploading → pending` observed: NO.**

## CP-3G-6C — identical replay and convergence

The retry after the server-committed crash was dispatched by a **different process** from the one
that crashed, and its request was compared against the pre-crash request recorded by the killed
process.

| Identity | Result |
|---|---|
| Local invoice UUID | **identical** |
| Idempotency key | **identical**, and equal to the local invoice uuid |
| Stored `payload_json` | **byte-identical** before and after the crash |
| `payload_hash` | **identical** |
| SHA-256 of the transmitted request body | **identical** across the two processes |
| Semantic request body | **deep-equal** to the identity derived from the committed payload |
| Originating shift UUID | **identical** |
| Catalog revision | **identical** |
| Allocation UUID, rights generation, consumption sequence, local consumption UUID | **identical** |

Laravel converged through **200 `DESKTOP_INVOICE_ALREADY_UPLOADED`** (worker summary
`duplicates = 1`, `uploaded = 0`, `failed = 0`, `pausedReason = null`).

| After convergence | Result |
|---|---|
| Original local queue row | **`synced`, exactly once**, `attempt_count = 2`, lease cleared, `last_error_code` null |
| `remote_uuid` | equals the invoice created **before** the `SIGKILL` |
| `server_number` | equals the original |
| Backend invoices / items / payments | **1 / 1 / 1** |
| Uploader audit rows for this invoice | **1** |
| Allocation consumptions | **1**, `consumed_quantity_milli = 1000` |
| Stock | reduced **once** (`10.000 → 9.000`) |
| Post-close adjustments | **0** (asserted `≤ 1`) |
| Local invoices / queue rows / conflict rows | **1 / 1 / 0** |
| Orphaned `uploading` row | **none** |
| Subsequent restart and trigger | **0 requests**, state stays `synced`, backend effects deep-equal |

## CP-3G-6D — crash before the server commits

Live, payload 17, and deliberately distinguished from 6A: the process was killed after the claim
committed and **before any byte was dispatched**, so the server was verified to hold nothing for
that key both at the kill and after it.

Recovery used the **same key and the same payload**, Laravel answered with the normal **201 create**
(`uploaded = 1`, `duplicates = 0`), exactly one invoice and one set of effects exist, the queue row
reached `synced` with `attempt_count = 2`, and a further restart sent **0** requests. No orphan
remained.

## CP-3G-6E — the remaining boundaries

Each boundary was crashed for real, reopened independently, and recovered. The invariant asserted for
all of them is the same regardless of whether the server had committed: exactly one invoice, one set
of effects, one local invoice, one queue row, no orphan.

| Boundary | Laravel committed pre-kill | State after restart | Lease/retry transitions | Requests: pre-crash / retry / after success | Local rows after | Backend rows after | Converged as |
|---|---|---|---|---|---|---|---|
| `before-dispatch` (hermetic) | n/a | `uploading` | reclaim → `retryable_error` → `pending` | 0 / 1 / 0 | 1 invoice, 1 queue | n/a | — |
| `before-dispatch` (live, 6D) | **no** | `uploading` | `uploading → retryable_error → pending → uploading → synced` | 0 / 1 / 0 | 1 / 1 / 0 conflicts | 1 invoice, 1 item, 1 payment, 1 audit, 1 movement, 1 consumption | **201 created** |
| `in-flight` | **no** (measured) | `uploading` | `uploading → retryable_error → pending → uploading → synced` | 1 / 1 / 0 | 1 / 1 / 0 | 1 / 1 / 1 / 1 / 1 / 1 | **201 created** |
| `response-received` (6A) | **yes** | `uploading` | `uploading → retryable_error → pending → uploading → synced` | 1 / 1 / 0 | 1 / 1 / 0 | 1 / 1 / 1 / 1 / 1 / 1 | **200 duplicate** |
| `before-outcome` | **yes** | `uploading` | `uploading → retryable_error → pending → uploading → synced` | 1 / 1 / 0 | 1 / 1 / 0 | 1 / 1 / 1 / 1 / 1 / 1 | **200 duplicate** |
| `during-outcome` | **yes** | `uploading` (open transaction discarded) | `uploading → retryable_error → pending → uploading → synced` | 1 / 1 / 0 | 1 / 1 / 0 | 1 / 1 / 1 / 1 / 1 / 1 | **200 duplicate** |

The `in-flight` result is reported as measured rather than as a designed outcome: the kill is
delivered within milliseconds of the request being handed to the transport, and whether Laravel has
committed by then is genuinely a race. The point of the case is that convergence does not depend on
knowing the answer — and the recorded run shows the pre-commit branch, complementing the three
post-commit branches above. In every branch the local payload, hash and idempotency key were
identical on the retry.

Every one of these boundaries was terminated by a real `SIGKILL` on a real process, and the on-disk
state was reopened by an independent process. No boundary is claimed on any weaker basis.

## CP-3G-6F — reclaim isolation

Nine rows in one database, each driven to its shape through production writers. The production
`reclaimExpiredUploadLeases` was run alone, and then the whole startup path (reclaim → release →
drain) was run.

| Row shape | Reclaim alone | After a full startup drain | Requests |
|---|---|---|---|
| `uploading` with an unexpired lease | untouched | **byte-identical** | 0 |
| `synced` | untouched | **byte-identical** | 0 |
| `rejected` | untouched | **byte-identical** | 0 |
| `conflict` | untouched | **byte-identical** | 0 |
| `pending`, not yet due | untouched | **byte-identical** | 0 |
| `retryable_error`, not yet due | untouched | **byte-identical** | 0 |
| owned by another company | untouched | **byte-identical** | 0 |
| owned by another device | untouched | **byte-identical** | 0 |
| owned by another company **and** carrying an expired lease | *(originally: reclaimed — see the correction)* | **byte-identical**, after the correction | 0 |
| owned by another company **and** already retryable and due | *(originally: released to `pending`)* | **byte-identical**, after the correction | 0 |
| integrity-inconsistent payload (hash mismatch) | untouched | claimed, then **held** as `retryable_error` / `payload_integrity_mismatch`; `payload_json`, `payload_hash` and `idempotency_key` **unchanged**, sale preserved | **0** |

The reclaim-alone run left **every** queue row and **every** invoice row deep-equal to its
pre-reclaim snapshot. A full startup drain sent **zero** requests across all nine rows. The one row a
restart acts on is the locally inconsistent payload, and it is *held and preserved for evidence* —
never repaired, never sent, never terminally rejected — which is the CP-3G-5 behaviour, unchanged.

### The finding — DEFECT, CORRECTED. The disposition below is RETRACTED.

**The finding stands, and it is a defect:** `reclaimExpiredUploadLeases` was **not** owner-scoped.
An `uploading` row belonging to another company or another device, whose lease had expired, was
moved to `retryable_error` by this session's startup reconciliation (and then released to `pending`
by the same drain). A dedicated case measured exactly that and observed:

- **zero** outbound requests — reclaim never dispatches;
- the payload, hash and invoice business data **untouched**;
- the row **not** in a terminal state;
- the row still **unclaimable** by this session, because the claim query *is* owner-scoped in SQL.

**What this report originally concluded from those observations is withdrawn.** It argued that the
behaviour was therefore intentional and safe, and that no production change was warranted. That
reasoning was wrong: **writing a foreign row's state is a cross-owner mutation whether or not a
request follows.** Zero dispatch is not isolation. A checkpoint that requires foreign company/device
rows to be left alone is not satisfied by a session moving them somewhere harmless.

The defect was corrected under separate authorization. See
**[the appended correction](#appended-correction--owner-scoped-lease-reclamation-2026-09-03)** for
the production change, its owner-scoping semantics and its executable before/after evidence. The
paragraph this section replaces is preserved above as the observation it was; only its disposition
is retracted.

## CP-3G-6G — repeated restart safety

| Property | Result |
|---|---|
| Repeated startup reconciliation is idempotent | **PASS** — first restart reclaimed `[…0021]`, second reclaimed `[]` and left the row deep-equal |
| An expired `uploading` row is not repeatedly counted as a new dispatch | **PASS** — five restarts, **0** requests, `attempt_count` stayed **1** |
| `attempt_count` changes only for real dispatch attempts | **PASS** — 1 after the crash and every restart, 2 after the one real dispatch |
| Retry timestamps stay policy-compliant | **PASS** — `next_attempt_at` written only for `retryable_error`; terminal states leave it null |
| Multiple simultaneous startup triggers remain single-flight | **PASS** — three concurrent `run()` calls after a crash produced **exactly 1** request |
| No duplicate timers survive disposal/restart | **PASS** — `shutdown()` cancels the backoff timer, and a timer that fires anyway cannot restart a shut-down worker |
| No duplicate subscriptions survive disposal/restart | **PASS** — a disposed subscription drives nothing; a restarted worker owns exactly one, so one publication is one drain |
| A `synced` row is never sent again | **PASS** — three restarts, **0** requests, state stays `synced` |

## Production-wiring pins (Vitest)

Crash recovery that only a test can reach is not crash recovery, so the production call site is
pinned by source assertion, exactly as CP-3G-4 pinned its trigger:

- `src/main/app/appLifecycle.ts` calls `services.invoiceUploads.requestRun()`, and it does so
  **after** `registerIpcHandlers(services)`.
- `src/main/sync/invoiceUploadWorker.ts` calls `reclaimExpiredUploadLeases(` **before**
  `releaseDueRetries(` **before** `claimNextInvoiceUpload(`, with
  `isUploadLeaseExpired(leaseAt, now, UPLOAD_LEASE_DURATION_MS)` and
  `const UPLOAD_LEASE_DURATION_MS = 60_000`.
- The frozen transition table is asserted entry by entry, including the three empty terminal lists.

## Verification ledger — every command executed in this session

| Command | Result |
|---|---|
| `git rev-parse HEAD` / `git status --porcelain` (desktop) | `73912b1…`, clean |
| `sha256sum` plan + CP-3G-5 report (before **and** after) | both **match** the frozen hashes |
| `git rev-parse HEAD` / `git status --porcelain` (backend) | `2bcce42…`, only the untracked BE-3G-0 report |
| `npm run typecheck` | **PASS**, exit 0 (node + web) |
| `npm run lint` | **PASS**, exit 0 — 0 errors, 0 warnings |
| `npm run test` | **PASS — 100 files / 879 tests** (baseline 99 / 870; **+1 file, +9 tests**) |
| `npm run test:cp3g5-harness` | **PASS — 15 tests, 15 pass, 0 fail, 0 skipped** |
| `npm run verify:fixture` | **PASS** — 5 fixtures byte-identical, hashes independently verified |
| `npm run smoke:database` | **PASS** — Electron SQLite migration smoke test passed |
| `npm run test:sqlite:electron` (hermetic) | **PASS — 237 registered / 203 pass / 0 fail / 34 skipped** (baseline 217 / 188 / 29) |
| `CP3G5_PAYLOADS=32 CP3G6_EVIDENCE=… node scripts/cp3g5LiveUpload.mjs` (authorized live) | **PASS**, exit 0 — see the live arm below |
| `npm run build` | **PASS**, exit 0 |
| `npm run build:unpack` | **PASS**, exit 0 |
| `npm run verify:cp3g5-package` | **PASS** — inspected **124** files and **1** `app.asar`; no forbidden harness asset |
| `git diff --check` (pos-desktop) | **PASS**, exit 0 |
| `git diff --check` (pos-backend) | **PASS**, exit 0 |
| `npx vitest run src/main/testing/electronHarnessIntegrity.test.ts` | **PASS — 4 / 4** |
| `npx vitest run src/main/sync/invoiceUploadCrashRecovery.test.ts` | **PASS — 9 / 9** |

**The valid package-boundary command is `npm run verify:cp3g5-package`** (running
`scripts/verifyCp3g5PackageBoundary.mjs`). That is the script CP-3G-5 registered in `package.json`,
and it is the one this checkpoint ran. `verify:cp3g5-package-boundary` does not exist and was not
created: no script was added or renamed to match a longer name.

**MySQL was not used.** Revision 4 does not require a MySQL concurrency arm for CP-3G-6, and none was
run. **No MySQL database was created, named, altered or dropped.** BE-3G-0 remains the strict-MySQL
and concurrency evidence of record.

### Exact test counts

| Arm | Registered | Passed | Failed | Skipped |
|---|---|---|---|---|
| Vitest (`npm run test`) | 879 in 100 files | **879** | 0 | 0 |
| Vitest, CP-3G-6 file only | 9 | **9** | 0 | 0 |
| Electron real-SQLite, hermetic | 237 | **203** | 0 | **34** (29 CP-3G-5 live-only + 5 CP-3G-6 live-only) |
| Electron real-SQLite, CP-3G-6 cases | 20 | 15 hermetic passed | 0 | 5 live-only skipped |
| CP-3G-5 harness safety | 15 | **15** | 0 | 0 |
| Authorized live gate | whole Electron suite | exit 0 — **zero failures**, 20 evidence lines, 0 failure lines | 0 | — |

CP-3G-6 adds **20** real-SQLite cases (15 hermetic + 5 live-only) and **9** Vitest cases. Both
figures are post-correction; the pre-correction checkpoint had 13 and 6.

### The live arm, and one honest reporting limitation

The live gate is run through the **unmodified** CP-3G-5 wrapper, which by design *captures* the
Electron suite's output instead of forwarding it (that is part of the frozen redaction boundary).
Rather than weaken it, CP-3G-6 writes a redaction-safe evidence ledger to a path given by
`CP3G6_EVIDENCE`, outside the disposable sandbox, containing only counts, states, timestamps, hashes
and booleans.

Consequently, for the **live** arm this report states:

- the wrapper exited **0**, which under `node:test` means **zero failing tests across the whole
  Electron suite**, CP-3G-5's 29 cases included;
- the evidence ledger contains **13 lines — one per CP-3G-6 case — all with their invariants
  satisfied**, of which 5 are the live-only crash scenarios;
- a printed per-test tally for the live arm was **not observed**, and is therefore **not claimed**.
  The hermetic tally above is quoted exactly as printed;
- the ledger now also records a **failure line** for any case that throws, so a failing live case
  can be diagnosed without forwarding suite output. The final live run recorded **zero** such
  lines.

Reproduce with:

```bash
CP3G5_PAYLOADS=32 CP3G6_EVIDENCE=/path/outside/the/sandbox/cp3g6-evidence.jsonl \
  node scripts/cp3g5LiveUpload.mjs
```

The larger mint is required because CP-3G-5 owns fixture payloads 0–14 and CP-3G-6 uses 16–20; with
the default 16 payloads the five live CP-3G-6 cases report themselves as **skipped**, never as
silent passes.

## Request counts

| Scenario | Pre-crash | On the retry | After success | Total |
|---|---|---|---|---|
| 6A `response-received` | 1 | 1 | 0 | 2 |
| 6D `before-dispatch` (live) | 0 | 1 | 0 | 1 |
| 6E `in-flight` | 1 | 1 | 0 | 2 |
| 6E `before-outcome` | 1 | 1 | 0 | 2 |
| 6E `during-outcome` | 1 | 1 | 0 | 2 |
| 6B lease boundary (hermetic) | 0 | 1 | — | 1 |
| 6E claim boundary (hermetic) | 0 | — | — | 0 |
| 6F reclaim isolation (9 rows) | — | — | — | **0** |
| 6F foreign expired lease | — | — | — | **0** |
| 6G repeated restarts (5) | 0 | 1 | — | 1 |
| 6G single-flight (3 triggers) | 0 | 1 | — | 1 |
| 6G synced never resent (3 restarts) | — | — | 0 | **0** |

**Exactly one request per dispatch attempt, in every case.** Every recorded request was
`POST /api/v1/desktop/invoices/upload`; the namespace guard asserts no request touched
`/api/v1/admin`, `/api/v1/auth`, a traversal segment or anything matching `batch`. Reclaim, release,
status reads and outcome recording produced **zero** HTTP traffic.

**Post-success redispatch requests: 0**, in every scenario.

## Local and backend row counts

Local, in every live crash scenario, before the crash and after full convergence:

```
local_invoices 1 · local_invoice_items 0 · local_invoice_payments 0
sync_queue 1 · sync_conflicts 0
local_stock_movements 0 · local_stock_allocation_consumptions 0
```

(The seeded fixture commits the invoice header and its queue row; items, payments and stock rows are
not part of the CP-3G-5/6 payload fixture and stay at 0, exactly as CP-3G-5 recorded. Movements and
allocation consumptions remain locally **pending** by design — §10.)

Backend, per scenario, keyed by that payload's own offline number, allocation grant and local
invoice uuid:

| Scenario | invoices | items | payments | uploader audits | movements | consumptions | consumed milli | post-close adjustments |
|---|---|---|---|---|---|---|---|---|
| before the upload | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 6A after crash (pre-retry) | 1 | 1 | 1 | 1 | 1 | 1 | 1000 | 0 |
| 6A after convergence | **1** | 1 | 1 | 1 | 1 | 1 | 1000 | 0 |
| 6D after convergence | **1** | 1 | 1 | 1 | 1 | 1 | 1000 | 0 |
| 6E `in-flight` after convergence | **1** | 1 | 1 | 1 | 1 | 1 | 1000 | 0 |
| 6E `before-outcome` after convergence | **1** | 1 | 1 | 1 | 1 | 1 | 1000 | 0 |
| 6E `during-outcome` after convergence | **1** | 1 | 1 | 1 | 1 | 1 | 1000 | 0 |

Stock quantity moved `10.000 → 9.000` **once** per scenario and did not move again on the retry.
For 6A the whole post-convergence effect set is asserted **deep-equal** to the pre-kill snapshot: the
replay changed nothing at all on the server.

## Disposable environment and cleanup proof

- The backend ran with `DB_CONNECTION=sqlite` and `DB_DATABASE` pointing at
  `<mkdtemp>/pos-desktop-cp3g5-*/cp3g5-backend.sqlite`, created and authorized per run by the
  unmodified wrapper with a 32-byte random nonce and an owner-only (`0600`) marker file. Fixtures
  crossed the boundary only through the owner-only private response file.
- The wrapper printed **`[cp3g5] temporary directory removed and verified absent`**, and its
  `existsSync` re-check passed. After the run, `ls -d /tmp/pos-desktop-cp3g5-*` matches nothing and
  no `pos-desktop-itest-*` or `pos-desktop-electron-node-*` directory survives.
- **HISTORICAL — FALSE CLAIM, RETAINED AS EVIDENCE.** This bullet originally read, verbatim:

  > After the run, `ls -d /tmp/pos-desktop-cp3g5-*` matches nothing, no `pos-desktop-itest-*` or
  > `pos-desktop-electron-node-*` directory survives, and no `php artisan serve` process remains.

  The final clause was **false**, and the check behind it was invalid. It used
  `pgrep -af "artisan serve"`, which cannot see the `php -S` **grandchild** that actually holds the
  socket. A later check by listening socket found exactly such an orphan. The claim is preserved
  here rather than rewritten, because it is the record of how a cleanup assertion can pass while
  cleanup has not happened. It is superseded by
  **[the second appended correction](#appended-correction--live-harness-process-lifecycle-2026-09-03)**.
  The directory half of the claim was, and remains, true: **no disposable database, fixture or
  temporary directory survived** — the leak was a process holding a port, not data.
- Each CP-3G-6 case ran in its own `pos-desktop-itest-*` sandbox: on disk (never `:memory:`),
  asserted inside the sandbox root, production migrations verified version by version, WAL,
  `foreign_keys=1`, `busy_timeout=5000`, and leak-checked on dispose. Every fresh-process bundle and
  coordination marker is written **inside** that sandbox, so the sandbox's own disposal removes them;
  no CP-3G-6 code deletes anything.
- **No MySQL database was created, used, named, altered or dropped.** No test touched the ordinary
  backend development database — the seeder's pre-bootstrap and post-bootstrap checks make that
  unreachable, and the 15 harness-safety regressions re-proved it in this session.
- No bearer token, full payment reference or customer-identifying value appears in this report, in
  the evidence ledger, in a coordination marker, or in any test output. The transport spy records
  header **presence**, never header values.
- `npm run verify:cp3g5-package` inspected 124 packaged files and the final `app.asar`: no forbidden
  harness asset crossed the packaging boundary. The CP-3G-6 support files add no packaged artifact —
  their only runtime outputs live in the system temporary directory.

## Skipped and manual items

- **5 CP-3G-6 live-only cases skip** without a live backend (and without the 32-payload mint). They
  are reported as **skipped**, never as passes, so `npm run test:sqlite:electron` stays hermetic.
- **29 CP-3G-5 live-only cases** skip on the same basis; they all executed in the authorized live run.
- **Manual GUI smoke: NOT RUN.** Plan §12 items **E1–E13** remain user-owned. CP-3G-6 proves E4's
  property — `kill -9` mid-upload, restart, one backend invoice not two — **at the process, transport
  and database level**. That is explicitly **not** the same fact as the on-screen item, and no agent
  may mark it passed.
- **A printed per-test tally for the live arm** was not observed, and is not claimed (above).
- **The accidental development fixtures** were not identified, inspected or cleaned; they remain a
  separate maintenance item, unchanged by this checkpoint.

## Repository states

| | Baseline | Final |
|---|---|---|
| Desktop HEAD | `73912b1dbe22a9141b5d963e5e74829adca5fd72` | `73912b1dbe22a9141b5d963e5e74829adca5fd72` (nothing staged, committed or pushed) |
| Desktop worktree | clean | 2 modified production files, 3 modified test/support files, 4 new files (3 tests/support + this report) |
| Backend HEAD | `2bcce42e9102d76eb57a24445791499989912a05` | `2bcce42e9102d76eb57a24445791499989912a05` |
| Backend worktree | only the untracked BE-3G-0 report | **identical** |
| Plan | `eec49ab7…` | `eec49ab7…` — **not modified** |
| CP-3G-5 report | `89b3a53c…` | `89b3a53c…` — **not modified** |

## Out-of-scope confirmation

Not implemented and not enabled: CP-3G-7, BE-3F-4, marking movements synced, allocation-consumption
acknowledgment, allocation seal/acknowledge/release, forced or timeout-driven release, automatic
reallocation, refund upload, batch upload, corrective or void sales, receipt printing, automatic
conflict repair, upload batching, and Phase 3G production activation. No backend file was modified.
No migration, dependency or lock file changed. `src/shared/constants/syncQueueStates.ts` is
untouched — the transition table was **not** widened. The only production change is the
owner-scoping correction, in the two files named in the ledger above.

## Result

```
CP-3G-6:                 IMPLEMENTED AND VERIFIED, CORRECTED (uncommitted)
CP-3G-7 authorization:   NOT GRANTED
Manual GUI smoke:        NOT RUN — user-owned
Allocation release:      DISABLED
Production activation:   NOT AUTHORIZED
```

**Recommended next step:** the user reviews and commits this checkpoint, then decides whether to
authorize **CP-3G-7** (both repositories' gates in one session plus the 3G manual GUI smoke). Plan
revision 5 should reconcile §9.0/§9.1/§14 to CP-3G-6's commit and flip acceptance-matrix rows 8 and
13 to **MET**.

---

## Appended correction — owner-scoped lease reclamation — 2026-09-03

This section is authoritative wherever it and the checkpoint body above differ. It is appended, not
substituted: the original finding is preserved in "CP-3G-6F — reclaim isolation", where only its
**disposition** is retracted.

### 1. What the original behaviour was

`SyncQueueRepository.reclaimExpiredUploadLeases()` selected its candidates with **no ownership
predicate at all**:

```sql
SELECT local_queue_uuid, upload_lease_at
FROM sync_queue
WHERE aggregate_type = 'invoice' AND operation = 'upload' AND state = 'uploading'
```

Any process, in any company/device context, therefore reclaimed **every** expired `uploading` row in
the database — including rows belonging to another company or another device — writing
`state = 'retryable_error'`, `last_error_code = 'upload_lease_expired'`, `upload_lease_at = NULL` and
`next_attempt_at`. The worker's drain then ran `releaseDueRetries()`, equally unscoped, moving those
same foreign rows on to `pending`.

The transition itself was legal (`uploading → retryable_error → pending`, never a direct
`uploading → pending`), and nothing was dispatched. Both halves of the startup reconciliation were
unscoped; only `claimNextInvoiceUpload` — the step that actually sends — was owner-scoped.

### 2. Why "zero dispatch" was not sufficient

The original report treated the absence of an HTTP request as proof of safety. That was wrong on the
checkpoint's own terms:

- **Isolation is about authority to write, not only authority to send.** A session that has no
  authority over a row has no authority to change its state, its error code, its lease or its retry
  schedule. Doing so is a cross-owner mutation.
- **It rewrote another owner's diagnostic record.** A foreign row acquired
  `last_error_code = 'upload_lease_expired'` from a process that never attempted its upload. Its real
  owner would later read a failure reason invented by an unrelated session.
- **It destroyed the foreign row's lease evidence.** `upload_lease_at` was cleared, so the row's own
  owner could no longer tell when its dispatch had actually been interrupted.
- **It changed the row's eligibility.** A foreign row moved to `pending` becomes claimable the
  instant its owner's context returns, skipping the backoff its owner's policy had scheduled.
- **The safety argument was circular.** "Unclaimable, therefore harmless" leans on a *different*
  query being correctly scoped. One correct guard does not license an unguarded write beside it.
- **It could not be stated as a checkpoint property.** CP-3G-6F claims foreign rows "remain
  completely unchanged". Under the original behaviour that claim was false for the one foreign shape
  that mattered most — a foreign row abandoned mid-dispatch.

### 3. The correction

Two production files, both minimal.

**`src/main/repositories/syncQueue.repository.ts`**

- `reclaimExpiredUploadLeases(owner, nowIso, isExpired)` — takes the owner as its first argument. Its
  candidate read joins `local_invoices` and filters on `company_uuid` **and** `device_uuid`, exactly
  as `claimNextInvoiceUpload` already did.
- The write is no longer delegated to the unscoped `failUpload`. Reclaim now issues its own `UPDATE`
  which repeats the ownership predicate **inside the statement**:

  ```sql
  UPDATE sync_queue
  SET state = 'retryable_error', upload_lease_at = NULL, next_attempt_at = ?,
      last_error_code = ?, last_error_details = ?, updated_at = ?
  WHERE local_queue_uuid = ?
    AND aggregate_type = 'invoice' AND operation = 'upload'
    AND state = 'uploading'
    AND EXISTS (
      SELECT 1 FROM local_invoices i
      WHERE i.local_uuid = sync_queue.local_aggregate_uuid
        AND i.company_uuid = ? AND i.device_uuid = ?
    )
  ```

  A row that stops matching between the read and the write updates zero rows, which raises and
  discards the whole transaction rather than reclaiming it.
- `releaseDueRetries(owner, nowIso)` is scoped identically, for the same reason: it is the other half
  of the same startup reconciliation, and moving a foreign row to `pending` is the same class of
  cross-owner mutation. Its `UPDATE` carries the same `EXISTS` guard.
- Written state is unchanged in every other respect; the `upload_lease_expired` code and message are
  now module constants so the two cannot drift.

**`src/main/sync/invoiceUploadWorker.ts`**

- `drain()` resolves `currentUploadOwner()` **before** reconciling. With no owner it logs
  `reconciliation-skipped no-session-owner` and performs **no** reclaim, **no** release and **no**
  claim — there is no global maintenance sweep before a session owner exists.
- `currentUploadOwner()` reads `session.getContext()` — the main-owned
  `SqliteSessionMetadataRepository` in production — on every call. It is never cached, never passed
  in, and never sourced from the renderer or an IPC payload. `authorize()` now reuses it, so the
  dispatch gate and the reconciliation gate cannot diverge.
- Dispatch still re-runs the full §3 order — `assertAllowed('sync')`, `pos.invoice.upload`, and the
  company/device tuple — immediately before every send. Nothing was relaxed.

### 4. Owner-scoping semantics, and what is deliberately excluded

Ownership is exactly **`local_invoices.company_uuid` + `local_invoices.device_uuid`**, resolved from
main-owned session metadata.

**`user_uuid` is deliberately not a predicate.** The backend derives cashier, branch and warehouse
from the immutable shift row (§1.6, BE-3G-0 row 4), so a sale queued by one cashier is legitimately
recoverable and uploadable by another on the same till. Scoping by user would strand a colleague's
committed offline sale behind a logout.

**`commit_session_epoch` is deliberately not a predicate.** An offline sale must survive logout,
session rotation and re-login (§3 item 3). Gating recovery on the epoch would strand every sale made
before the current login — the precise failure the queue exists to prevent. The string
`commit_session_epoch` does not appear in the repository at all, and a Vitest case asserts that.

The consequence is bounded and correct: a foreign row abandoned mid-dispatch stays `uploading` until
a session for **its** company and device runs reconciliation, at which point the ordinary path
recovers it. That is proven executably, below.

### 5. Startup wiring — inspected, and preserved rather than replaced

`appLifecycle.ts` calls `services.invoiceUploads.requestRun()` after `registerIpcHandlers`. The
authoritative owner is available at that moment whenever one exists: `getContext()` is a direct read
of the persisted `auth_session_metadata` singleton, not an asynchronous restoration, so a relaunched
app that had a session reconciles for that owner on the same startup trigger it always used.

When there is no session at startup, reconciliation now correctly does nothing — so a **later**
main-owned trigger is required, and one already exists. `BootstrapService`'s completion callback and
`ConnectivityService.onChange` both call `CommercialAccessPublisher.publishCurrent()`, and
`subscribeInvoiceUploadTriggers()` subscribes the worker to `onPublished`. A login therefore
establishes the session and completes bootstrap, which publishes, which schedules a drain — and that
drain reconciles for the newly authoritative owner.

**No polling was added, no owner is fabricated, no renderer event is treated as authority, and no
parallel event system was introduced.** The `sync:*` IPC surface is unchanged. The publication is a
scheduling hint only: the worker still resolves the owner from session metadata itself.

### 6. Executable before/after evidence

Real file-backed Electron SQLite, production migrations, production repositories, the production
worker, and a counting transport. Seven new cases (`CP-3G-6H`), plus three new Vitest cases.

| # | Proof | Result |
|---|---|---|
| 1 | **Original defect reproduced, not assumed** — the pre-correction candidate query (`state='uploading'`, no owner filter) is run against the fixture and returns **4** rows: the owned one and all three foreign shapes | **PASS** |
| 2 | The corrected reclaim returns **only** the owned row from that same set | **PASS** — `reclaimed = [owned]` |
| 3 | Foreign company + **same** device — unchanged | **PASS** — queue row `deepEqual` before/after |
| 4 | Same company + **foreign** device — unchanged | **PASS** — queue row `deepEqual` before/after |
| 5 | Foreign company **and** foreign device — unchanged | **PASS** — queue row `deepEqual` before/after |
| 6 | Foreign rows' `local_invoices` rows unchanged | **PASS** — `deepEqual` before/after |
| 7 | A foreign abandoned row after a full startup drain | **PASS** — stays `uploading`, `last_error_code` **null**, lease intact, `next_attempt_at` null, `attempt_count` 1; **all** queue and invoice rows `deepEqual` |
| 8 | Missing session context — zero writes | **PASS** — 4 empty/cleared session shapes, all queue and invoice rows `deepEqual`, 0 requests |
| 9 | Cleared/partial session (company without device, device without company, authenticated flag lowered) | **PASS** — same |
| 10 | Same company/device, **different cashier** — still recovered | **PASS** — reclaimed, redispatched, 1 request |
| 11 | Same company/device, **rotated session epoch** — still recovered | **PASS** — epoch 1 → 2, reclaimed, redispatched |
| 12 | Unexpired owned lease — untouched | **PASS** — stays `uploading` (checkpoint body, CP-3G-6B) |
| 13 | Terminal `synced` / `rejected` / `conflict` rows | **PASS** — byte-identical (CP-3G-6F, now 10 protected shapes) |
| 14 | `pending` not due and `retryable_error` not due | **PASS** — byte-identical |
| 15 | Reclaim outbound requests | **0**, in every case |
| 16 | Repeated owner-scoped reconciliation is idempotent | **PASS** — first restart reclaims the owned row, three further restarts reclaim `[]` and leave all rows `deepEqual`; the 3 foreign rows stay `uploading` with null error codes |
| 17 | A later login as the row's real owner recovers it | **PASS** — 0 requests under the stranger session, then 1 request and `attempt_count` 2 under the rightful one |
| 18 | Concurrent owners over one database | **PASS** — two workers, two owners, each row advanced exactly once by its own owner, 2 requests, no cross-owner mutation |
| 19 | **The predicate is enforced by the `UPDATE`, not only the read** — ownership is revoked between the reclaim's read and its write | **PASS** — the update matches 0 rows, the repository refuses, and the transaction is discarded: every queue row `deepEqual` and the revoked ownership itself undone |
| 20 | No direct `uploading → pending` | **PASS** — frozen table asserted entry by entry; `isSyncQueueTransitionAllowed('uploading','pending')` is `false` |
| 21 | Owner predicate present in both `UPDATE` statements | **PASS** — Vitest source assertion matches the `EXISTS … company_uuid = ? AND device_uuid = ?` guard in the reclaim **and** release updates |
| 22 | No user or epoch predicate anywhere in the repository | **PASS** — Vitest asserts `commit_session_epoch` is absent and no `user_uuid` predicate exists in the reclaim path |
| 23 | The worker resolves the owner before reconciling, from session metadata only | **PASS** — Vitest pins the ordering, the skip log, and the absence of `ipcRenderer` / `event.sender` / `BrowserWindow` in the worker |
| 24 | Both reconciliation calls receive the session-derived tuple | **PASS** — Vitest captures both owners and asserts `{companyUuid, deviceUuid}` |
| 25 | **Every pre-existing CP-3G-6 proof still green** — SIGKILL at all six boundaries, 201 create, 200 duplicate, exactly-once backend effects, no orphan | **PASS** — see the live arm below |

### 7. Verification after the correction

Every command re-run in this session, after the production change:

| Command | Result |
|---|---|
| `npm run typecheck` | **PASS**, exit 0 |
| `npm run lint` | **PASS**, exit 0 — 0 errors, 0 warnings |
| `npm run test` | **PASS — 100 files / 879 tests** (was 876) |
| `npm run test:cp3g5-harness` | **PASS — 15 / 15**, 0 skipped |
| `npm run verify:fixture` | **PASS** — 5 fixtures byte-identical |
| `npm run smoke:database` | **PASS** |
| `npm run test:sqlite:electron` (hermetic) | **PASS — 237 registered / 203 pass / 0 fail / 34 skipped** (was 230 / 196 / 34) |
| `CP3G5_PAYLOADS=32 CP3G6_EVIDENCE=… node scripts/cp3g5LiveUpload.mjs` | **PASS**, exit 0 — 20 evidence lines, **0** failure lines |
| `npm run build` | **PASS**, exit 0 |
| `npm run build:unpack` | **PASS**, exit 0 |
| `npm run verify:cp3g5-package` | **PASS** — 124 files and 1 `app.asar`, no forbidden asset |
| `git diff --check` (pos-desktop / pos-backend) | **PASS**, exit 0 / exit 0 |

Backend HEAD `2bcce42e9102d76eb57a24445791499989912a05` with status digest
`0391b553c98196c7a92bb176c39accc626079f9d1428b6d0fe5f6f3966bbb13c` — unchanged before and after.
Plan SHA-256 `eec49ab7…` unchanged. Desktop HEAD is still the frozen CP-3G-5 commit
`73912b1dbe22a9141b5d963e5e74829adca5fd72`; nothing was staged, committed or pushed.

The live arm is reported distinctly from the hermetic arm, as before: the hermetic tally is quoted
exactly as printed, and the live arm is attested by exit 0 plus the evidence ledger, which now also
carries a failure line for any case that throws.

### 8. A separate harness defect, reported not fixed

While re-running the live gate, a **pre-existing CP-3G-5 harness defect** surfaced and is recorded
here rather than silently worked around.

`scripts/cp3g5LiveUpload.mjs` shuts its server down with `server.kill('SIGTERM')` against
`php artisan serve`. That command is a supervisor: the socket is actually held by a `php -S`
**grandchild**, which is not in the signalled process group and survives. The disposable database it
was serving is then removed and verified absent, leaving an orphan listening on port 8399 backed by
a deleted file.

Observed consequence: a subsequent run's own `php artisan serve` cannot bind the port, the readiness
probe succeeds against the **stale** server, and every upload returns **HTTP 500**. The first
post-correction live run failed exactly this way — five live cases failing with `500 !== 201`,
`0 !== 1`, and two children exiting before their boundary. After clearing the orphan by listening
socket, the identical suite passed with exit 0 and zero failure lines.

This is **not** caused by, and does not affect, the owner-scoping correction: the hermetic arm was
green throughout, and the failures were a dead backend, not a queue-state defect.

**Not fixed at the time of this correction.** It lived in the frozen CP-3G-5 wrapper whose 15 safety
regressions were outside that correction's authorization, and it was a distinct bounded defect. It
leaked a **process holding a port**, never data: no disposable database, fixture, credential or
temporary directory survived.

> **NOW FIXED — see
> [the second appended correction](#appended-correction--live-harness-process-lifecycle-2026-09-03).**
> The suggested fix recorded here — spawn the server detached and signal its process group, then
> verify the port is free — is exactly what was authorized and implemented. The operational
> workaround this section used to recommend (checking the port rather than the process name) is no
> longer needed, and the fixed port it named no longer exists.

### 9. Corrected status

```
CP-3G-6 corrective gate:            PASS
Owner-scoped reclaim:               company + device, enforced in SQL
Reclaim owner source:               main-owned session metadata only
Foreign company/device rows:        byte-identical, proven before/after
Cross-user recovery:                preserved
Session-epoch-independent recovery: preserved
Production files changed:           syncQueue.repository.ts, invoiceUploadWorker.ts
Migration / dependency:             NONE
Backend:                            UNCHANGED
CP-3G-6 freeze readiness:           READY
CP-3G-7 authorization:              NOT GRANTED
Manual GUI smoke:                   NOT RUN — user-owned
Allocation release:                 DISABLED
Production activation:              NOT AUTHORIZED
Files staged/committed/pushed:      NONE
```

---

## Appended correction — live-harness process lifecycle — 2026-09-03

Authoritative wherever it and anything above differ. The first correction's §8 recorded this defect
and deferred it; this section closes it.

**The original live run was not hermetic, and this report does not claim it was.** It left a server
process behind. The suite that produced the first correction's evidence was green only after a
**manual** orphan kill, which is precisely the intervention a hermetic gate must not need. The
crash-recovery findings themselves are unaffected — they were re-proven twice, from a clean state,
with no manual step — but the hermeticity claim for that earlier run is withdrawn.

### 1. The real process tree

Measured under controlled conditions, against a disposable SQLite file on an ephemeral port, using
only recorded pids:

```
node (harness)   pid 506630   pgid 506629   sid 506625
└─ php artisan serve            pid 506641   pgid 506629   ← same group as the harness
   └─ php8.4 -S 127.0.0.1:PORT  pid 506644   pgid 506629   ← holds the listening socket
```

`php artisan serve` is a **supervisor**. The socket belongs to a `php -S` **grandchild**. The
wrapper's `server.kill('SIGTERM')` addressed only the artisan child, so after cleanup:

| Step | artisan | `php -S` | port | disposable database |
|---|---|---|---|---|
| serving | alive | alive | held | present |
| after `SIGTERM` to the artisan child | **dead** | **alive** | **still held** | present |
| after the wrapper removed its temporary directory | dead | **alive** | **still held** | **deleted** |

The end state is an orphan serving a database that no longer exists.

Worse, because `spawn` was not `detached`, **every one of those processes shared the harness's own
process group (506629)**. A naive "kill the process group" fix would have signalled the Node harness
itself. That is why the correction establishes a *new* group rather than reusing the inherited one.

### 2. Why the earlier `pgrep` check was invalid

The first checkpoint asserted cleanup with `pgrep -af "artisan serve"`. That command matches on a
**command name**, and the surviving process is not named `artisan serve` — it is
`php8.4 -S 127.0.0.1:<port> …/server.php`. The check therefore reported success against a process it
could not, by construction, ever see. A name-based process assertion cannot prove cleanup of a tree
whose leaf has a different name; only recorded pids, process groups and socket state can.

### 3. The five-case failed run, and the invalidated hermeticity

An orphan from an earlier run held the port with a deleted database. The next live run's own
`php artisan serve` could not bind, the readiness probe succeeded **against the stale server**, and
every upload returned HTTP 500. Five live cases failed:

| Case | Observed failure |
|---|---|
| CP-3G-6A server-committed / ack-lost | `500 !== 201` |
| CP-3G-6D pre-commit crash | `0 !== 1` (the recovery drain sent nothing) |
| CP-3G-6E in-flight | `'retryable_error' !== 'synced'` |
| CP-3G-6E before-outcome | fresh process exited before reaching its boundary |
| CP-3G-6E during-outcome | fresh process exited before reaching its boundary |

None was a queue-state or upload defect: the hermetic arm was green throughout, and the identical
suite passed once the orphan was cleared. But it was cleared **by hand**. A gate that needs a human
to inspect sockets and kill a process before it will pass is not hermetic, and its "clean run" is
not evidence of a clean harness.

### 4. The implemented ownership and termination strategy

**Ownership.** Every child the harness starts — the Laravel server *and* the Electron suite — is
spawned through `startOwnedProcessGroup()` with `detached: true`, making it the leader of a brand
new process group whose id equals its own pid. The whole tree beneath it inherits that group. The
helper then verifies, from `/proc`, that:

- the child really is its own process-group leader (`pgid === pid`);
- that group is **not** the harness's own group and **not** the harness's pid.

If either check fails the child is terminated **by its recorded pid alone** and the run stops. There
is deliberately no broad fallback: the whole point is not to destroy something the harness does not
own.

**Termination.** `terminateOwnedProcessGroup()` runs a bounded escalation against that group id:

1. `SIGTERM` to `-pgid`;
2. wait up to `CP3G5_GRACEFUL_MS` (default 5 s) for the group to empty;
3. if any member survives, `SIGKILL` to the **same** group;
4. wait up to `CP3G5_FORCED_MS` (default 5 s);
5. re-scan `/proc` and report the surviving members.

`signalOwnedGroup()` refuses outright to signal group `0`, group `1`, the harness's pid, or the
harness's own group. `ESRCH` is tolerated — a group that has already exited is a success, not an
error.

**No broad matching anywhere.** A regression asserts that the only two `process.kill` targets in the
whole harness are `child.pid` and `-processGroupId`, that no `pkill`/`killall`/`fuser` appears in the
wrapper, the seeder or the safety tests, and that socket ownership is never turned into a kill
target. Socket inspection exists **only** to prove a listener is ours.

### 5. Port isolation

The fixed port `8399` is gone; the string does not appear anywhere in the harness, and a regression
asserts that. Each run instead:

1. reserves a loopback port by binding `127.0.0.1:0` and releasing it;
2. re-checks that the port is free immediately before starting the server, and **stops** if it is
   not — a port someone else holds is a reason to fail, never a reason to reclaim it;
3. passes the resulting origin explicitly to the Electron child through `CP3G5_API_ORIGIN`;
4. after readiness, proves the listener is **ours** by matching the listening socket's inode
   (`/proc/net/tcp`) against the open descriptors of the recorded group members. Answering `/up` is
   no longer sufficient — that is exactly what the stale orphan did;
5. on cleanup, proves release by **rebinding** the port.

### 6. Cleanup order, and its proof

Cleanup runs on success, test failure, startup failure, timeout, signal, thrown exception and child
crash, always in this order:

1. terminate the **Electron suite** group (the only thing still talking to the server);
2. terminate the **Laravel server** group, whole;
3. verify every recorded server pid is gone;
4. verify the selected port rebinds;
5. **only then** remove the disposable database and its directory;
6. verify the directory is absent;
7. drop this run's authorization material (nonce reference and its environment entry).

If any of steps 1–4 cannot be proven, the temporary directory is **deliberately retained** — the
database is never deleted out from under a process that may still hold it open — the wrapper prints
`[cp3g5] retaining the temporary directory: a server may still hold it open`, and exits **2**. A
cleanup failure is reported in its own right and never folded into a test failure: when both occur
the wrapper prints both lines. Redaction is unchanged — child output is still drained and discarded,
never forwarded.

### 7. Regression coverage

`npm run test:cp3g5-harness` now runs **33** cases: the original **15** safety regressions plus
**18** new lifecycle regressions. **Correction:** as first written this script ran its two files
concurrently and was not reliably green — see
**[the third appended correction](#appended-correction--harness-gate-serialization-and-timer-leak-2026-09-03)**. Every assertion uses recorded pids, recorded process groups, or a
real socket bind; none is a `pgrep` on a command name.

| # | Regression | Result |
|---|---|---|
| 1 | `artisan serve` really does hold its socket in a `php -S` grandchild — two members, one group, listener ≠ artisan pid, verified by socket inode | **PASS** |
| 2 | A graceful owned group terminates on `SIGTERM` with no escalation | **PASS** |
| 3 | A `SIGTERM`-resistant owned child is escalated to `SIGKILL` within a bounded wait | **PASS** |
| 4 | A group whose leader exits first is still terminated whole (the artisan/`php -S` shape, with no PHP in it) | **PASS** |
| 5 | The harness refuses to signal its own group, group 1, or its own pid | **PASS** |
| 6 | No broad process matching anywhere; kill targets are exactly `child.pid` and `-processGroupId`; the fixed port string is gone | **PASS** |
| 7 | A failing run after the server is ready leaves no child or grandchild, and releases its port | **PASS** |
| 8 | A Laravel startup failure leaves no owned process | **PASS** |
| 9 | An Electron suite failure still terminates the whole Laravel tree | **PASS** |
| 10 | A hung suite is timed out and its whole group cleaned | **PASS** |
| 11 | The temporary directory is never removed while an owned server process is alive — asserted as an invariant sampled during the run, plus proof the watcher sampled that window | **PASS** |
| 12 | Two consecutive runs need no manual cleanup and never share a port or a group | **PASS** |
| 13 | An unrelated `php -S` on another port survives a full harness run, still alive and still holding its socket | **PASS** |
| 14 | A port already taken is reported by the harness's own predicate and never reclaimed | **PASS** |
| 15 | Wrapper output stays free of tokens, stack traces and 64-hex material on every failure path | **PASS** |
| 16 | The exact unauthorized seeder invocation is still rejected before Laravel loads | **PASS** |
| 17 | Packaging still excludes every harness asset | **PASS** |
| 18 | A full successful run leaves no child, no grandchild and no sandbox | **PASS** |

The failure paths are driven by `CP3G5_FAULT`, a strict four-value allowlist that can only make a
run **fail earlier**. No value relaxes an authorization check, widens a path guard, retains a
sandbox, or skips any part of cleanup.

### 8. Two consecutive live runs, from a clean state, with no manual intervention

Pre-state: no `pos-desktop-cp3g5-*` directory, no harness server process.

| | Run 1 | Run 2 |
|---|---|---|
| Exit code | **0** | **0** |
| Duration | 19 s | 19 s |
| Selected port | **38841** | **42083** (different) |
| Port free afterwards | **yes** (rebound) | **yes** (rebound) |
| `Electron SQLite live suite passed` | yes | yes |
| `temporary directory removed and verified absent` | yes | yes |
| Sandbox directories remaining | **none** | **none** |
| New `artisan serve` / `php -S` processes remaining | **none** | **none** |
| CP-3G-6 evidence lines | **20** | **20** |
| Failure-ledger lines | **0** | **0** |
| `stderr` | empty | empty |

Crash-convergence evidence, identical across both runs:

| Case | Converged as | Backend invoices | Consumptions | Consumed milli |
|---|---|---|---|---|
| CP-3G-6A server-committed / ack-lost | **200 duplicate** | 1 | 1 | 1000 |
| CP-3G-6D pre-commit crash | **201 created** | 1 | 1 | 1000 |
| CP-3G-6E in-flight | 200 duplicate | 1 | 1 | 1000 |
| CP-3G-6E before-outcome | 200 duplicate | 1 | 1 | 1000 |
| CP-3G-6E during-outcome | 200 duplicate | 1 | 1 | 1000 |

The second run began immediately after the first, with **no** manual cleanup, no port check and no
process kill between them — the condition the original harness could not meet.

### 9. Verification after the lifecycle correction

| Command | Result |
|---|---|
| `npm run typecheck` | **PASS**, exit 0 |
| `npm run lint` | **PASS**, exit 0 |
| `npm run test` | **PASS — 100 files / 879 tests** |
| `npm run test:cp3g5-harness` | **SUPERSEDED — see the third appended correction.** The 33 cases exist, but as this script was written it ran its two files **in parallel** and did not reliably pass; re-verified green only after serialization |
| `npm run verify:fixture` | **PASS** — 5 fixtures byte-identical |
| `npm run smoke:database` | **PASS** |
| `npm run test:sqlite:electron` (hermetic) | **PASS — 237 registered / 203 pass / 0 fail / 34 skipped** |
| Authorized live gate, run 1 | **PASS**, exit 0 — 20 evidence lines, 0 failure lines |
| Authorized live gate, run 2 (immediately after) | **PASS**, exit 0 — 20 evidence lines, 0 failure lines |
| `npm run build` | **PASS**, exit 0 |
| `npm run build:unpack` | **PASS**, exit 0 |
| `npm run verify:cp3g5-package` | **PASS** — 124 files and 1 `app.asar`, no forbidden asset |
| `git diff --check` (pos-desktop / pos-backend) | **PASS**, exit 0 / exit 0 |

The owner-scoped reclaim correction is untouched by this work: the `src/` diff is byte-identical to
what the first correction produced (135 insertions, 41 deletions across the same two files), and no
production upload behaviour changed here. Backend HEAD `2bcce42e…` with status digest
`0391b553…` — unchanged. Plan SHA-256 `eec49ab7…` — unchanged. Desktop HEAD is still the frozen
CP-3G-5 commit; nothing staged, committed or pushed.

### 10. Final process, port and directory evidence

- No `pos-desktop-cp3g5-*`, `pos-desktop-itest-*` or `pos-desktop-cp3g5repro-*` directory exists.
- No `artisan serve` or `php -S` process is running.
- Both selected ports rebind freely.
- The two orphans that existed before this correction were cleared by targeted `SIGTERM` to the two
  pids observed holding the harness port, each confirmed by `ss -ltnp` beforehand. No broad match,
  no name-based kill, and nothing else was signalled.

**One thing this report will not claim.** An unrelated `php artisan serve` on port 8000, observed
earlier in the session, is no longer running. It was **never a target**: the only pids ever signalled
by hand were the two confirmed to hold the harness port, and the lifecycle tests only ever signal
groups they created. There is no record of what ended it, so no claim is made that it was untouched
by anything at all — only that nothing here targeted it, and that the regression proving an unrelated
PHP server survives a full harness run passes.

### 11. Corrected status

```
CP-3G-6 lifecycle correction:       PASS
Server process ownership:           dedicated process group per run, verified from /proc
Termination:                        SIGTERM → bounded wait → SIGKILL to the same group → verified
Port:                               per-run loopback selection; no fixed port anywhere
Cleanup order:                      suite → server → pids → port → database → directory → secrets
Cleanup failure:                    exit 2, sanitized diagnostic, directory deliberately retained
Harness regressions:                33 (15 safety + 18 lifecycle)
Two consecutive live runs:          PASS, no manual intervention
Production upload behaviour:        UNCHANGED
Backend:                            UNCHANGED
CP-3G-6 freeze readiness:           READY
CP-3G-7 authorization:              NOT GRANTED
Manual GUI smoke:                   NOT RUN — user-owned
Allocation release:                 DISABLED
Production activation:              NOT AUTHORIZED
Files staged/committed/pushed:      NONE
```

---

## Appended correction — harness gate serialization and timer leak — 2026-09-03

Authoritative wherever it and anything above differ. The second appended correction implemented the
process-lifecycle ownership strategy correctly; **this section corrects two defects in how that work
was gated**, and re-executes the whole verification list in the session that claims it.

**Every result in this section was executed in this session.** Nothing is carried forward from the
earlier corrections, and no figure below is quoted from them.

### 1. The two defects found while re-verifying

Re-running `npm run test:cp3g5-harness` against the second correction did **not** reproduce its
reported `33 / 33`. It reported **17 pass, 1 fail**, and then appeared to hang.

**Defect 1 — the two regression files ran concurrently.** The second correction pointed the script
at both files in one invocation:

```
node --test tests/cp3g5HarnessSafety.test.mjs tests/cp3g5HarnessLifecycle.test.mjs
```

On Node v22.13.1 `node --test` runs **test files in parallel** by default. Both files drive the live
wrapper, and the safety file additionally asserts that the *global* set of `pos-desktop-cp3g5-*`
sandbox directories is unchanged across its own wrapper run — an assertion that is only meaningful
when no other file is creating sandboxes at the same time. Case 18, the full successful live run,
failed:

```
not ok 18 - a full successful run leaves no child, no grandchild and no sandbox
  the live gate must pass end to end
  1 !== 0
  duration_ms: 1079.697685
```

The 1.08 s duration shows the wrapper exited before it could reach its Electron suite.

**Defect 2 — an uncleared timer in the lifecycle file.** `runWrapper()` raced the child's `close`
event against a `setTimeout(timeoutMs)` and never cleared the loser. With a 420 s default budget,
every case left a live timer behind, so after its final assertion the file sat idle holding the
event loop open. The observed process (`pid 14448`) had **no children and no open sandbox** and was
simply sleeping — the run had finished but could not exit.

### 2. Evidence that each defect is real, and that neither is a lifecycle-strategy defect

| Check | Result |
|---|---|
| The live wrapper run standalone, `CP3G5_PAYLOADS=32` | **exit 0** — full run, suite passed, sandbox removed |
| Two wrappers run deliberately concurrently (safety-shaped + lifecycle-shaped) | both behaved as designed: the seeded-failure run exited **1** at seeding, the success run exited **0** |
| `node --test tests/cp3g5HarnessLifecycle.test.mjs` alone | **18 tests / 18 pass / 0 fail / 0 skipped**, exit 0 |

The ownership, termination, port-isolation and cleanup-ordering strategy of the second correction is
therefore **unchanged and correct**; what was wrong was the gate around it.

### 3. The corrections

1. **`package.json`** — the harness gate is serialized:
   `node --test --test-concurrency=1 tests/cp3g5HarnessSafety.test.mjs tests/cp3g5HarnessLifecycle.test.mjs`.
   Both files drive the same live wrapper and both make assertions about global temporary-directory
   state; they are not safe to interleave, and the flag says so explicitly rather than relying on a
   default.
2. **`tests/cp3g5HarnessLifecycle.test.mjs`** — `runWrapper()` now retains the timeout handle and
   clears it once the race settles, so the file exits when its last case ends.

No production file, no wrapper logic, no authorization check and no cleanup step changed in this
correction.

### 4. The original orphan, reproduced independently in this session

Reproduced under the pre-correction conditions — `php artisan serve` spawned **non-detached**, then
signalled the way the old wrapper did — against a disposable SQLite file on an ephemeral port, using
only recorded pids:

```
node (harness)                       pid 12605   pgid 12601   sid 12601
└─ php artisan serve                 pid 12616   pgid 12601   ← same group as the harness
   └─ php8.4 -S 127.0.0.1:46587      pid 12619   pgid 12601   ← holds the listening socket
```

| Step | artisan 12616 | `php -S` 12619 | port 46587 | disposable database |
|---|---|---|---|---|
| serving | alive | alive | held | present |
| after `SIGTERM` to the artisan child only | **dead** | **alive** | **still held** | present |
| after the sandbox directory was removed | dead | **alive** | **still held** | **deleted** |

`ORPHAN REPRODUCED: YES`. The surviving process's command line is
`/usr/bin/php8.4 -S 127.0.0.1:46587 …/server.php` — which **contains no occurrence of
`artisan serve`**, independently confirming why the original `pgrep -af "artisan serve"` cleanup
assertion could never have seen it. The reproduction cleaned up after itself by **recorded pid
only**; nothing was matched by name or by port.

### 5. Verification — every command executed in this session

| Command | Result |
|---|---|
| `npm run typecheck` | **PASS**, exit 0 |
| `npm run lint` | **PASS**, exit 0 |
| `npm run test` | **PASS — 100 files / 879 tests**, exit 0 |
| `npm run test:cp3g5-harness` (serialized) | **PASS — 33 tests / 33 pass / 0 fail / 0 skipped**, exit 0 |
| `npm run verify:fixture` | **PASS** — 5 fixtures byte-identical, hashes independently verified |
| `npm run smoke:database` | **PASS** — Electron SQLite migration smoke test passed |
| `npm run test:sqlite:electron` (hermetic) | **PASS — 237 registered / 203 pass / 0 fail / 34 skipped**, exit 0 |
| Authorized live gate, run 1 | **PASS**, exit 0 |
| Authorized live gate, run 2 (immediately after, no intervention) | **PASS**, exit 0 |
| `npm run build` | **PASS**, exit 0 |
| `npm run build:unpack` | **PASS**, exit 0 |
| `npm run verify:cp3g5-package` | **PASS** — inspected **124** files and **1** `app.asar`; no forbidden asset |
| `git diff --check` (pos-desktop) | **PASS**, exit 0 |
| `git diff --check` (pos-backend) | **PASS**, exit 0 |

Baseline integrity, re-verified after all edits: desktop HEAD `73912b1dbe22a9141b5d963e5e74829adca5fd72`
(nothing staged or committed); plan SHA-256 `eec49ab7…`; CP-3G-5 report SHA-256 `89b3a53c…`; backend
HEAD `2bcce42e…` with only the untracked BE-3G-0 report. The owner-scoped reclaim correction is
untouched — the `src/` diff is still exactly **135 insertions / 41 deletions** across
`syncQueue.repository.ts` (+93 / −31) and `invoiceUploadWorker.ts` (+42 / −10).

### 6. Two consecutive live runs, from a clean state, with no manual intervention

Pre-state: no `pos-desktop-cp3g5-*` directory.

| | Run 1 | Run 2 |
|---|---|---|
| Exit code | **0** | **0** |
| Duration | 19 s | 19 s |
| Selected port | **37937** | **38321** (different) |
| Port rebindable afterwards | **yes** | **yes** |
| `Electron SQLite live suite passed` | yes | yes |
| `temporary directory removed and verified absent` | yes | yes |
| Sandbox directories remaining | **none** | **none** |
| New `artisan serve` / `php -S` processes remaining | **none** | **none** |
| CP-3G-6 evidence lines | **20** | **20** |
| Failure-ledger lines | **0** | **0** |
| `stderr` | empty | empty |

**Nothing was done between the two runs** — no kill, no port check, no directory removal.

Crash convergence and exactly-once effects, from run 2's evidence ledger:

| Case | Converged as | Backend invoices | Consumptions | Consumed milli | Requests after success |
|---|---|---|---|---|---|
| CP-3G-6A/6C server-committed / ack-lost | **200 duplicate** | 1 | 1 | 1000 | 0 |
| CP-3G-6D pre-commit crash | **201 created** | 1 | 1 | 1000 | 0 |
| CP-3G-6E in-flight | 200 duplicate | 1 | 1 | 1000 | 0 |
| CP-3G-6E before-outcome | 200 duplicate | 1 | 1 | 1000 | 0 |
| CP-3G-6E during-outcome | 200 duplicate | 1 | 1 | 1000 | 0 |

Every one of those five recorded the transition sequence
`pending → uploading → retryable_error → pending → uploading → synced`, with
`identicalIdempotencyKey`, `identicalPayloadJson` and `identicalPayloadHash` all true. A direct
`uploading → pending` appears nowhere. The owner-scoped cases (`CP-3G-6H-*`) report
`crossOwnerMutation: false`, `foreignRowsByteIdentical: true` and `updateRefused: true` for the
revoked-ownership race — the reclaim correction is intact under the live gate.

### 7. Final process, port and temporary-directory evidence

- No `pos-desktop-cp3g5-*`, `pos-desktop-itest-*` or `pos-desktop-cp3g5repro-*` directory exists.
- A full `/proc` sweep by command line finds **no** `artisan serve` and **no** `php -S` process.
- Both selected ports (37937, 38321) rebind freely.
- The three system `php-fpm` masters (pids 1974, 1975, 1976) are **alive and untouched** — they were
  never a target, and no broad match could have reached them because none is used.
- One transient PHP process (pid 26648) was observed in the pre-state scan of the two-run driver and
  was gone by the next scan. It was **never signalled by anything here**; it is excluded from the
  "new processes" comparison rather than claimed to have been cleaned up. No claim is made about
  what ended it.

### 8. Corrected status

```
Harness gate serialization:         FIXED — --test-concurrency=1
Lifecycle timer leak:               FIXED — race timeout cleared
Lifecycle strategy (2nd correction): UNCHANGED and re-verified
Harness regressions:                33 (15 safety + 18 lifecycle), 33/33 green, serialized
Original orphan:                    reproduced independently in this session
Two consecutive live runs:          PASS, exit 0 / exit 0, no manual intervention
Production upload behaviour:        UNCHANGED
Owner-scoped reclaim correction:    PRESERVED — 135 insertions / 41 deletions, unchanged
Backend:                            UNCHANGED
Migration / dependency:             NONE
CP-3G-6 freeze readiness:           READY
CP-3G-7 authorization:              NOT GRANTED
Manual GUI smoke:                   NOT RUN — user-owned
Allocation release:                 DISABLED
Production activation:              NOT AUTHORIZED
Files staged/committed/pushed:      NONE
```
