# Phase 4 — Local Sale and Sync Queue

## Goal

Let a cashier complete a sale entirely offline, immutably recorded in local SQLite, then
implement the background sync worker that uploads it (and future queued records) to the backend
per the documented state machine.

## Scope

- Payment/tender modal completing a cart into an immutable local sale record (per
  [.ai/guidelines/local-database.md](../../.ai/guidelines/local-database.md)) with full sync-status
  fields.
- Sync queue repository + background sync worker in the main process, implementing the state
  machine in
  [.ai/guidelines/offline-sync-contract.md](../../.ai/guidelines/offline-sync-contract.md) and
  [../architecture/offline-sync-architecture.md](../architecture/offline-sync-architecture.md):
  `pending → syncing → synced`, `failed` retry/backoff, `conflict` quarantine, `paused` on license
  denial.
- Idempotency key generation at sale-creation time.
- `POST /api/v1/desktop/invoices/upload` integration.
- Sync indicator (shell-level) now reflecting real queue state (pending count, syncing, paused +
  reason).
- Quarantine review UI (minimal — list of conflicted items with enough detail to act on).

## Out of Scope

- Refunds (Phase 5 — depends on invoices already syncing correctly here).
- Receipt printing (Phase 5).
- Full hardening/packaging polish (Phase 6).

## Deliverables

- A completed sale survives app restart and eventually syncs once online, verified against the
  real backend invoice-upload endpoint.
- Simulated conflict (e.g. resending a completed sale's idempotency key with a different payload,
  if feasible in a test/staging environment) correctly quarantines rather than duplicating or
  crashing.
- Simulated license denial pauses the entire queue, verified via the sync indicator.

## Verification Commands

```bash
npm run typecheck
npm run lint
npm run test              # state-machine transition tests per offline-sync-contract.md
npm run dev                  # manual: complete a sale offline, go online, confirm it syncs
```

## Done Criteria

- Sync queue state machine has test coverage for every transition listed in
  `.ai/guidelines/offline-sync-contract.md`.
- A sale completed with no network connection is not lost and syncs automatically once
  connectivity returns.
- License-denial pause is queue-wide, not per-item, verified manually or via test.

## Next Phase

[05-refunds-receipts-printing.md](05-refunds-receipts-printing.md) — refund flow, receipt
rendering, print/reprint.
