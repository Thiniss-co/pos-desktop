// Phase 3F CP-5a (plan §6.4): generates `tests/fixtures/desktop-committed-invoice-payload.json`
// from one deterministic, real, atomically-committed sale — never a hand-authored sample. Mirrors
// `GeneratePosCalculatorGoldenFixture.php`'s provenance/hash shape. Run via:
//   node scripts/runElectronNode.mjs scripts/generateCp5aArtifact.ts
// `tests/electron/suites/cp5aArtifact.suite.ts` independently re-runs the same scenario
// (`buildCp5aArtifact`, shared by both) and fails on any drift from what this script wrote.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  buildCp5aArtifact,
  cp5aArtifactHash,
  CP5A_EMITTING_SUITE,
  CP5A_SCHEMA_VERSION
} from '../tests/electron/support/cp5aScenario'
import { createSandbox } from '../tests/electron/support/sandbox'

const outputPath = resolve(process.cwd(), 'tests/fixtures/desktop-committed-invoice-payload.json')

function currentCommit(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd() }).toString().trim()
}

const sandbox = createSandbox()

try {
  const { fixtureContext, payload } = buildCp5aArtifact(sandbox)
  const sha256 = cp5aArtifactHash(fixtureContext, payload)

  const artifact = {
    schemaVersion: CP5A_SCHEMA_VERSION,
    generatedFrom: { repo: 'pos-desktop', commit: currentCommit() },
    emittingSuite: CP5A_EMITTING_SUITE,
    fixtureContext,
    payload,
    sha256
  }

  writeFileSync(outputPath, JSON.stringify(artifact, null, 2) + '\n')
  console.log(`CP-5a artifact written to ${outputPath}`)
  console.log(`sha256: ${sha256}`)
} finally {
  sandbox.dispose()
}
