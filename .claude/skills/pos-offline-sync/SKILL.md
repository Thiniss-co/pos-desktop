---
name: pos-offline-sync
description: Implement or modify the offline sync queue — state transitions, idempotency, conflict/quarantine handling — for the pos-desktop app.
---

# POS Offline Sync

## When to Use

- Implementing or modifying the sync queue (sale/refund/shift-event upload).
- Handling backend conflict/denial responses (`IDEMPOTENCY_CONFLICT`, license-denied sync, stale
  price, oversell).
- Adding a new syncable entity type.
- Building the sync status UI (indicator, paused-reason display).

## Rules

Full detail: `.ai/guidelines/offline-sync-contract.md`, `.ai/guidelines/local-database.md`.

- Local-first: every user action writes to SQLite and updates the UI before any network call.
- State machine is fixed: `pending → syncing → synced`, with `failed` (retryable),
  `conflict` (quarantined, not auto-retried), and `paused` (whole queue, e.g. license denial) as
  the only other states. Don't invent new states without updating the guideline doc.
- Idempotency keys are generated at record-creation time, not at send time.
- A refund never syncs before its invoice has a `remote_uuid`.
- Stale-price and oversell conditions from the backend quarantine the item — never silently
  discard or silently force-accept.
- License/subscription denial pauses the entire queue, not just the offending item.

## Steps

1. Read `.ai/guidelines/offline-sync-contract.md` fully — the state machine and ordering rules are
   easy to get subtly wrong.
2. Identify which entity/table this change affects; confirm it already has the sync-status fields
   from `.ai/guidelines/local-database.md` (`local_uuid`, `remote_uuid`, `sync_status`,
   `sync_attempts`, `last_sync_error`).
3. Implement the transition in the sync service (main process or a dedicated sync module) — never
   duplicate the state machine logic in the renderer.
4. Surface queue state to the UI via `window.posApi.sync.getStatus()` /
   `onStatusChange` — see `ipc-contracts.md`.
5. Update `docs/architecture/offline-sync-architecture.md` if the flow itself changes (not just an
   entity being added).

## Verification

- `npm run typecheck`, `npm run lint`.
- Unit tests for the specific transition added/changed, once a test runner exists
  (`.ai/guidelines/testing-and-verification.md`).
- Manual: simulate offline (disconnect network) and confirm the action still completes locally and
  queues correctly; reconnect and confirm it syncs.

## Common Mistakes

- Retrying a `conflict` item automatically instead of quarantining it.
- Sending a refund before its invoice has synced.
- Treating a license-denied response as a per-item `failed` instead of pausing the whole queue.
- Generating the idempotency key at send time (breaks retry-after-partial-failure safety).
- Mutating a queued sale payload in place instead of creating a correcting record.
