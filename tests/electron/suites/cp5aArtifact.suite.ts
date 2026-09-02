import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { deepEqual, equal } from 'node:assert/strict'
import {
  buildCp5aArtifact,
  cp5aArtifactHash,
  CP5A_EMITTING_SUITE,
  CP5A_SCHEMA_VERSION
} from '../support/cp5aScenario'
import { databaseTest } from '../support/sandbox'

const fixturePath = resolve(process.cwd(), 'tests/fixtures/desktop-committed-invoice-payload.json')

interface StoredArtifact {
  readonly schemaVersion: number
  readonly generatedFrom: { readonly repo: string; readonly commit: string }
  readonly emittingSuite: string
  readonly sha256: string
  readonly fixtureContext: unknown
  readonly payload: unknown
}

/**
 * Plan §6.4: "A CP-5a assertion recomputes the hash from a freshly committed sale and fails on
 * drift." This is that assertion — it never trusts the on-disk file's own claims about itself. It
 * re-runs the exact same deterministic scenario the generator (`scripts/generateCp5aArtifact.ts`)
 * ran, through the same shared `buildCp5aArtifact()`, and requires the result to be byte-identical
 * to what is committed on disk, both in content and in independently recomputed hash. A
 * hand-edited fixture, a stale regeneration, or a silent behavior change in `LocalSaleService`/
 * `buildUploadPayload` all fail this test the same way: a hash or content mismatch.
 */
databaseTest(
  'the committed CP-5a fixture is byte-identical to a freshly committed sale, never hand-authored',
  (sandbox) => {
    const stored = JSON.parse(readFileSync(fixturePath, 'utf8')) as StoredArtifact
    const fresh = buildCp5aArtifact(sandbox)
    const freshHash = cp5aArtifactHash(fresh.fixtureContext, fresh.payload)

    equal(stored.schemaVersion, CP5A_SCHEMA_VERSION)
    equal(stored.emittingSuite, CP5A_EMITTING_SUITE)
    deepEqual(stored.fixtureContext, fresh.fixtureContext)
    deepEqual(stored.payload, fresh.payload)
    equal(stored.sha256, freshHash)
  }
)
