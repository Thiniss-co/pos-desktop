# Offline Sync Contract Rules

## Local-First Behavior

Every user-facing action (add to cart, open shift, complete sale, issue refund) writes to local
SQLite first and updates the UI immediately. Network calls to sync that write happen afterward, in
the background, via the sync queue. The UI must remain fully usable with no network connectivity.

## Bootstrap Persistence

- On login/activation, `GET /api/v1/desktop/bootstrap` response (catalog, tax rules, pricing,
  permissions, feature flags, etc. — exact shape: `docs/backend-contract/desktop-api-summary.md`,
  marked `TODO` until confirmed against OpenAPI) is persisted to local SQLite, not just kept in
  memory.
- The app must be able to start and operate against the last-persisted bootstrap snapshot if the
  network is unavailable at launch.
- Re-bootstrap (refresh of the local snapshot) happens on a defined trigger (login, explicit
  refresh, or a sync signal) — not on every screen navigation.

## Sync Queue States

Each queued outbound record (sale, refund, shift event, etc.) moves through explicit states —
implementation detail lives in `local-database.md`; the state machine itself:

```txt
pending -> uploading -> synced
                  \-> retryable_error -> pending
                  \-> conflict (needs human resolution, does not silently retry forever)
                  \-> rejected (terminal validation/business rejection)
```

- `pending`: created locally, not yet sent.
- `uploading`: in flight.
- `synced`: backend accepted it; local record stores the returned `remote_uuid`.
- `retryable_error`: transient failure (network, 5xx) — retried with backoff, stays in the queue.
- `conflict`: backend rejected due to a data conflict (e.g. `IDEMPOTENCY_CONFLICT`) — requires
  explicit handling and is not auto-retried indefinitely.
- `rejected`: terminal validation or business rejection with recovery guidance; it is never retried
  automatically.

## Idempotency Keys

Every write sent through the sync queue carries a stable idempotency key generated at creation
time (not at send time), so retries after a partial failure (e.g. request sent, response lost) do
not create duplicate backend records. The backend's `IDEMPOTENCY_CONFLICT` code signals the key was
reused with a different payload — that is a `conflict` state, not a `retryable_error` one.

## Request Hash Conflicts

When a conflict is reported for a key whose payload differs from what's queued, do not silently
overwrite either side. Preserve both the local and reported-conflicting state for human review.

## Invoice Before Refund Ordering

A refund referencing an invoice must not be synced before that invoice itself has synced (has a
`remote_uuid`). The sync queue processes dependent items in dependency order — a refund whose
invoice hasn't synced yet stays `pending`, not `retryable_error`.

## Stale Price and Stock Rejection

If a locally-queued sale used pricing/catalog data that the backend now considers stale (e.g. the
bootstrap snapshot was outdated), the item reaches terminal `rejected` after the backend's 422
validation response. Preserve the original local payload and give staff a recovery path: refresh
the relevant data, reconcile the sale, then create a new corrective record rather than mutating
the original queued payload.

If a queued sale would oversell inventory relative to backend-authoritative stock, it is likewise
terminal `rejected` on the backend's 422 response. The app preserves the data and directs staff to
resolve fulfillment or inventory before recording a corrective follow-up; it never force-accepts
or silently drops the sale.

## License/Subscription Denial Pauses Sync

If the backend denies sync due to license/subscription state, the **worker** pauses operationally;
this is not a persisted per-item queue state. Items retain their existing persisted states, local
operation continues, and the UI shows a clear license/grace warning (`pos-ux-rules.md`) until a
license re-check allows the worker to resume.

## License and Entitlement Cadence

When online, validate the license at application start, after login, and at least every 12 hours.
Refresh entitlements at application start, after login, after a 403 response, and at least every
15 minutes. After 72 hours without a successful license check, backend-provided policy determines
whether the app can sell locally and whether the worker can sync; the renderer must display that
state rather than infer it. These are documented timing requirements only—no timer starts in the
foundation phase.
