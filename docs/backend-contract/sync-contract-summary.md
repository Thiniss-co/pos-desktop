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
| `VALIDATION_ERROR` | Payload rejected — check `errors` for field-level detail; stale price or stock 422s become terminal `rejected` records with recovery guidance. (Earlier revisions of this file called it `VALIDATION_FAILED`; the backend emits `VALIDATION_ERROR`.) |
| `DESKTOP_CATALOG_REVISION_INVALID` | The catalog or per-line revision is stale — terminal `rejected`; refresh and create a corrective record, never mutate the original |
| `DESKTOP_ALLOCATION_PROOF_REQUIRED` | A tracked line arrived without allocation proof — terminal `rejected` |
| `DESKTOP_LEGACY_CONTRACT_UNSUPPORTED` | The client sent a legacy v1 payload after the server-configured cutoff — terminal `rejected`, app upgrade required |
| `DESKTOP_HISTORICAL_STOCK_TRACKING_UNVERIFIABLE` | The server cannot determine, from the catalog contract this invoice names, whether a line's product counted stock when the sale was rung — terminal `rejected`. Never the client's fault: nothing in the payload asserts trackedness, and no resend or client-side change can supply evidence the server never recorded. Not disposition-eligible, and not the same as a tenant still awaiting its tracking baseline, which answers a retryable `SERVICE_UNAVAILABLE` |
| `DESKTOP_HISTORICAL_ATTRIBUTION_FORBIDDEN` | The `shift_uuid` is unknown to this company **or** belongs to another device — deliberately one opaque response for both; terminal `rejected` |
| `FEATURE_NOT_ENABLED` | Feature/endpoint not enabled for this tenant/license — may indicate a pause condition depending on which endpoint |
| `DESKTOP_SHIFT_ALREADY_OPEN` / `DESKTOP_SHIFT_NOT_OPEN` / `DESKTOP_SHIFT_ALREADY_PAUSED` / `DESKTOP_SHIFT_NOT_PAUSED` / `DESKTOP_SHIFT_ACTIVE_PAUSE_NOT_FOUND` | Shift-state conflicts — a queued shift-related sync may need to reconcile local shift state against these before retrying |

## Ordering Requirement

A refund upload must reference an already-synced invoice (i.e. the invoice must have a
`remote_uuid` recognized by the backend) — uploading a refund before its invoice has synced is
expected to fail or be rejected. The client is responsible for sequencing these correctly (see
"Invoice Before Refund Ordering" in
[.ai/guidelines/offline-sync-contract.md](../../.ai/guidelines/offline-sync-contract.md)) rather
than relying on the backend to queue them itself.

## Resolved against backend source (CP-3G-1, verified at pos-backend `2bcce42`)

- **Idempotency mechanism** — a **body field**, `idempotency_key` (`string`, `max:255`); there is no
  idempotency header. The desktop sends `idempotency_key === local_invoice_uuid ===
  local_invoices.local_uuid`. Backend uniqueness: `(company_id, idempotency_key)` and
  `(company_id, desktop_device_id, local_invoice_uuid)`.
- **Replay vs conflict** — identical payload replayed → **HTTP 200 `DESKTOP_INVOICE_ALREADY_UPLOADED`**
  with the original invoice body (a success, not an error). Same key with a different payload, or the
  same `local_invoice_uuid` under a different key → **HTTP 409 `IDEMPOTENCY_CONFLICT`**. The server's
  `request_hash` is PHP `json_encode` property order and **must never be reproduced in TypeScript**.
- **Stale price / catalog** — **HTTP 422 `DESKTOP_CATALOG_REVISION_INVALID`**; oversell without
  allocation proof is **422 `DESKTOP_ALLOCATION_PROOF_REQUIRED`**. Both are terminal.
- **Historical stock tracking** — a sale is classified by the catalog contract it names, so a
  product's `track_stock` changing after issuance never reinterprets a completed sale. Where the
  server cannot establish what the contract issued, it answers **422
  `DESKTOP_HISTORICAL_STOCK_TRACKING_UNVERIFIABLE`** (terminal) rather than guessing. While a
  tenant's tracking baseline is still being built it answers **503 `SERVICE_UNAVAILABLE`**, which
  is retryable — the two must not be conflated, or a rollout window would permanently reject a
  good sale.
- **Batch endpoint** — **none exists.** Upload is strictly one invoice per request; do not invent a
  bulk route.
- **Authority** — `desktop.context:sync,pos,pos.invoice.upload`. Access `sync`, feature `pos`,
  permission `pos.invoice.upload`; **`pos.sell` is not required**. The v2 body carries
  `client_contract_version: 2` and `shift_uuid`, and a **closed shift is legal** (the server appends
  an immutable post-close adjustment). No open shift is required on the v2 path.

### Known drift in the backend's own documentation

`pos-backend/docs/architecture/desktop-offline-sync-contract.md` §8 still describes the upload as
`(access sell, feature pos, permission pos.sell)` with "open shift required". That is stale — it
predates BE-3F-3. `routes/desktop.php`, `docs/api/desktop-api-contract.md` and the OpenAPI spec all
agree with the contract recorded above, and source wins. Recorded here rather than edited, because
this repository never modifies pos-backend.

## Quarantine and operator disposition (PS4/PS5/PS5b/PS6b, verified at pos-backend `b4c85cf`)

- A v3-family upload (v3, v5 mixed tax, v7 offers: a physical-presence authority) whose attached
  allocation proof the server refuses answers `DESKTOP_INVOICE_QUARANTINED` with exactly one
  `errors.quarantine_reason`. The register records it terminal `rejected` with that reason. The sale
  is not committed on the server; its upload record is kept with a verifiable request snapshot.
- An operator decides through `POST /invoices/dispositions` (`desktop.context:sync,inventory,
  inventory.manage`): `accept_without_proof` commits the sale under the ORIGINAL key and local UUID
  (overridden proofs become physical-presence remainder) and leaves the upload `processed`;
  `reject_permanently` commits nothing and leaves it `quarantined`. Both store one immutable result.
  This desktop has no UI for that decision.
- The register discovers the decision through `GET /invoices/sync-status?idempotency_keys[]=…`
  (1–50 of its own keys; same gate as the upload; a foreign key is `not_found`). An undecided
  quarantine returns `disposition: null`; a decided one returns the stored result verbatim.
- What the backend actually stores, which the desktop verifies against (source wins over the plan):
  - `result_hash` is SHA-256 of PHP `json_encode` (default flags) of the result in the backend's
    insertion order. On MySQL the JSON column re-sorts keys on read, so the desktop re-encodes the
    strictly parsed result in schema order with PHP's `\/` and `\uXXXX` escaping.
  - `proof_results[]` is grouped by allocation identity (first appearance), then ordered by
    consumption sequence — not frozen line order.
  - An accepted proof carries `server_consumption_uuid: null` (the plan expected a UUID); desktop
    migration 0034 accepts that. An overridden proof never carries one.
  - `coverage[]` is this invoice's accepted prefix per identity (`accepted_chain_hash: null`) and
    `required_holds[]` names each identity's first overridden sequence.

## Unknowns (`TODO`)

- Heartbeat (`POST /api/v1/desktop/device/heartbeat`) payload/response and its relationship (if any) to
  sync scheduling.
- Whether a successful upload response will ever carry acknowledged allocation-consumption
  identities. It does not today (`DesktopInvoiceResource` returns none), which is why
  `local_stock_allocation_consumptions` stays `pending` after a successful upload.
