# CP3 audit — desktop durable preparation and bounded dependencies

**Parent baseline:** `pos-desktop` `6f126d83c72bc8df0c11c8ab60ec4d88630074bf`, worktree clean and
index empty at start of this execution.
**Backend counterparts:** CP2 `fee48ec635d77e537fc560eff4875779e7e72d6e`,
CP2U `58dc24dd3b3a8ac0b62f3d294aeed26c8e3aa669`.
**Design record:** `docs/architecture/cp3-desktop-offline-stock-preparation.md`.

No production code path calls `PreparationService.runCycle()` yet. CP4 owns the reconnect
orchestration, IPC, and readiness UI that will.

---

## 1. Source manifest

22 changed paths (9 modified, 13 added), excluding this audit. Manifest algorithm as plan §1.8.1 —
paths sorted lexically, GNU `sha256sum` lines, hashed:

```
40ff9afb51ce1366b99c992320c5351caa299b56e88fa15b8ae8279ea642e8cd
```

Recorded before the gate results below.

---

## 2. Executed gates

| Gate                          | Command                                | Result                                                        |
| ----------------------------- | -------------------------------------- | ------------------------------------------------------------- |
| Real Electron SQLite          | `npm run test:sqlite:electron`         | **318 registered — 284 passed, 0 failed, 34 skipped**         |
| Unit suite                    | `npm run test` (Vitest)                | **106 files, 957 tests, 957 passed, 0 failed**                |
| Types                         | `npm run typecheck` (tsc + vue-tsc)    | clean                                                         |
| Cross-language fixture parity | `npm run verify:fixture`               | **7/7 byte-identical to `pos-backend`**                       |
| Harness safety and lifecycle  | `npm run test:cp3g5-harness`           | **0 failed, 0 skipped**                                       |
| Format                        | `npx prettier --check <changed files>` | clean                                                         |
| Lint (repository-wide)        | `npx eslint --no-cache .`              | **FAILS, exit 1 — 9 problems (2 errors, 7 warnings)**; see §5 |

The **34 skips are pre-existing live-backend skips**, unchanged by CP3 and unrelated to it. **270 was
the previously recorded pass count at 304 registered; CP3 adds 14 tests, all passing.** No skipped
test is reported as an executed pass.

CP3 adds:

- 8 real-Electron-SQLite cases (2 suites): populated migration and backfill, frozen-byte
  immutability, anchor immutability, terminal states, the granted/zero link constraint, migration
  rollback, and 6 lifecycle scenarios including a genuine restart across two connections.
- 24 Vitest cases (3 files): canonical request identity, the §5.4 completeness predicate including
  every forbidden inference, and the §7.2 dependency partition.

---

## 3. Plan scenarios covered by name

| Plan reference                                                | Covered by                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------------- |
| §5.3 canonical bytes, key order, hash                         | `preparationRequest.test.ts`                                        |
| §5.3 two eligible sets never hash alike                       | `preparationRequest.test.ts`                                        |
| §5.4 completeness predicate, all six conditions               | `preparationCompleteness.test.ts`                                   |
| §5.4 forbidden inferences                                     | `preparationCompleteness.test.ts`                                   |
| §5.6 stale policy revision is terminal, creates nothing       | `preparationLifecycle.suite.ts`                                     |
| §6.7 partial discovery cannot close a multi-product operation | `preparationLifecycle.suite.ts`                                     |
| §6.8 a blocked product does not hold back an unrelated one    | `preparationLifecycle.suite.ts` + `preparationDependencies.test.ts` |
| §7.1 retained `synced` history blocks nothing                 | `preparationDependencies.test.ts`                                   |
| §7.2 bounded queue high-water and backfill                    | `preparationSchema.suite.ts`                                        |
| §7.2 ambiguous retry replays identical bytes across a restart | `preparationLifecycle.suite.ts`                                     |
| §7.2 `dependency_scope_unknown` fallback                      | `preparationDependencies.test.ts`                                   |
| §8.5 anchors immutable, window never lengthens                | `preparationSchema.suite.ts`                                        |
| §10 CP3 populated migration + rollback recovery               | `preparationSchema.suite.ts`                                        |

