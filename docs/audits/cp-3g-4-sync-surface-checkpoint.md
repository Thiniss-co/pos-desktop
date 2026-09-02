# CP-3G-4 — The operator-facing sync surface

**Date:** 2026-09-03 · **Repository:** pos-desktop · **Phase:** 3G, checkpoint 4 of 7 · **Plan:**
`/var/www/html/thinis-pos/plans/POS_PHASE_3G_CONTROLLED_UPLOAD_PLAN.md` (revision 2) §8.4, §9

## Scope

The complete operator-facing controlled-upload surface: the production resume-trigger wiring, the
narrow `sync:*` IPC/preload surface, the read-only failure review feed, and the renderer status,
counts, manual trigger and review UI.

**Not here:** duplicate-safety (CP-3G-5), crash recovery (CP-3G-6), the combined gate (CP-3G-7). No
backend change, no migration, no dependency, no new queue state, no new outcome policy.

## Baseline

| Item | Value |
|---|---|
| Desktop HEAD | `3133b390c04dd677632e7c3ce88b78e29b7627a6` (`3133b39`), tree clean |
| Backend HEAD (read-only) | `2bcce42`, status digest `0391b553…bbb13c` |
| Plan SHA-256 | `3b5705024b61123c56efc8274918eaf603839e4aa3fb63f9a651cb080b721825` |
| BE-3G-0 report SHA-256 | `6c54a9c60bbf27937040627594edc2c911c1cf768efc785ff27c3879df1a2e42` |
| Baseline unit tests | 94 files / **806 passed** |
| Baseline real-SQLite tests | **179 pass / 0 fail** |

Both the plan and the BE-3G-0 report were re-hashed after the work: **byte-identical**, unmodified.

## Changed files

| File | Change |
|---|---|
| `src/shared/contracts/sync.contract.ts` | Failure/cursor/page schemas, `SYNC_FAILURE_PAGE_DEFAULT_SIZE` (25) and `_MAX_SIZE` (100) |
| `src/shared/constants/ipcChannels.ts` | `syncUploadNow`, `syncListFailures`, `syncChanged` |
| `src/shared/validators/ipc.validators.ts` | `syncUploadNowInputSchema`, `syncListFailuresInputSchema` |
| `src/main/repositories/syncQueue.repository.ts` | `listUploadFailures()` — owner-scoped, keyset-paginated, sanitized projection |
| `src/main/sync/invoiceUploadFailures.ts` | **New.** `InvoiceUploadFailureReader` — resolves the owner from the main session |
| `src/main/sync/invoiceUploadTriggers.ts` | **New.** `subscribeInvoiceUploadTriggers()` — the production resume wiring |
| `src/main/ipc/license.ipc.ts` | `CommercialAccessPublisher.onPublished()` observer |
| `src/main/ipc/sync.ipc.ts` | Three trusted-sender invoke handlers + `broadcastSyncChanged()` |
| `src/main/app/applicationServices.ts` | Subscribes the trigger, publishes status, exposes the reader, disposes on shutdown |
| `src/preload/posApi.ts` | `sync.uploadNow/listFailures/onChanged` + dependency-free status guard |
| `src/renderer/src/modules/sync/{service,store,types}.ts` | Gateway, race-safe store, pagination |
| `src/renderer/src/modules/sync/pages/SyncPage.vue` | Counts, pause reason, manual upload, review list |
| `src/renderer/src/modules/pos/pages/PosPage.vue` | Live sync chip replacing the placeholder |
| `src/renderer/src/i18n/locales/{en,ar}.json` | Full sync vocabulary in both locales |

New tests: `invoiceUploadTriggers.test.ts`, `invoiceUploadFailures.test.ts`,
`sync/store.test.ts`, `sync/pages/SyncPage.test.ts`,
`tests/electron/suites/invoiceUploadFailures.suite.ts`. Extended: `sync.ipc.test.ts`,
`posApiSurface.test.ts`, `sync/service.test.ts`, `PosPage.scope.test.ts`.

## CP-3G-4A — the trigger gap, closed

**The verified defect.** At `3133b39`, `invoiceUploadTrigger` had exactly one production call site —
connectivity reaching `online`. Commercial-access changes were published to the renderer
(`applicationServices.ts:213`) but never reached the worker. Restoring authority while already
online left the worker paused until backoff, restart, another sale, or a manual press.

**The fix.** `CommercialAccessPublisher.publish()` is the authoritative main-owned access-change
point: licence validation, **bootstrap-refresh completion**, catalog refresh and connectivity all
route through it. It gained `onPublished()`, and the composition root subscribes the worker through
`subscribeInvoiceUploadTriggers()`.

