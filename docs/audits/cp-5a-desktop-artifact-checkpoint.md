# CP-5a Desktop Artifact Generation Checkpoint (narrow substep)

Date: 2026-08-29

Scope: desktop CP-5a only — generating `tests/fixtures/desktop-committed-invoice-payload.json`
from one deterministic, really-committed sale, plus the drift-detection test and
`verifyFixtureParity.mjs` extension the plan requires alongside it. **Per plan §6.4/the CP-5a
checkpoint definition itself: "Completing CP-5a does not mean the verification gate passed."** This
checkpoint is explicitly narrow and explicitly does not claim more than it proves.

## Result

- `tests/electron/support/cp5aScenario.ts` (new, sanctioned support module): `buildCp5aArtifact(sandbox)`
  runs the one deterministic scenario — a tracked line (2.000 units) consuming a real allocation
  grant, one cash payment, fixed clock (`2026-01-01T02:00:00.000Z`) and fixed, namespaced UUID
  sequences (never `crypto.randomUUID()`) — through the real `LocalSaleService.complete()`, then
  reads back the **actual** `sync_queue.payload_json` row it produced (never a separately
  reconstructed approximation) and returns it alongside a `fixtureContext` describing the
  company/device/branch/warehouse/product/payment-method/allocation the sale was built against, so
  a backend seed can reproduce equivalent records. `cp5aArtifactHash()` mirrors
  `verifyFixtureParity.mjs`'s own canonicalization exactly (sorted object keys, array order kept).
- `scripts/generateCp5aArtifact.ts` (new, run via `node scripts/runElectronNode.mjs
  scripts/generateCp5aArtifact.ts`): calls `buildCp5aArtifact()`, stamps `generatedFrom: {repo:
  'pos-desktop', commit: <git rev-parse HEAD>}` (excluded from the hash, exactly like
  `GeneratePosCalculatorGoldenFixture.php`'s own `generatedFrom` — so the hash stays stable across
  commits that don't change the actual scenario), and writes the fixture.
- `tests/electron/suites/cp5aArtifact.suite.ts` (new, registered in `tests/electron/index.ts`):
  the "assertion recomputes the hash from a freshly committed sale and fails on drift" the plan
  requires. It reads the on-disk fixture, calls the **same** `buildCp5aArtifact()` the generator
  used, and asserts the freshly-produced `fixtureContext`/`payload` and independently recomputed
  hash are byte-identical to what's on disk. A hand-edited fixture, a stale regeneration after a
  behavior change in `LocalSaleService`/`buildUploadPayload`, or a logic drift in the scenario
  itself would all fail this test the same way. Passes `electronHarnessIntegrity.test.ts`'s three
  structural checks (registered in `index.ts`, uses `databaseTest(`, constructs repositories only
  through `realRepositories()`, no direct `openDatabase`/`runMigrations`/`new Database` outside
  their sanctioned files) without needing any exception carved out for it.
- `scripts/verifyFixtureParity.mjs` extended with a fourth artifact check
  (`desktop-committed-invoice-payload.json`), using its own hash shape
  (`{schemaVersion, emittingSuite, fixtureContext, payload}` — it has no `calculationVersion`/
  `cases`, so it could not reuse the existing three artifacts' `manifestHash`). Verifies the
  desktop-side file's hash independently, then checks for a byte-identical `pos-backend` copy.

## An error caught while building this, before it reached the committed fixture

The first generated fixture had `local_invoice_uuid` and the tracked line's
`local_consumption_uuid` **coincidentally equal** — both `LocalSaleService.createUuid` and
`StockAllocationService.createUuid` were given independent `fixedUuidSequence()` counters that
each start at 1, so their first calls produced the identical literal string. Nothing was
functionally wrong (the two are still genuinely distinct database rows, correctly linked by real
foreign keys — this was a fixture-clarity problem, not a persistence bug), but a fixture meant to
teach BE-3F-2B engineers the wire shape should never show two conceptually unrelated identifiers as
the same value, since that is exactly the shape a real cross-entity id mix-up would take. Fixed by
namespacing each sequence's first UUID group digit (`fixedUuidSequence(1)` for allocations,
`fixedUuidSequence(2)` for the invoice/item/movement sequence) before regenerating. The
drift-detection test was written and run only after this fix, so it never had a chance to falsely
validate the collided version.

## Verification evidence

All commands actually executed, in this repository, after every change in this checkpoint:

| Command | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run lint` | PASS (0 errors, 0 warnings) |
| `npm run test` (vitest) | PASS — 596 tests, 85 files (unchanged from CP-4; no vitest-level code changed) |
| `npm run test:sqlite:electron` | PASS — 98 tests, 0 failures (97 from before + the new CP-5a drift-detection test) |
| `npm run smoke:database` | PASS |
| `npm run build` | PASS |
| `git diff --check` | PASS |
| `npm run verify:fixture` | **FAILS, as required by CP-5a's own definition** — the three pre-existing golden fixtures still pass; the new fourth artifact reports "self-consistent (hash verified) but has no pos-backend copy yet ... expected until BE-3F-2B lands; this is not a desktop-side defect." Exit code 1. This is the correct, expected state after CP-5a alone — it is not a regression and not silently hidden. |

## What changed

New:

- `tests/electron/support/cp5aScenario.ts`
- `scripts/generateCp5aArtifact.ts`
- `tests/electron/suites/cp5aArtifact.suite.ts` (1 test)
- `tests/fixtures/desktop-committed-invoice-payload.json` (the generated artifact)
- `docs/audits/cp-5a-desktop-artifact-checkpoint.md` (this file)

Modified:

- `scripts/verifyFixtureParity.mjs` — the fourth-artifact check described above.
- `tests/electron/index.ts` — registers `cp5aArtifact.suite`.

## Security boundary confirmation

No IPC channel, renderer file, or production main-process behavior was touched — every new file
here is test/fixture-generation infrastructure. No SQLite access was added outside the existing
main-process repository layer (the scenario reuses `realRepositories()`/`LocalSaleService`
unmodified). No new dependency was added. Nothing was staged, committed, or pushed.

## Explicitly deferred (per plan scope and CLAUDE.md §2 — no BE-* work from pos-desktop)

**BE-3F-2B is backend work and was not started, attempted, or even sketched from this session.**
Per the plan's own dependency chain (`BE-3F-2A → CP-5a → BE-3F-2B → CP-5b`) and CLAUDE.md's explicit
rule that "a pos-desktop session must not implement any BE-\* item," placing a copy of this
artifact into `pos-backend/tests/Fixtures/` and writing the integration tests that consume it
(validation, catalog proofs, `requires_reference`, attribution across all five §4.1 scenarios, exact
allocation consumption, post-close adjustment, atomic fault injection, two-device reservation
isolation, exact replay, changed-payload conflict) is explicitly out of scope for this session and
must happen in a `pos-backend` session. CP-5b (the final combined gate) depends on BE-3F-2B being
green and cannot start until then.
