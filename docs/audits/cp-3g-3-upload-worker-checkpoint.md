# CP-3G-3 — The invoice upload worker

**Date:** 2026-09-02 · **Repository:** pos-desktop · **Phase:** 3G, checkpoint 3 of 7 · **Plan:**
`/var/www/html/thinis-pos/plans/POS_PHASE_3G_CONTROLLED_UPLOAD_PLAN.md` §CP-3G-3

## This is the commit where uploads begin

Before this commit no code path could dispatch an invoice upload. After it, a committed sale is
uploaded automatically. **Phase 3F smoke item D20 ("no invoice upload is attempted") is expired as
written from here on.** The user was asked and chose to continue rather than block 3G on the
checklist; `docs/audits/phase-3f-manual-gui-smoke-checklist.md` now records how to run D20 against
`ca3ce84`, and that every other smoke item is unaffected by the worker.

## What was added

| File | Role |
|---|---|
| `src/main/sync/invoiceUploadMapping.ts` | **New.** Pure `mapUploadFailure()` — one failure to one disposition |
| `src/main/sync/invoiceUploadWorker.ts` | **New.** `InvoiceUploadWorker`: authorization gate, single-flight drain, lease reclaim, backoff, pause/resume |
| `src/main/app/applicationServices.ts` | Constructs the recorder + worker; `upload` is `uploadInvoice(apiClient, …)` |
| `src/main/app/appLifecycle.ts` | One `requestRun()` after `registerIpcHandlers` |
| `src/main/services/saleCompletion.service.ts` | Optional `onSaleCommitted` hook, fired only on a committed sale |
| `src/main/ipc/sync.ipc.ts` | `sync:get-status` now reads the worker, so a pause is visible |
| Tests | `invoiceUploadMapping.test.ts` (32), `invoiceUploadWorker.test.ts` (16), `sync.ipc.test.ts` (4, first coverage for that handler) |

Triggers: app start · connectivity reaching `online` · a sale committing. Backoff wakes the worker
for retryable rows. A manual "Upload now" is CP-3G-4.

## Two deliberate departures from the plan's §5 table

**1. `DESKTOP_CATALOG_UNAVAILABLE` is retryable, not a conflict.** The plan groups it with the 409
conflict codes. It means the server could not issue a sellable catalog — a server-side inability to
serve, not a disagreement about this payload. Recording it as a conflict would create a
`sync_conflicts` row inviting a human to compare two versions that do not differ. It is now
retryable, and only `IDEMPOTENCY_CONFLICT` and generic `CONFLICT` produce conflict rows.

**2. An unrecognized failure is retried, never terminally rejected.** `categoryForBackendCode`
defaults unknown codes to `rejected`, and a literal reading of the table would make every future
backend code terminal on arrival. The mapping only rejects codes it explicitly knows are terminal.
The asymmetry is the point: a wrongly-retried upload is visible in the queue counts and costs one
more request; a wrongly-rejected one silently strands a real sale the server would have accepted.

Both are covered by named tests and should be folded into the plan at its next revision.

## Design points

- **Authorization is re-evaluated before every dispatch.** `assertAllowed('sync')` (which subsumes
  device status, session, licence, grace, `canSync`, and the online precondition), then
  `pos.invoice.upload` — separately, because `evaluate('sync')` checks no permission at all — then
  the session's company/device tuple. A test revokes authority between two invoices in one drain and
  asserts the second never goes out. **`pos.sell` is never consulted.**
- **A pause stops the worker, not the item.** Every device-wide denial (401/403 classes, unconfigured
  backend, and any unrecognized denial) pauses the loop and releases the claimed row with a **zero**
  delay, so it is eligible the instant authority returns. No item is ever marked terminal for a
  reason that was not about that item. `DESKTOP_HISTORICAL_ATTRIBUTION_FORBIDDEN` is the deliberate
  exception: it is a 403, but it is a fact about one invoice's shift, so it rejects that invoice and
  keeps draining.
- **Single-flight.** Concurrent `run()` calls share one drain and schedule at most one rerun; two
  drains could race for the same lease and put one invoice on the wire twice. Asserted by a test that
  fails if concurrency ever exceeds one.
- **No SQLite transaction is open across the HTTP call** — claim commits, request goes out, outcome
  is written in a second transaction.
- **An upload is never resolved by a timeout.** Silence produces a retry of the same idempotency key,
  which the server answers with its duplicate response. Nothing infers whether the invoice landed.
- **Payload integrity is checked before sending**, reusing the existing
  `payloadHash(JSON.parse(payload_json)) === payload_hash` check from `localSale.service.ts:488`. A
  mismatch is never sent, never terminal, and holds the row for an hour with a diagnostic — repair is
  a separately authorized workflow.
- **Foreign rows are counted and logged**, so a count that never reaches zero can be explained rather
  than sitting there unaccounted for.
- **`onSaleCommitted` cannot break a sale.** It fires only on a committed outcome and swallows
  listener errors: a durable sale must never be turned into a failure by a scheduling hint.

## Verification — executed in this session

| Command | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm run test` | **806 passed** (was 754; +52) |
| `npm run verify:fixture` | PASS — 5 fixtures |
| `npm run smoke:database` | PASS |
| `npm run test:sqlite:electron` | **179 pass / 0 fail** |
| `npm run build` | PASS |
| `git diff --check` | PASS |

Every row of the plan's §5 outcome table has a named test: 201, 200-duplicate, 409, each 422 class,
each 403/401 class, 429/5xx, transport, and each contract failure.

## Not done here

Manual "Upload now", `sync:list-failures`, the `sync:changed` push channel, trusted-sender extension,
and the renderer review UI (CP-3G-4) · the duplicate-safety and crash-recovery proofs against real
SQLite + a fetch spy (CP-3G-5/6). `local_stock_movements` and allocation consumptions remain
`pending` — BE-3F-4 is still not started, and the upload response carries no consumption identities.
