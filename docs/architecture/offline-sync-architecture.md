# Offline Sync Architecture

Rules: [.ai/guidelines/offline-sync-contract.md](../../.ai/guidelines/offline-sync-contract.md).
Not implemented yet — target design for Phase 4, described here so Phase 1-3 code (schema, API
client) is built compatible with it.

## Components (target)

```mermaid
flowchart LR
    subgraph Main Process
        Queue["Sync Queue Repository\n(SQLite: sync_status per record)"]
        Worker["Sync Worker\n(background loop)"]
        Client["API Client (main-side)"]
    end
    Backend[("Laravel Backend\n/api/v1/desktop/*")]
    Renderer["Renderer\n(sync status UI)"]

    Queue <--> Worker
    Worker <--> Client
    Client <--> Backend
    Worker -->|"posApi.sync.onStatusChange"| Renderer
```

The sync worker runs in the main process (it needs SQLite + network + to survive independent of
any single renderer window state) and pushes status updates to the renderer via an IPC event, not
polling from the renderer side.

## State Machine

```mermaid
stateDiagram-v2
    [*] --> pending: record created locally
    pending --> uploading: worker picks it up
    uploading --> synced: backend accepts (2xx + success envelope)
    uploading --> retryable_error: transient error (network, 5xx)
    retryable_error --> pending: retry after backoff
    uploading --> conflict: IDEMPOTENCY_CONFLICT or data conflict
    uploading --> rejected: terminal stale-price, stock, or validation 422
```

`conflict` and `rejected` are terminal persisted states — the worker does not silently retry them.
License or token denial pauses the worker operationally without adding a persisted per-item state.

## Ordering Rules

- The worker processes `pending` items respecting dependency order: a refund with an unsynced
  parent invoice stays `pending` (skipped, not `retryable_error`) until the invoice reaches `synced`.
- Idempotency keys are assigned at record-creation time (in the repository, not the worker), so a
  retry after a lost response reuses the same key safely.

## Conflict and Rejection Handling

`conflict` items are surfaced in a dedicated UI (sync/queue screen) with enough detail (local
payload, backend-reported reason/code) for a human decision — the worker never guesses a
resolution. This keeps financial data (a completed sale, a refund) from ever being silently
dropped or silently overwritten.

Stale-price and oversell responses are terminal `rejected` records after a 422 response. Preserve
the immutable local payload and guide staff to refresh data, reconcile the sale or inventory, and
create a corrective follow-up rather than editing the original queue item.

## License-Denial Pause

A `FEATURE_NOT_ENABLED`, license-invalid, or subscription-denied response on any sync attempt
pauses the **worker**, not just the one item — the worker stops attempting further syncs until a
license re-check succeeds. Existing queue records retain their persisted state.

## Renderer Visibility

The renderer never talks to the backend directly for sync — it only observes state via
`window.posApi.sync.getStatus()` / `onStatusChange`, per
[.ai/guidelines/ipc-contracts.md](../../.ai/guidelines/ipc-contracts.md), and renders the
offline/sync indicators described in
[.ai/guidelines/pos-ux-rules.md](../../.ai/guidelines/pos-ux-rules.md).
