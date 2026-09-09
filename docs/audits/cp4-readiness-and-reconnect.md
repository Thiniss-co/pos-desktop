# CP4 audit — 72-hour horizon, reconnect orchestration, and readiness

**Parent baseline:** `pos-desktop` CP3 `b826e26fbe3768c86fc27e61abffdd53d5493671`, worktree clean and
index empty at start.
**Backend counterparts:** CP2 `fee48ec`, CP2U `58dc24d`, error-envelope fix `a709b7a`.
**Design record:** `docs/architecture/cp4-readiness-and-reconnect.md`.

CP4 wires a real production trigger. The backend capability still ships disabled, so on a default
deployment every cycle reaches `unavailable` and stops without side effects.

---

## 1. Source manifest

23 changed paths (11 modified, 12 added), excluding this audit and the architecture record.
Manifest algorithm as plan §1.8.1:

```
e11d98f2462190cf9ae19398fa30fcc9652cc6745649d31eb988fceb517796fa
```

Recorded before the gate results below.

---

## 2. Executed gates

| Gate                          | Command                             | Result                                                        |
| ----------------------------- | ----------------------------------- | ------------------------------------------------------------- |
| Unit suite                    | `npm run test` (Vitest)             | **109 files, 985 tests, 985 passed, 0 failed**                |
| Real Electron SQLite          | `npm run test:sqlite:electron`      | **318 registered — 284 passed, 0 failed, 34 skipped**         |
| Types                         | `npm run typecheck` (tsc + vue-tsc) | clean                                                         |
| Cross-language fixture parity | `npm run verify:fixture`            | **7/7 byte-identical to `pos-backend`**                       |
| Harness safety and lifecycle  | `npm run test:cp3g5-harness`        | **0 failed, 0 skipped**                                       |
| Lint (repository-wide)        | `npx eslint --no-cache .`           | **FAILS, exit 1 — 9 problems (2 errors, 7 warnings)**; see §5 |

The **34 skips are pre-existing live-backend skips**, unchanged by CP4. CP4 adds **28 Vitest cases**
across three files and no new Electron cases — its logic is pure projection and orchestration, which
is exhaustively testable without a database, and its persistence is CP3's, already covered against
real SQLite.

---

## 3. Plan scenarios covered by name

| Plan reference                                                       | Covered by                                              |
| -------------------------------------------------------------------- | ------------------------------------------------------- |
| §8.5 two hours after preparation shows ~70 h, never 72               | `preparationReadiness.service.test.ts`                  |
| §8.5 delayed response measured from `prepared_at`                    | same                                                    |
| §8.5 exact expiry yields zero and `expired`                          | same                                                    |
| §8.5 changed session / observed revocation blocks regardless of time | same                                                    |
| §8.5 partial consumption: time unchanged, quantity may read zero     | same                                                    |
| §8.5 a shorter boundary shortens; nothing lengthens                  | same                                                    |
| §8.6 the full-window phrase only at preparation                      | `preparationReadiness.service.test.ts`, `store.test.ts` |
| §8.6 every tied limiter reported                                     | `preparationReadiness.service.test.ts`                  |
| §8.6 unresolved operation never rendered as success                  | `store.test.ts`                                         |
| §8.1 a grant ending exactly at the deadline counts toward `Q72`      | `preparationReadiness.service.test.ts`                  |
| §8.1 short-lived grants excluded from `Q72` but usable now           | same                                                    |
| §8.3 trusted-time unavailability and rollback block readiness        | same                                                    |
| §7.3 ordering: authority → refresh → drain → prepare                 | `preparationReconnect.service.test.ts`                  |
| §7.3 / §2.2 refresh precedes upload; no upload-first rule            | same                                                    |
| §7.3 item 6 healthy grants never sealed on reconnect                 | same                                                    |
| §4.4 a blocked cycle is a normal outcome, not a failed reconnect     | same                                                    |
| §4 renderer supplies no quantity, ownership, time, or grant right    | empty strict IPC schemas + `store.test.ts`              |

---

## 4. Defects found by verification, and fixed

1. **A backend error shape that broke the desktop's parser.** Both CP2 and CP2U passed error details
   the published envelope cannot represent (`Record<string, string[]>`), so the whole envelope failed
   to parse and the client lost the `code` entirely — degrading two _definitive_ answers
   (`POLICY_REVISION_STALE`, `DESKTOP_INVOICE_QUARANTINED`) into ambiguous failures the client would
   retry forever. Found while wiring this checkpoint against the real error contract; fixed and
   committed separately as `a709b7a`.

2. **Usable quantity was being derived as `granted - serverConsumed`,** which ignores local committed
   consumption above the accepted coverage boundary and over-reports by exactly the amount already
   sold offline. Corrected to the repository's own reconciled `spendableMilli` (§3.2).

3. **Three renderer lint problems** were introduced and fixed rather than allowlisted, returning the
   repository to its exact baseline.

---

## 5. Pre-existing findings, preserved with attribution

**Repository-wide lint FAILS (exit 1) and must not be reported as passing.** 9 problems — 2 errors,
7 warnings — in the same three files as the CP0 baseline:

- `scripts/cp3g5LiveUpload.mjs`
- `tests/cp3g5HarnessLifecycle.test.mjs`
- `tests/electron/support/cp3g5/seedReliability.mjs`

**0 introduced by CP4**, deliberately left unfixed as out of scope.

---

## 6. Data isolation

CP4 added no Electron suite and touched no database directly. The Electron and harness gates ran
against disposable `mkdtemp` sandboxes exactly as before. No backend database was touched;
`verify:fixture` reads `pos-backend` fixtures read-only.

---

## 7. Scope boundaries

- **No release, no seal.** Release remains a separate, still-disabled CP6 branch, and the reconnect
  trace records the deliberate non-retirement explicitly.
- **No invoice upload change.** The desktop keeps emitting `client_contract_version: 2`.
- **No new sale-path guard.** The Revision 2.3 catalog-expiry guard is unchanged and still passing;
  CP4 adds no commit-time check.
- **No reassignment or revocation quarantine.** That is CP5.
- **No production activation.** The backend capability ships disabled.

---

## 8. Verification status

- **Engineering implementation:** complete for CP4 scope.
- **Automated verification:** complete and passing, as tabulated in §2.
- **Human GUI acceptance:** **not performed and not claimed.** CP4 ships a UI, and **no GUI smoke
  was run** — the readiness screen has never been rendered by a human in this execution. The manual
  checklist for it is CP7 scope and is delivered unpassed.
- **Operational activation:** not performed. With the backend capability disabled, every cycle
  reaches `unavailable`.
- **Release activation:** not performed.
