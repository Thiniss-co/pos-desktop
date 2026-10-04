import type { DatabaseMigration } from '../migrator'

/**
 * POS improvements, Stage 2 — durable register quick-create (customers, suppliers, products).
 *
 * Additive only.
 *
 * - `local_customers` / `local_suppliers` / `local_products` — the register's own records, keyed by
 *   the entity uuid the server adopts. They live OUTSIDE the installed catalog tables, which a full
 *   catalog install replaces, and are merged into reads by uuid.
 * - `entity_create_outbox` — one row per create REQUEST. The frozen canonical payload is immutable.
 *   Dispatch evidence (`dispatch_count`, `first_dispatched_at`) is committed BEFORE any transport,
 *   so `pending` is positive proof the request never left this register (the reassignment rule).
 *   CHECKs and triggers enforce the state machine:
 *
 *     non-terminal: pending, dispatching, unknown, blocked_permission
 *     terminal:     accepted, refused, conflict, superseded
 *
 *     pending            -> dispatching (claim) | superseded (reassignment)
 *     dispatching        -> accepted | refused | conflict | blocked_permission | unknown
 *     unknown            -> dispatching (same key and bytes)
 *     blocked_permission -> dispatching (same key and bytes, after a fresh access check)
 *
 *   A refused/conflict row may record, once, the key of its corrected resubmission.
 * - `entity_create_audit` — append-only transition history (actor, from, to, reason).
 */
