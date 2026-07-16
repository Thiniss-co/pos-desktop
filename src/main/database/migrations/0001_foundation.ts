import type { DatabaseMigration } from '../migrator'

export const foundationMigration: DatabaseMigration = {
  version: 1,
  name: 'foundation',
  up(database) {
    database.exec(`
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE device_identity (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        device_uuid TEXT NOT NULL UNIQUE,
        device_name TEXT NOT NULL,
        platform TEXT NOT NULL,
        os_version TEXT NOT NULL,
        app_version TEXT NOT NULL,
        registered_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE secure_secrets (
        key TEXT PRIMARY KEY,
        encrypted_value BLOB NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE auth_session_metadata (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        user_name TEXT,
        user_email TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE license_state_metadata (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        status TEXT NOT NULL DEFAULT 'unknown',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE bootstrap_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        is_complete INTEGER NOT NULL DEFAULT 0 CHECK (is_complete IN (0, 1)),
        updated_at TEXT
      );

      CREATE TABLE sync_queue (
        local_queue_uuid TEXT PRIMARY KEY,
        aggregate_type TEXT NOT NULL,
        local_aggregate_uuid TEXT NOT NULL,
        operation TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('pending', 'uploading', 'synced', 'retryable_error', 'conflict', 'rejected')),
        dependency_queue_uuid TEXT REFERENCES sync_queue(local_queue_uuid),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        next_attempt_at TEXT,
        upload_lease_at TEXT,
        last_error_code TEXT,
        last_error_details TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE sync_conflicts (
        local_queue_uuid TEXT PRIMARY KEY REFERENCES sync_queue(local_queue_uuid),
        conflict_code TEXT NOT NULL,
        local_payload_json TEXT NOT NULL,
        reported_details TEXT,
        created_at TEXT NOT NULL
      );
    `)
  }
}
