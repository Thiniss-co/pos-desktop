# CP-3G-1 — Invoice upload API layer

**Date:** 2026-09-02 · **Repository:** pos-desktop · **Phase:** 3G (controlled upload), checkpoint 1
of 7 · **Plan:** `/var/www/html/thinis-pos/plans/POS_PHASE_3G_CONTROLLED_UPLOAD_PLAN.md` §CP-3G-1

## Scope

The typed call and the response vocabulary for `POST /api/v1/desktop/invoices/upload` — and nothing
else. **No worker, no scheduler, no queue transition, no SQLite write, no wiring.** Outcome mapping
and persistence are CP-3G-3.

This boundary is deliberate: the Phase 3F manual GUI smoke item **D20** asserts that no invoice
upload is attempted, and that evidence becomes unobtainable once an upload worker exists. CP-3G-1 is
sized so the user can still run D20 while it is landed. See "D20 preservation" below.

## What was changed

| File | Change |
|---|---|
| `src/shared/constants/apiErrorCodes.ts` | Registered `DESKTOP_HISTORICAL_ATTRIBUTION_FORBIDDEN`, `DESKTOP_ALLOCATION_PROOF_REQUIRED`, `DESKTOP_LEGACY_CONTRACT_UNSUPPORTED` |
| `src/main/http/apiError.ts` | Categorized the three: attribution → `authorization`, the two 422s → `rejected`. All non-retryable |
| `src/main/http/desktopApiClient.ts` | `DesktopApiResponse<T>` gains `code` and `message`; `requestWithMeta` returns them |
| `src/main/http/desktopResources.contract.ts` | `desktopInvoiceUploadResourceSchema` + the two success-code constants |
| `src/main/sync/invoiceUpload.client.ts` | **New.** `uploadInvoice()` and `parseFrozenUploadPayload()` |
| `src/renderer/src/i18n/locales/{en,ar}.json` | Three error strings (the i18n parity test requires one per known code) |
| `tests/electron/support/allocationTopUp.ts` | Test double updated to the widened client contract |
| `docs/phases/03-shift-pos-cart-barcode.md`, `docs/backend-contract/{sync-contract-summary,error-codes}.md` | Contract corrections, below |

Tests: `src/main/sync/invoiceUpload.client.test.ts` (new, 14 cases), plus additions to
`apiError.test.ts` and `desktopApiClient.test.ts`.

## The three findings this checkpoint acts on

**1. Unknown error codes were being silently discarded.** `normalizeApiEnvelopeError` only preserves
`backendCode` when `isKnownApiErrorCode()` is true. The three upload-specific codes were not listed,
so every one of them arrived at the caller as a bare message with **no code at all** — the upload
worker could not have distinguished a terminal rejection from any other failure. Listing them is the
fix; categorizing them is secondary. `apiError.test.ts` now asserts the preservation directly.

**2. The success `code` never reached the caller.** `requestWithMeta` returned `{ data, meta }`.
Invoice upload answers one request with two different success codes and an identical body — 201
`DESKTOP_INVOICE_UPLOADED` versus 200 `DESKTOP_INVOICE_ALREADY_UPLOADED` — so without the code there
is no way to tell a fresh commit from an idempotent replay. This is the mechanism the entire
no-duplicate-invoice guarantee rests on. The field is additive; the one consumer
(`AllocationAcquisitionService`) reads `data`/`meta` and is unaffected.

**3. Two documents stated the upload's authority incorrectly.**
`docs/phases/03-shift-pos-cart-barcode.md` claimed *"Invoice upload must also assert `pos.sell`,
matching the backend route contract"*. Verified against `pos-backend/routes/desktop.php:50-52`, the
route is `desktop.context:sync,pos,pos.invoice.upload` — **`pos.sell` is not required**, by design,
because a delayed upload may follow a revoked `pos.sell`. Corrected in place.

`pos-backend/docs/architecture/desktop-offline-sync-contract.md` §8 carries the same stale claim plus
"open shift required". **Not edited** — pos-desktop never modifies pos-backend. The drift is recorded
in `docs/backend-contract/sync-contract-summary.md` under "Known drift in the backend's own
documentation", with the note that source wins.

The same file's `Unknowns (TODO)` block was resolved against backend source: the idempotency
mechanism is a **body field** (no header); replay is **200 `DESKTOP_INVOICE_ALREADY_UPLOADED`** and
drift is **409 `IDEMPOTENCY_CONFLICT`**; stale catalog is **422
`DESKTOP_CATALOG_REVISION_INVALID`**; and **no batch endpoint exists**. `VALIDATION_FAILED` in that
table was also wrong — the backend emits `VALIDATION_ERROR`. Two genuine unknowns remain and are
kept as TODOs (heartbeat semantics; whether an upload response will ever carry acknowledged
allocation-consumption identities — it does not today, which is why consumptions stay `pending`).

## Design notes worth carrying into CP-3G-3

- **The frozen payload is sent verbatim.** `uploadInvoice` takes the queue row's `payload_json`
  string and `JSON.parse`s it into the body. It never rebuilds the payload from local rows: a
  rebuilt body could differ from the one whose hash was committed, and the backend answers a
  differing payload under the same key with a 409.
- **`created` and `duplicate` are both acceptance.** Both mean the server holds exactly one invoice
  for this idempotency key, and both must drive the queue row to `synced`. The distinction is kept
  only because "a previous attempt succeeded and its acknowledgment was lost" is worth recording.
- **An unreadable success is not a rejection.** An unrecognized 2xx code, or a body that fails the
  resource schema, throws a non-retryable `unexpected` contract error — but the invoice may well be
  committed server-side. CP-3G-3 must leave such a row retryable and diagnose it, never mark it
  `rejected`. Both cases are commented at the throw site and covered by tests.
- **Laravel's `request_hash` is not reproduced**, and nothing here attempts to.

## D20 preservation (verified, not assumed)

```
grep -rn "uploadInvoice" src/       -> only invoiceUpload.client.ts and its own test
grep -c  "invoiceUpload" src/main/app/applicationServices.ts -> 0   (not wired)
grep -rniE "syncworker|uploadworker|startsync|drainqueue|scheduleupload" src/ -> none
grep -rn "DESKTOP_API_ROUTES.invoicesUpload" src/ -> the module + its test only
```

Nothing constructs or calls `uploadInvoice` in production code, so no code path can dispatch an
invoice upload at runtime. **Phase 3F smoke item D20 remains valid and runnable at this commit.**

## Verification — executed in this session

| Command | Result |
|---|---|
| `npm run typecheck` | PASS, exit 0 |
| `npm run lint` | PASS, exit 0 |
| `npm run test` | **91 files / 754 tests passed** (was 90 / 732) |
| `npm run verify:fixture` | PASS — 5 fixtures byte-identical |
| `npm run test:sqlite:electron` | **169 pass / 0 fail / 0 skipped** |
| `npm run build` | PASS, exit 0 |
| `git diff --check` | PASS, exit 0 |

No pos-backend file was modified; the backend was read only.

## Not done here

Queue transitions and lease handling (CP-3G-2) · the worker, authorization order and outcome mapping
(CP-3G-3) · IPC/preload/renderer surface (CP-3G-4) · the duplicate-safety and crash-recovery proofs
(CP-3G-5/6). `local_stock_movements` and allocation consumptions remain untouched and `pending`.