export const quickCreateMigration: DatabaseMigration = {
  version: 21,
  name: 'quick_create',
  up(database) {
    database.exec(`
      CREATE TABLE local_customers (
        uuid               TEXT PRIMARY KEY CHECK (length(uuid) = 36),
        company_uuid       TEXT NOT NULL CHECK (length(company_uuid) = 36),
        device_uuid        TEXT NOT NULL CHECK (length(device_uuid) BETWEEN 1 AND 64),
        creator_user_uuid  TEXT NOT NULL CHECK (length(creator_user_uuid) = 36),
        name               TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
        phone              TEXT CHECK (phone IS NULL OR length(phone) <= 50),
        email              TEXT CHECK (email IS NULL OR length(email) <= 255),
        tax_number         TEXT CHECK (tax_number IS NULL OR length(tax_number) <= 100),
        address            TEXT CHECK (address IS NULL OR length(address) <= 1000),
        notes              TEXT CHECK (notes IS NULL OR length(notes) <= 2000),
        search_name        TEXT NOT NULL,
        search_phone       TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      ) STRICT;
      CREATE INDEX idx_local_customers_search ON local_customers(company_uuid, search_name);

      CREATE TABLE local_suppliers (
        uuid               TEXT PRIMARY KEY CHECK (length(uuid) = 36),
        company_uuid       TEXT NOT NULL CHECK (length(company_uuid) = 36),
        device_uuid        TEXT NOT NULL CHECK (length(device_uuid) BETWEEN 1 AND 64),
        creator_user_uuid  TEXT NOT NULL CHECK (length(creator_user_uuid) = 36),
        name               TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
        contact_person     TEXT CHECK (contact_person IS NULL OR length(contact_person) <= 255),
        phone              TEXT CHECK (phone IS NULL OR length(phone) <= 50),
        email              TEXT CHECK (email IS NULL OR length(email) <= 255),
        tax_number         TEXT CHECK (tax_number IS NULL OR length(tax_number) <= 100),
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      ) STRICT;

      CREATE TABLE local_products (
        uuid               TEXT PRIMARY KEY CHECK (length(uuid) = 36),
        company_uuid       TEXT NOT NULL CHECK (length(company_uuid) = 36),
        device_uuid        TEXT NOT NULL CHECK (length(device_uuid) BETWEEN 1 AND 64),
        creator_user_uuid  TEXT NOT NULL CHECK (length(creator_user_uuid) = 36),
        name               TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
        sku                TEXT CHECK (sku IS NULL OR length(sku) <= 255),
        barcode            TEXT CHECK (barcode IS NULL OR length(barcode) <= 255),
        price_amount       INTEGER NOT NULL CHECK (typeof(price_amount) = 'integer' AND price_amount >= 0),
        currency           TEXT NOT NULL CHECK (length(currency) = 3),
        category_uuid      TEXT NOT NULL CHECK (length(category_uuid) = 36),
        tax_uuid           TEXT CHECK (tax_uuid IS NULL OR length(tax_uuid) = 36),
        tax_mode           TEXT NOT NULL CHECK (tax_mode IN ('none', 'inclusive', 'exclusive')),
        unit               TEXT CHECK (unit IS NULL OR length(unit) <= 50),
        track_stock        INTEGER NOT NULL CHECK (track_stock IN (0, 1)),
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      ) STRICT;

      CREATE TABLE entity_create_outbox (
        request_key                 TEXT PRIMARY KEY CHECK (length(request_key) = 36),
        entity_type                 TEXT NOT NULL CHECK (entity_type IN ('customer', 'supplier', 'product')),
        client_entity_uuid          TEXT NOT NULL CHECK (length(client_entity_uuid) = 36),
        company_uuid                TEXT NOT NULL CHECK (length(company_uuid) = 36),
        device_uuid                 TEXT NOT NULL CHECK (length(device_uuid) BETWEEN 1 AND 64),
        creator_user_uuid           TEXT NOT NULL CHECK (length(creator_user_uuid) = 36),
        canonical_payload_json      TEXT NOT NULL CHECK (length(CAST(canonical_payload_json AS BLOB)) <= 16384),
        payload_sha256              TEXT NOT NULL CHECK (length(payload_sha256) = 64),
        state                       TEXT NOT NULL CHECK (state IN (
                                      'pending', 'dispatching', 'unknown', 'blocked_permission',
                                      'accepted', 'refused', 'conflict', 'superseded')),
        lease_id                    TEXT,
        lease_expires_at            TEXT,
        dispatch_count              INTEGER NOT NULL DEFAULT 0
                                      CHECK (typeof(dispatch_count) = 'integer' AND dispatch_count >= 0),
        first_dispatched_at         TEXT,
        last_dispatched_at          TEXT,
        next_attempt_at             TEXT,
        server_entity_uuid          TEXT,
        result_code                 TEXT CHECK (result_code IS NULL OR length(result_code) <= 64),
        result_message              TEXT CHECK (result_message IS NULL OR length(result_message) <= 500),
        result_fields_json          TEXT CHECK (result_fields_json IS NULL OR length(result_fields_json) <= 4000),
        trace_id                    TEXT CHECK (trace_id IS NULL OR length(trace_id) <= 128),
        superseded_by_request_key   TEXT CHECK (superseded_by_request_key IS NULL OR length(superseded_by_request_key) = 36),
        resubmitted_as_request_key  TEXT CHECK (resubmitted_as_request_key IS NULL OR length(resubmitted_as_request_key) = 36),
        created_at                  TEXT NOT NULL,
        updated_at                  TEXT NOT NULL,

        -- Dispatch evidence: pending and superseded rows never left the register; every other state did.
        CHECK ((state IN ('pending', 'superseded')) = (dispatch_count = 0)),
        CHECK ((first_dispatched_at IS NOT NULL) = (dispatch_count >= 1)),
        -- A lease exists exactly while dispatching.
        CHECK ((state = 'dispatching') = (lease_id IS NOT NULL)),
        CHECK ((lease_id IS NULL) = (lease_expires_at IS NULL)),
        -- An accepted row carries the verified server identity, which is the register's own id.
        CHECK ((state = 'accepted') = (server_entity_uuid IS NOT NULL)),
        CHECK (server_entity_uuid IS NULL OR server_entity_uuid = client_entity_uuid),
        CHECK ((state = 'superseded') = (superseded_by_request_key IS NOT NULL)),
        CHECK (resubmitted_as_request_key IS NULL OR state IN ('refused', 'conflict'))
      ) STRICT;

      -- At most one LIVE request per entity identity (refused/conflict/superseded rows are history).
      CREATE UNIQUE INDEX idx_entity_create_outbox_live
        ON entity_create_outbox(entity_type, client_entity_uuid)
        WHERE state NOT IN ('superseded', 'refused', 'conflict');
      CREATE INDEX idx_entity_create_outbox_worker
        ON entity_create_outbox(company_uuid, device_uuid, creator_user_uuid, state, next_attempt_at);

      CREATE TRIGGER entity_create_outbox_no_delete
        BEFORE DELETE ON entity_create_outbox
        BEGIN SELECT RAISE(ABORT, 'entity_create_outbox rows are never deleted'); END;

      CREATE TRIGGER entity_create_outbox_frozen
        BEFORE UPDATE ON entity_create_outbox
        WHEN NEW.request_key IS NOT OLD.request_key
          OR NEW.entity_type IS NOT OLD.entity_type
          OR NEW.client_entity_uuid IS NOT OLD.client_entity_uuid
          OR NEW.company_uuid IS NOT OLD.company_uuid
          OR NEW.device_uuid IS NOT OLD.device_uuid
          OR NEW.creator_user_uuid IS NOT OLD.creator_user_uuid
          OR NEW.canonical_payload_json IS NOT OLD.canonical_payload_json
          OR NEW.payload_sha256 IS NOT OLD.payload_sha256
          OR NEW.created_at IS NOT OLD.created_at
          OR NEW.dispatch_count < OLD.dispatch_count
        BEGIN SELECT RAISE(ABORT, 'entity_create_outbox identity and payload are immutable'); END;

      CREATE TRIGGER entity_create_outbox_transition
        BEFORE UPDATE OF state ON entity_create_outbox
        WHEN NEW.state IS NOT OLD.state
          AND (OLD.state || '>' || NEW.state) NOT IN (
            'pending>dispatching', 'pending>superseded',
            'dispatching>accepted', 'dispatching>refused', 'dispatching>conflict',
            'dispatching>blocked_permission', 'dispatching>unknown',
            'unknown>dispatching', 'blocked_permission>dispatching')
        BEGIN SELECT RAISE(ABORT, 'illegal entity_create_outbox transition'); END;

      -- Claims add dispatch evidence: entering dispatching always increments dispatch_count.
      CREATE TRIGGER entity_create_outbox_claim_evidence
        BEFORE UPDATE OF state ON entity_create_outbox
        WHEN NEW.state = 'dispatching' AND OLD.state IS NOT 'dispatching'
          AND NEW.dispatch_count <> OLD.dispatch_count + 1
        BEGIN SELECT RAISE(ABORT, 'a claim must record dispatch evidence'); END;

      -- Terminal rows are history. The only change a refused/conflict row accepts is recording,
      -- once, the key of its corrected resubmission.
      CREATE TRIGGER entity_create_outbox_terminal
        BEFORE UPDATE ON entity_create_outbox
        WHEN OLD.state IN ('accepted', 'refused', 'conflict', 'superseded')
          AND NOT (
            OLD.state IN ('refused', 'conflict')
            AND NEW.state = OLD.state
            AND OLD.resubmitted_as_request_key IS NULL
            AND NEW.resubmitted_as_request_key IS NOT NULL
            AND NEW.result_code IS OLD.result_code
            AND NEW.dispatch_count = OLD.dispatch_count
            AND NEW.server_entity_uuid IS OLD.server_entity_uuid)
        BEGIN SELECT RAISE(ABORT, 'terminal entity_create_outbox rows are immutable'); END;

      CREATE TABLE entity_create_audit (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        request_key      TEXT NOT NULL REFERENCES entity_create_outbox(request_key),
        actor_user_uuid  TEXT,
        from_state       TEXT,
        to_state         TEXT NOT NULL,
        reason           TEXT CHECK (reason IS NULL OR length(reason) <= 200),
        related_request_key TEXT,
        at               TEXT NOT NULL
      ) STRICT;
      CREATE INDEX idx_entity_create_audit_request ON entity_create_audit(request_key, id);
      CREATE TRIGGER entity_create_audit_append_only_update
        BEFORE UPDATE ON entity_create_audit
        BEGIN SELECT RAISE(ABORT, 'entity_create_audit is append-only'); END;
      CREATE TRIGGER entity_create_audit_append_only_delete
        BEFORE DELETE ON entity_create_audit
        BEGIN SELECT RAISE(ABORT, 'entity_create_audit is append-only'); END;
    `)
  }
}
