---
name: pos-local-database
description: Design or modify SQLite schema, migrations, and repositories for the pos-desktop app's local persistence layer.
---

# POS Local Database

## When to Use

- Adding/changing a SQLite table or column.
- Writing a new migration.
- Adding or modifying a repository for an entity.
- Reviewing whether local persistence follows the sync-field/tombstone rules.

## Rules

Full detail: `.ai/guidelines/local-database.md`.

- SQLite lives only in `src/main/database/` — never imported or opened from renderer code.
- Every schema change is a new, ordered migration run by the migration runner at startup — never
  hand-edited "current schema" SQL without a corresponding migration.
- One repository per entity; it is the only place that writes SQL for that entity.
- Syncable entities carry `local_uuid`, nullable `remote_uuid`, `sync_status`, `sync_attempts`,
  `last_sync_error`, `created_at`/`updated_at`.
- Queued sale/refund payloads are immutable once written — corrections are new records.
- Hard-delete only for never-synced (`remote_uuid IS NULL`) local-only records; anything synced is
  tombstoned (`deleted_at`/`is_deleted`), not hard-deleted, unless the backend contract explicitly
  says otherwise.

## Steps

1. Read `.ai/guidelines/local-database.md`.
2. Write the migration first (new file, next sequence number), not a schema edit in place.
3. Add/update the repository method(s) needed — keep SQL contained there.
4. If the entity is syncable, confirm all sync-status fields are present and wired into the sync
   service (`pos-offline-sync` skill).
5. Update `docs/architecture/local-database-architecture.md` if the schema shape or migration
   approach changes structurally.

## Verification

- `npm run typecheck`, `npm run lint`.
- Manually run the app (`npm run dev`) once against a fresh local DB file and confirm migrations
  apply cleanly from empty.
- Confirm an existing local DB (pre-migration) still upgrades cleanly if a migration is not the
  very first one.

## Common Mistakes

- Editing an already-applied migration instead of adding a new one (breaks anyone who already ran
  it).
- Putting SQL in an IPC handler instead of a repository.
- Forgetting `remote_uuid`/`sync_status` fields on a new syncable entity.
- Hard-deleting a synced record.
- Mutating a queued sale payload instead of writing a correcting record.