**Permission/bootstrap restoration uses that same signal** — `BootstrapService`'s completion
callback calls `commercialAccessPublisher.publishCurrent()`, so a restored `pos.invoice.upload`
schedules a drain through the identical path. No polling was added and no permission event was
fabricated.

**It is a hint, never authority.** The worker still runs `assertAllowed('sync')` →
`pos.invoice.upload` → session company/device ownership → row eligibility → payload integrity
immediately before every dispatch. The renderer's `license:access-changed` message is never routed
back into main.

**Why the wiring is a function.** CP-3G-4A requires proof that production *calls* the resume path.
Extracting the subscription into `subscribeInvoiceUploadTriggers()` makes the production wiring
executable by a test instead of a line only the composition root knows. The one remaining line —
that `createApplicationServices` calls it and disposes it — is pinned by a source assertion, so a
green trigger test cannot coexist with dead production wiring.

Proven in `src/main/sync/invoiceUploadTriggers.test.ts` (7 cases), using the **real**
`CommercialAccessPublisher` and the **real** `InvoiceUploadWorker`:

- paused for access denial → authority restored → `publishCurrent()` → worker drains and dispatches
  exactly one upload, **with connectivity unchanged**, no restart, no new sale, no manual trigger;
- an access signal while still denied → **zero** dispatches, still paused;
- three publications collapse into one dispatch (single-flight);
- after disposal, publications schedule nothing;
- repeated subscription registers one listener each and disposing one does not silence another;
- a throwing listener cannot break access publication for the renderer.

No test in that file calls `worker.requestRun()` to satisfy the requirement.

## IPC and preload security

`sync:get-status`, `sync:upload-now`, `sync:list-failures` each call `assertTrustedSender` **before**
`handleIpcRequest` — `sync:get-status` gains the guard it previously lacked. Validation is strict:
both status and upload accept exactly `undefined`; the failure list accepts only the frozen bounded
cursor contract (`.strict()`, ISO datetime, UUID, limit 1–100).

Proven in `sync.ipc.test.ts` (19 cases): untrusted origin and sub-frame senders rejected on all
three channels; an untrusted upload never reaches the worker; a malformed payload never reaches the
worker or the repository; the handler passes **only** cursor and limit — never an owner; a thrown
`SQLITE_ERROR` mentioning a token surfaces as a sanitized `unexpected` with neither string present.

`sync:changed` is main-to-renderer only. The test asserts exactly three registered invoke channels
and **no inbound handler or listener** for it, so the renderer cannot publish or forge a status.

Preload exposes four named methods and nothing else. `uploadNow` takes no argument at all, so no
preload call can name a row, an owner or a state — it cannot retry, resolve or revive a terminal
record. Pushed payloads pass a **dependency-free structural guard** before any listener runs, which
also guarantees the Electron event object never reaches renderer code. The guard is hand-written
rather than a schema import because the preload is sandboxed; `posApiSurface.test.ts` was extended
(never weakened) and now also asserts no sync schema entered the bundle.

## Failure list — scoping and pagination

The company/device pair is resolved in `InvoiceUploadFailureReader` from the main-process session
and is **not a parameter any caller can supply**. Without a session the list is empty rather than
unscoped. In SQL the owner is joined through `local_invoices`, exactly as `claimNextInvoiceUpload`
does it. Cross-**user** rows on the same device stay visible: upload is device-owned and the backend
attributes it from the immutable shift.

Keyset pagination on the exact drain order `created_at ASC, local_queue_uuid ASC`; no offsets. The
projection carries the queue/invoice identifiers, offline number, total/currency, sold and queued
times, cashier and shift, terminal state, backend code, human-safe message and `trace_id` — and
**never** the frozen `payload_json`, the idempotency key, tokens, headers, SQL or raw exception
text. `local_invoices` is LEFT JOINed so a queue row with a missing invoice stays listed with null
invoice fields rather than vanishing or being invented.

Proven in `tests/electron/suites/invoiceUploadFailures.suite.ts` (9 real-SQLite cases): terminal-only
inclusion (pending/uploading/retryable/synced excluded); company and device isolation; cross-user
visibility; ordering independent of insertion order; ties broken by `local_queue_uuid`; five rows
traversed in pages of two with no duplicate or omission; a foreign cursor moving the window without
widening it; page size clamped at both ends; and a full before/after snapshot of `sync_queue`,
`local_invoices`, `sync_conflicts` and `local_stock_movements` proving **zero writes**.

## Renderer behaviour

