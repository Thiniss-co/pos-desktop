# Local Database Rules

## SQLite in Main Process Only

The SQLite connection lives in `src/main/database/` (target path). No renderer code opens a
database connection, imports a SQLite driver, or receives a raw connection/handle across IPC.

## Migration Runner Required

- Schema changes go through an ordered, versioned migration runner (applied on app startup before
  any repository is used), not ad hoc `CREATE TABLE IF NOT EXISTS` scattered across the codebase.
- Each migration is a single forward step; the runner tracks which migrations have applied
  (e.g. a `schema_migrations` table) so upgrades between installed versions are safe.

## Repositories Own SQL

- One repository per entity (e.g. `SaleRepository`, `ShiftRepository`, `CatalogRepository`), each
  the only place that writes SQL for that entity.
- IPC handlers call repositories; they do not embed SQL themselves.
- No raw SQL crosses the IPC boundary in either direction (see `electron-security.md`,
  `ipc-contracts.md`).

## `remote_uuid` vs `local_uuid`

- Every syncable entity has a `local_uuid` (generated client-side at creation, primary identity
  until synced) and a nullable `remote_uuid` (set once the backend accepts it and returns its
  identity).
- Foreign-key-style references between local entities use `local_uuid` until both sides are
  synced; once synced, `remote_uuid` is available for reconciliation with backend-driven data
  (e.g. reports pulled from the backend).

## Immutable Queued Sale Payloads

- The payload of a queued sale (or refund) — what was actually charged, at what price, with what
  tax — is written once and never mutated afterward. Corrections (voids, adjustments) are new
  records referencing the original, never in-place edits.
- This preserves an accurate audit trail and avoids the sync queue sending a payload that no longer
  matches what the cashier/customer agreed to.

## Sync Status Fields

Every syncable entity carries at minimum:

| Field | Purpose |
|---|---|
| `local_uuid` | Stable local identity |
| `remote_uuid` | Nullable; set once synced |
| `sync_status` | `pending \| uploading \| synced \| retryable_error \| conflict \| rejected` (see `offline-sync-contract.md`) |
| `sync_attempts` | Retry count, for backoff/diagnostics |
| `last_sync_error` | Nullable, last failure/conflict detail (code + message), for support/diagnostics |
| `created_at` / `updated_at` | Local timestamps |

## Tombstone Behavior

Entities that can be locally "removed" (e.g. a draft cart, an unsent queue item still in
`pending`) are hard-deleted only while still local-only (`remote_uuid IS NULL` and never
synced). Anything that has ever synced is soft-deleted (tombstoned: a `deleted_at`/`is_deleted`
flag), preserving the record for audit and for correct reconciliation if the backend still
references it.

## No Hard Delete for Synced Entities Locally Unless Contract Allows

Once an entity has a `remote_uuid` (has synced), it may not be hard-deleted from local SQLite
unless the backend contract explicitly defines a delete/void flow that says otherwise
(`docs/backend-contract/`, marked `TODO` until confirmed). Default assumption: tombstone, don't
delete.
