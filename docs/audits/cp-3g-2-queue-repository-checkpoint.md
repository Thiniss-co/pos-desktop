# CP-3G-2 — Upload queue repository layer

**Date:** 2026-09-02 · **Repository:** pos-desktop · **Phase:** 3G, checkpoint 2 of 7 · **Plan:**
`/var/www/html/thinis-pos/plans/POS_PHASE_3G_CONTROLLED_UPLOAD_PLAN.md` §CP-3G-2

## Scope

Everything needed to move an invoice-upload row through the queue state machine and to record the
result — **but nothing that decides an outcome and nothing that sends a request.** No worker, no
scheduler, no HTTP, no wiring into `applicationServices`.

## What was changed

| File | Change |
|---|---|
| `src/main/repositories/syncQueue.repository.ts` | `claimNextInvoiceUpload`, `reclaimExpiredUploadLeases`, `markUploadSynced`, `failUpload`, `releaseDueRetries`, `countForeignPendingUploads`, a shared `updateGuarded` CAS helper, and an honest `getStatus(pausedReason)` |
| `src/main/repositories/localSale.repository.ts` | `markInvoiceSynced` (one UPDATE), `markInvoiceUploadFailed` |
| `src/main/sync/invoiceUploadOutcome.ts` | **New.** `InvoiceUploadOutcome` union + `InvoiceUploadOutcomeRecorder` — writes one outcome across all three tables in a single transaction |
| `tests/electron/support/realRepositories.ts` | `syncConflicts` added to the shared factory |
| `tests/electron/suites/invoiceUploadQueue.suite.ts` + `index.ts` | **New.** 10 real-SQLite cases |

`SyncConflictRepository`, wired into `ApplicationServices` since Phase 3F but never called, now has
its first caller: the recorder writes a conflict row in the same transaction as the queue and
invoice rows.

## Contract problem found and resolved: lease reclaim is not `uploading → pending`

The Phase 3G plan says an expired lease is "reclaimed to `pending`". **That transition is illegal.**
`src/shared/constants/syncQueueStates.ts` allows `uploading → {synced, retryable_error, conflict,
rejected}` and only `retryable_error → pending`. Writing the reclaim as planned would have thrown at
runtime, or invited someone to widen the frozen transition table to make it pass.

Reclaim is therefore **`uploading → retryable_error`**, carrying `last_error_code =
'upload_lease_expired'`, after which ordinary backoff returns the row to `pending`. This is also the
more honest description: an interrupted dispatch *is* a retryable failure. No contract change was
needed, and the plan's §4.3 wording should be corrected when it is next revised.

Reclaiming is only safe because the re-send carries the same `idempotency_key`: a request that did
reach the server converges on `DESKTOP_INVOICE_ALREADY_UPLOADED` instead of creating a second
invoice.

## Design decisions worth keeping

- **Ownership is enforced in SQL, not by the caller.** `claimNextInvoiceUpload` joins
  `local_invoices` and filters on `company_uuid` **and** `device_uuid`. A caller cannot forget the
  check, and a foreign row is unreachable rather than merely un-selected. Cross-*user* is
  deliberately allowed: the backend attributes an upload from the immutable shift row, so a
  colleague's queued sale is legitimately uploadable from this till. `commit_session_epoch` is not
  consulted at all — gating on it would strand every sale made before the current login.
- **`countForeignPendingUploads` exists so the invisible rows can still be explained.** Without it,
  "skipped" and "silently stuck forever" look identical to an operator.
- **Claim moves the queue row and the invoice together**, in one transaction: `sync_queue.state`,
  `attempt_count`, `upload_lease_at`, plus `local_invoices.sync_status` and `sync_attempts`. The two
  must never disagree about whether an upload is in flight.
- **Success is a single UPDATE.** Migration 0007 pins `sync_status`, `synced_at` and `remote_uuid`
  to each other with two CHECKs, so there is no legal way to write them in stages — which is the
  intent, and is now asserted by a test that tries.
- **Terminal states carry no `next_attempt_at`.** `conflict` and `rejected` leave it null so no
  scheduler can wake them, and `releaseDueRetries` cannot see them.
- **Ordering is total and explicit** (`created_at ASC, local_queue_uuid ASC`), per the Phase 3F rule
  that no read whose order matters may depend on physical row order.
- **The pause is not persisted.** `getStatus(pausedReason)` takes the worker's in-memory reason and
  defaults to `null`/`idle`. The repository never invents a pause, and no seventh state was added.
  The existing `sync:get-status` caller keeps its exact previous behaviour.
- **Outcome mapping is not here.** The recorder persists an *already decided* outcome. Deciding it
  from an HTTP answer is CP-3G-3. That seam lets the mapping be unit-tested without SQLite and the
  persistence be proven against real SQLite without HTTP.

## Harness guard respected

`electronHarnessIntegrity.test.ts` forbids Electron suites from constructing repositories directly.
The first draft of the suite did (`new SyncQueueRepository`, `new SyncConflictRepository`) and the
guard caught it. Rather than work around it: `syncConflicts` was added to the shared
`realRepositories()` factory, and the suite backdates `created_at` with an explicit UPDATE instead
of building a second repository with a fake clock.

## Verification — executed in this session

| Command | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm run test` | **754 passed** |
| `npm run verify:fixture` | PASS — 5 fixtures byte-identical |
| `npm run smoke:database` | PASS |
| `npm run test:sqlite:electron` | **179 pass / 0 fail** (was 169 before CP-3G-2's 10 cases) |
| `npm run build` | PASS |
| `git diff --check` | PASS |

### The 10 new real-SQLite cases

claim/lease/synced atomically · duplicate resolves identically to a fresh commit · conflict is
terminal, preserved in `sync_conflicts`, invoice untouched · transient failure backs off then
becomes claimable with an incremented attempt count · orphaned lease reclaimed to `retryable_error`
and retried under the same idempotency key · claims are owner-scoped and ordered by `created_at`
(a *newer* owned row wins over an *older* foreign one) · the schema refuses staged/partial success
writes · `getStatus` counts, and pauses only when told · terminal rejection cannot be resurrected by
release or claim, and writes no conflict row · outcomes cannot be recorded against a row that is not
`uploading`.

## D20 still holds — verified, not assumed

```
grep -rn "uploadInvoice\b" src/ (excluding the client itself)        -> none
grep -cE "InvoiceUploadOutcomeRecorder|claimNextInvoiceUpload" applicationServices.ts -> 0
grep -nE "fetch|net\.|requestWithMeta|apiClient" (new files)         -> none
```

CP-3G-2 writes SQLite but cannot send anything. **Phase 3F smoke item D20 remains valid and runnable
at this commit.** CP-3G-3 is where that changes.

## Not done here

The worker: authorization order, single-flight, triggers, response→outcome mapping, pause/resume
(CP-3G-3) · IPC/preload/renderer (CP-3G-4) · duplicate-safety and crash-recovery proofs
(CP-3G-5/6). `local_stock_movements` and allocation consumptions remain untouched and `pending`.