The store subscribes to `sync:changed` **before** its first read and applies a fetched status only
when no push landed meanwhile, so a slow initial read cannot overwrite newer pushed state. A failed
refresh keeps the last valid status — showing "0 queued" because a read failed is worse than showing
a slightly stale count. `uploadNow` is single-flight, resets its flag on every path, decides no
authority and performs no optimistic queue mutation. `dispose()` unsubscribes and clears everything.

The page shows all five counts, idle/paused state, the localized pause reason (an unrecognized token
falls back to generic copy and is never printed raw), a manual **Upload now** disabled while busy,
paused or offline with a localized explanation, and the read-only review list with code, message,
trace id, offline number, total and attribution. Renderer disabling is UX only — main still fails
closed. The failure list states plainly that the sale and tender were **not** reversed and that
manual verification is required. There is no retry, delete, edit, void, compensate, release or
mark-resolved control; a test asserts their absence.

The POS shell placeholder is replaced by a live chip driven by queue counts only — never by
connectivity — so an offline cashier still sees what is waiting.

## Verification ledger — all executed in this session

| Command | Result |
|---|---|
| `npm run typecheck` | **PASS** (node + web, exit 0) |
| `npm run lint` | **PASS** — 0 errors, 0 warnings |
| `npm run test` | **PASS — 98 files / 867 tests** (was 94 / 806; **+61**) |
| `npm run verify:fixture` | **PASS** — 5 fixtures byte-identical |
| `npm run smoke:database` | **PASS** |
| `npm run test:sqlite:electron` | **PASS — 188 pass / 0 fail / 0 skipped** (was 179; **+9**) |
| `npm run build` | **PASS**, exit 0 |
| `git diff --check` | **PASS**, exit 0 |

Focused runs before the full gate: `invoiceUploadTriggers.test.ts` 7 · `sync.ipc.test.ts` 19 ·
`invoiceUploadFailures.test.ts` 5 · `sync/store.test.ts` 11 · `SyncPage.test.ts` 11 ·
`posApiSurface.test.ts` 13 · `service.test.ts` 6 · `PosPage.scope.test.ts` 6.

Two defects in my own test doubles were found and fixed rather than worked around: a queue stub that
ignored `pausedReason` (masking the pause), and a seed helper that used FIFO `claimNextInvoiceUpload`
instead of `transition()` and so drove the wrong row once a pending row was left behind.

## Out-of-scope confirmation

Not implemented: CP-3G-5, CP-3G-6, CP-3G-7, BE-3F-4, marking movements synced, allocation-consumption
acknowledgment, allocation seal/acknowledge/release, forced or timeout release, automatic
reallocation, refund upload, batch upload, corrective/void sales, receipt printing.

Verified by command: **no** backend file changed (HEAD `2bcce42`, status digest and BE-3G-0 report
hash identical); the plan is byte-identical; **no** migration; **no** dependency change;
`syncQueueStates.ts` untouched (no new queue state); the only `/api/v1/admin`+`/api/v1/auth`
references remain the pre-existing rejection guard in `desktopApiClient.ts`; no renderer module
imports SQLite, the filesystem, the HTTP client or a token. Nothing staged, committed or pushed.

`local_stock_movements` and allocation consumptions remain `pending`.

## Remaining Phase 3G work

- **CP-3G-5** — duplicate safety: same payload answered 201 then 200 ends with one invoice, one
  queue row; a process-level spy asserting exactly one outbound call per attempt and none outside
  `/api/v1/desktop/*`.
- **CP-3G-6** — crash recovery: `SIGKILL` mid-flight, restart, lease reclaimed, same key re-sent,
  converge on the 200-duplicate, no orphaned `uploading` row.
- **CP-3G-7** — both repositories' gates in one session, plus the 3G manual GUI smoke.

## Manual GUI items for the user (agent may not mark these)

Run from your own terminal (`npm run dev`; `ELECTRON_RUN_AS_NODE` breaks an agent shell). Plan §12
items **E1–E13** all become runnable with this checkpoint. The ones this checkpoint newly enables:

- **E5** Press **Upload now** with an empty queue — nothing happens, no error.
- **E6** Press **Upload now** while offline — a clear offline explanation, no attempt.
- **E7** Revoke `canSync` or `pos.invoice.upload` server-side — the UI shows a paused worker naming
  the reason; selling still works; queued items keep their states.
- **E8** Restore access **without touching the network** — the worker resumes and drains with no
  restart, no new sale and no manual press. *(This is the CP-3G-4A fix as seen on screen.)*
- **E9 / E10** Force a 422 and a 409 — each appears in the review list with reason and trace id, the
  local sale/payments/receipt data intact, and the "not reversed" warning visible.
- Confirm the POS chip shows a live count and reflects a pause.
