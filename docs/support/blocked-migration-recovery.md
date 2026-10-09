# Recovering a till whose local data cannot be upgraded

**Never delete, move or recreate the till's database.** It holds every sale, refund and quick-created
record that has not reached the server yet, together with their idempotency keys. Deleting it loses
that money and those records for good, and a re-sent copy would carry new keys.

## When this applies

After an update the till does not start. Instead of the POS window it shows one error box, **"Thinis POS
could not start"**, in English and Arabic. The box gives the cashier's three steps (§1 below), the data
folder, the app version and a reason such as `FOREIGN KEY constraint failed` or `CHECK constraint
failed`. On Windows, Ctrl+C copies the box's text. Journey `tests/playwright/journeys/startupfail.mjs`
reproduces this with a real blocked upgrade, on the harness build and on the packaged till, and checks
that the failed start leaves every database file byte-identical.

Each schema upgrade runs inside a single transaction. When a stored row cannot be carried into the new
schema, the upgrade throws, everything is rolled back, and the database stays exactly as it was, at the
previous schema version. This was tested on purpose: `tests/electron/suites/v1UpgradeMigration.suite.ts`.
The till refuses to start rather than run on a half-upgraded database. Retrying fails in the same way
until the damaged row is repaired.

## Data folder

| System  | Folder                   |
| ------- | ------------------------ |
| Windows | `%APPDATA%\pos-desktop\` |
| Linux   | `~/.config/pos-desktop/` |

The database is `pos-desktop.sqlite`. Next to it there may be `pos-desktop.sqlite-wal` and
`pos-desktop.sqlite-shm`; they are part of the database.

## Procedure

### 1. Cashier or site

1. Close the till. Do not reinstall or uninstall it. Uninstalling keeps the data folder, but do not
   rely on that.
2. Copy the **whole** data folder, including the `-wal` and `-shm` files, to a USB drive or a support
   share. Name the copy with the date and the device.
3. Send support the copy, the exact error text and the app version being installed.

### 2. Support, working on a copy only

Use the official SQLite command-line tool (`sqlite3`, from sqlite.org). Work on a second copy, never
on the till.

```sql
-- Open the copy:  sqlite3 pos-desktop.sqlite
PRAGMA integrity_check;           -- expect: ok
PRAGMA foreign_key_check;         -- rows that point at a missing parent
SELECT MAX(version) FROM schema_migrations;   -- the schema the till is still on

-- Work that has not reached the server: these rows must survive the repair.
SELECT state, COUNT(*) FROM sync_queue GROUP BY state;   -- anything not 'synced' is still to upload
SELECT submission_state, COUNT(*) FROM local_refunds GROUP BY submission_state;
SELECT state, COUNT(*) FROM entity_create_outbox GROUP BY state;
```

The upgrade error and `foreign_key_check` name the table. For migration 0034 that is
`invoice_disposition_proof_results`: a proof row whose application or allocation identity no longer
exists, or a row breaking the overridden/accepted rule.

### 3. Repair

1. Before changing anything, take a record of the rows involved.
2. Repair on the copy. Restore the missing parent row from evidence if it is known. If the damaged row
   is a duplicate or a derived record, remove just that row.
3. **Never** touch `sync_queue.payload_json`, `idempotency_key`, `local_refunds.request_json`, the
   quick-create `canonical_payload_json`, the stock journal, or any row still waiting to upload.
4. Run `PRAGMA integrity_check;` and `PRAGMA foreign_key_check;` again: they must return `ok` and no
   rows.
5. Prove the upgrade works on the repaired copy before it goes back to the till. Install the new
   version on a support machine with an empty test profile, put the repaired copy in that profile's
   data folder, and start it there. It must open without the error.
6. Close the till. Put the repaired copy in its data folder, keeping the copy taken in step 1 for
   reference. Start the till.

Pending sales, refunds and quick-create records then upload with their original keys. The server
recognises any that it already holds, so nothing is applied twice.

### 4. When it cannot be repaired

Keep the original folder untouched and escalate to engineering with the copy. Do not hand the till out
with a fresh database while unsynced sales exist in the old one.
