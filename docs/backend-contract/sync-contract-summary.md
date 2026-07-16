# Sync Contract Summary

Summarized from "offline sync contract is documented" in the backend's confirmed desktop MVP
status. Full client-side behavior rules (state machine, review, worker pause):
[.ai/guidelines/offline-sync-contract.md](../../.ai/guidelines/offline-sync-contract.md) and
[../architecture/offline-sync-architecture.md](../architecture/offline-sync-architecture.md).

## What the Backend Confirms

- Invoice and refund upload endpoints are implemented
  (`POST /api/v1/desktop/invoices/upload`, `POST /api/v1/desktop/refunds/upload`).
- Shift and cash-drawer APIs are implemented (exact routes: `TODO`).
- Bootstrap and license validation are implemented.
- An offline sync contract is documented backend-side (governing idempotency, conflicts, and
  related behavior) — this repo has not yet imported that document verbatim; the rules below are
  as communicated for this repo's implementation and should be reconciled against the backend's
  own sync-contract document when available.

## Relevant Error Codes for Sync

| Code | Meaning |
|---|---|
| `IDEMPOTENCY_CONFLICT` | The idempotency key was reused with a different payload than originally sent — treat as `conflict`, preserve both sides for review, do not auto-retry |
| `VALIDATION_FAILED` | Payload rejected — check `errors` for field-level detail; stale price or stock 422s become terminal `rejected` records with recovery guidance |
| `FEATURE_NOT_ENABLED` | Feature/endpoint not enabled for this tenant/license — may indicate a pause condition depending on which endpoint |
| `SHIFT_ALREADY_OPEN` / `SHIFT_NOT_OPEN` / `SHIFT_CLOSED` / `SHIFT_PAUSED` / `SHIFT_NOT_PAUSED` | Shift-state conflicts — a queued shift-related sync may need to reconcile local shift state against these before retrying |

## Ordering Requirement

A refund upload must reference an already-synced invoice (i.e. the invoice must have a
`remote_uuid` recognized by the backend) — uploading a refund before its invoice has synced is
expected to fail or be rejected. The client is responsible for sequencing these correctly (see
"Invoice Before Refund Ordering" in
[.ai/guidelines/offline-sync-contract.md](../../.ai/guidelines/offline-sync-contract.md)) rather
than relying on the backend to queue them itself.

## Unknowns (`TODO`)

- Exact idempotency key mechanism expected by the backend (header name vs. body field, format).
- Exact response shape/fields for a stale-price or oversell condition on invoice upload.
- Whether the backend exposes a batch/bulk sync endpoint or only per-record upload.
- Heartbeat (`POST /api/v1/desktop/device/heartbeat`) payload/response and its relationship (if any) to
  sync scheduling.

Confirm against the backend's offline sync contract document / OpenAPI import before finalizing
the Phase 4 sync worker implementation.
