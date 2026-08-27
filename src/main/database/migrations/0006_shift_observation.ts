import type { DatabaseMigration } from '../migrator'

export const shiftObservationMigration: DatabaseMigration = {
  version: 6,
  name: 'shift_observation',
  up(database) {
    database.exec(`
      CREATE TABLE session_epoch (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value INTEGER NOT NULL CHECK (typeof(value) = 'integer' AND value >= 1)
      );

      INSERT INTO session_epoch (id, value) VALUES (1, 1);

      CREATE TRIGGER session_epoch_only_increments
      BEFORE UPDATE OF value ON session_epoch
      FOR EACH ROW WHEN NEW.value != OLD.value + 1
      BEGIN
        SELECT RAISE(ABORT, 'session_epoch must increment by one');
      END;

      CREATE TABLE shift_observation (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        kind TEXT NOT NULL CHECK (kind IN ('none', 'shift', 'reconciliation_required')),
        shift_uuid TEXT,
        status TEXT CHECK (status IN ('open', 'paused', 'closed', 'cancelled')),
        company_uuid TEXT NOT NULL,
        device_uuid TEXT NOT NULL,
        user_uuid TEXT NOT NULL,
        session_epoch INTEGER NOT NULL,
        opened_at TEXT,
        observed_at TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('current', 'open', 'pause', 'resume', 'close')),
        CHECK ((kind = 'shift') = (shift_uuid IS NOT NULL)),
        CHECK ((kind = 'shift') = (status IS NOT NULL))
      );
    `)
  }
}