---

## 4. Defects found by verification, and fixed

1. **A harness defect that was hiding every real failure.** `databaseTest`'s `finally` block threw
   "Electron SQLite test leaked an open database handle" from its own cleanup, which _replaced_ the
   assertion error that caused the leak. Six CP3 failures all reported the leak and nothing else.
   Fixed in `tests/electron/support/sandbox.ts`: the original failure now wins and the leak is
   attached to it, so a genuine leak in an otherwise passing test is still reported. This is a
   pre-existing harness defect, not a CP3 one; it would have obscured every future suite equally.

2. **The resume filter was too narrow.** `runCycle` resumed only `captured`/`dispatching`
   operations, so an `ambiguous` one fell through to a new cycle, had its products partitioned into
   the blocked set, and terminated as `blocked` — leaving the device permanently unable to prepare
   products the server may already have granted. §5.6 step 5a requires all four unresolved states to
   be resolved by exact replay; all four now resume.

3. **Test fixtures used millisecond timestamps** the shipped second-precision envelope contract
   correctly rejects. Caught by the contract, which is the schema doing its job — but a fixture that
   parsed locally while failing in the field would have been worse than a failing test.

4. **Three pre-existing suites asserted position-dependent or whole-row facts** that a purely
   additive migration legitimately changes. All three were corrected to assert what they actually
   mean rather than relaxed: `allocationRecoveryMigration` and `preparationSchema` now address
   migrations **by version** instead of `at(-1)`, and `allocationLifecycleMigration` asserts that
   every pre-existing `sync_queue` column is unchanged plus that the new column is populated, rather
   than comparing `SELECT *`.

---

## 5. Pre-existing findings, preserved with attribution

**Repository-wide lint FAILS (exit 1) and must not be reported as passing.** 9 problems — 2 errors,
7 warnings — in the same three files as the CP0 baseline:

- `scripts/cp3g5LiveUpload.mjs`
- `tests/cp3g5HarnessLifecycle.test.mjs`
- `tests/electron/support/cp3g5/seedReliability.mjs`

All three were verified **unchanged from HEAD** by `git diff --quiet HEAD -- <path>`. **0 problems
were introduced by CP3**, and they were deliberately left unfixed as out of scope. Two lint errors
_were_ briefly introduced in a new CP3 test file and were fixed rather than allowlisted, returning
the count to the exact baseline.

---

## 6. Data isolation

Every database was a disposable `mkdtemp` sandbox file guarded by
`assertInsideSandbox`/`assertDisposableRoot`. The harness refuses `:memory:` and cannot resolve the
production userData path. All sandboxes were disposed; the leak check that enforces this is now
strictly stronger, because it no longer masks the failures that cause leaks.

No backend database was touched by CP3. `npm run verify:fixture` reads `pos-backend` fixtures
read-only.

---

## 7. Scope boundaries

- **No production trigger is wired.** Nothing calls `runCycle()` from a live path; CP4 owns that.
- **No renderer involvement.** §5.2: main resolves the candidate set; a renderer list never reaches
  the wire.
- **No quantity, duration, or target is sent.** The request carries none.
- **No invoice upload change.** CP2U introduced no payload version, so the desktop keeps emitting
  `client_contract_version: 2` unchanged.
- **No readiness projection.** The live countdown and the §8.6 two-panel UI are CP4.
- **No backend file was modified.**

---

## 8. Verification status

- **Engineering implementation:** complete for CP3 scope.
- **Automated verification:** complete and passing, as tabulated in §2.
- **Human GUI acceptance:** **not performed and not claimed.** No GUI smoke was run, and CP3 ships
  no UI.
- **Operational activation:** not applicable — the backend capability ships disabled and no desktop
  trigger exists.
- **Release activation:** not performed.
