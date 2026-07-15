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
pending -> syncing -> synced
                 \-> failed (retryable) -> pending
                 \-> conflict -> quarantined (needs resolution, does not silently retry forever)
                 \-> denied (license/subscription) -> paused (whole queue paused, not just this item)
```

- `pending`: created locally, not yet sent.
- `syncing`: in flight.
- `synced`: backend accepted it; local record stores the returned `remote_uuid`.
- `failed`: transient failure (network, 5xx) — retried with backoff, stays in the queue.
- `conflict`: backend rejected due to a data conflict (e.g. `IDEMPOTENCY_CONFLICT`) — moved to a
  quarantine state for explicit handling, not auto-retried indefinitely.
- `paused`: sync as a whole is paused, e.g. license/subscription denial — items stay queued, no
  data loss, but no further sync attempts until unblocked.

## Idempotency Keys

Every write sent through the sync queue carries a stable idempotency key generated at creation
time (not at send time), so retries after a partial failure (e.g. request sent, response lost) do
not create duplicate backend records. The backend's `IDEMPOTENCY_CONFLICT` code signals the key was
reused with a different payload — that is a `conflict` state, not a `failed` (retryable) one.

## Request Hash Conflicts

When a conflict is reported for a key whose payload differs from what's queued, do not silently
overwrite either side. Quarantine the item with both the local and reported-conflicting state
available for review, per the same rule as other `conflict` items.

## Invoice Before Refund Ordering

A refund referencing an invoice must not be synced before that invoice itself has synced (has a
`remote_uuid`). The sync queue processes dependent items in dependency order — a refund whose
invoice hasn't synced yet stays `pending`, not `failed`.

## Stale Price Quarantine

If a locally-queued sale used pricing/catalog data that the backend now considers stale (e.g. the
bootstrap snapshot was outdated), the backend response signals this and the item is quarantined for
review rather than force-accepted or silently discarded — the cashier already collected payment
against the local price, so data must be preserved, not dropped.

## Oversell Quarantine

If a queued sale would oversell inventory relative to backend-authoritative stock, the item is
quarantined the same way — not auto-rejected/deleted and not silently accepted. This is a business
decision (partial fulfillment, backorder, etc.) surfaced to a human, not resolved automatically by
the client.

## License/Subscription Denial Pauses Sync

If the backend denies sync due to license/subscription state, the entire sync queue transitions to
`paused` (not per-item `failed`) and the UI shows a clear license/grace warning
(`pos-ux-rules.md`). Local operation continues; only outbound sync is paused until the license
state is resolved.
