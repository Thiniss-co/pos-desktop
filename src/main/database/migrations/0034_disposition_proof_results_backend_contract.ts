import type { DatabaseMigration } from '../migrator'

/**
 * PS6b integration — align `invoice_disposition_proof_results` with the backend's actual result.
 *
 * Migration 0013 required `(outcome = 'accepted') = (server_consumption_uuid IS NOT NULL)`, after
 * the plan (§7.3a.5 item 4). The backend as built never reports the server consumption UUID of an
 * accepted proof: `DispositionProofEvaluator` stores `server_consumption_uuid: null` for every proof
 * and the decision's own test asserts it. Under 0013 the first verified acceptance with an accepted
 * proof could not be recorded at all.
 *
 * The rebuilt CHECK keeps the direction that is still a real invariant — an overridden proof never
 * has a server consumption — and allows an accepted proof to carry either `null` (today's backend)
 * or a UUID (a backend that starts reporting it). Accepted local journal rows are still acknowledged
 * only through ordinary verified coverage, never by this table.
 *
 * Nothing in production wrote these tables before this migration (PS6b discovery was not wired), so
 * the copy below normally moves zero rows; it is a copy rather than a drop so that a test or
 * development database keeps whatever evidence it has.
 */
export const dispositionProofResultsBackendContractMigration: DatabaseMigration = {
  version: 34,
  name: 'disposition_proof_results_backend_contract',
  up(database): void {
    database.exec(`
      CREATE TABLE invoice_disposition_proof_results_v34 (
        invoice_local_uuid       TEXT NOT NULL REFERENCES invoice_disposition_applications(invoice_local_uuid),
        line_index               INTEGER NOT NULL CHECK (typeof(line_index)='integer' AND line_index >= 0),
        proof_index              INTEGER NOT NULL CHECK (typeof(proof_index)='integer' AND proof_index >= 0),
        allocation_uuid          TEXT NOT NULL,
        rights_generation        INTEGER NOT NULL CHECK (typeof(rights_generation)='integer' AND rights_generation >= 1),
        consumption_sequence     INTEGER NOT NULL CHECK (typeof(consumption_sequence)='integer' AND consumption_sequence >= 1),
        local_consumption_uuid   TEXT NOT NULL,
        quantity_milli           INTEGER NOT NULL CHECK (typeof(quantity_milli)='integer' AND quantity_milli >= 1),
        outcome                  TEXT NOT NULL CHECK (outcome IN ('accepted','overridden')),
        server_consumption_uuid  TEXT,
        override_reason          TEXT,
        created_at               TEXT NOT NULL,
        PRIMARY KEY (invoice_local_uuid, line_index, proof_index),
        CHECK (outcome = 'accepted' OR server_consumption_uuid IS NULL),
        CHECK ((outcome = 'overridden') = (override_reason IS NOT NULL))
      ) STRICT;

      INSERT INTO invoice_disposition_proof_results_v34 SELECT * FROM invoice_disposition_proof_results;
      DROP TABLE invoice_disposition_proof_results;
      ALTER TABLE invoice_disposition_proof_results_v34 RENAME TO invoice_disposition_proof_results;
    `)
  }
}
