# CP7 — desktop rollout readiness

**Status: READY FOR STAGED ROLLOUT DECISION. Not rolled out, and not accepted.**

**Baseline:** `pos-desktop` CP4 `085a94100b4f5102e568de9f02eea70c27d92a07`.
**Backend counterpart:** `pos-backend` CP7 `547a377ec6e9804de03b4031c958fa00d5d28530`, whose
`docs/audits/cp7-rollout-readiness.md` carries the combined matrix and the rollout/rollback
procedure.
**Authoritative plan:** `plans/POS_OFFLINE_STOCK_CONTINUITY_PLAN.md` §10 CP7, §11, §12.

This document records what the desktop half contributes and what it does **not** establish.

---

## 1. Desktop verification, executed at this baseline

| Gate                                                        | Result                                                |
| ----------------------------------------------------------- | ----------------------------------------------------- |
| Unit suite (`npm run test`)                                 | **109 files, 985 tests, 985 passed, 0 failed**        |
| Real Electron SQLite (`npm run test:sqlite:electron`)       | **318 registered — 284 passed, 0 failed, 34 skipped** |
| Types (`npm run typecheck`)                                 | clean                                                 |
| Cross-language fixture parity (`npm run verify:fixture`)    | **7/7 byte-identical to `pos-backend`**               |
| Harness safety and lifecycle (`npm run test:cp3g5-harness`) | 0 failed, 0 skipped                                   |
| Lint (`npx eslint --no-cache .`)                            | **FAILS, exit 1 — 9 problems** (see §4)               |

The **34 skips are pre-existing live-backend skips**, unrelated to this work and unchanged by it.
**284 — not 318 — is the number that executed and passed.**

---

## 2. Desktop flag-off behavior

The desktop ships with the preparation UI present and the production trigger wired. That is safe and
deliberate, because the _capability_ lives on the backend:

| Backend state                           | Desktop behavior                                                                                                                                                      |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preparation.enabled = false` (shipped) | The prepare route returns 404. The cycle records `unavailable`, writes no operation, creates no local authority, and stops. The readiness page shows its empty state. |
| Capability on, no policy configured     | `409 DESKTOP_PREPARATION_UNAVAILABLE`. No operation is created, so the client's operation UUID stays reusable.                                                        |
| Capability on, policy configured        | Ordinary preparation.                                                                                                                                                 |

The trigger is subscribed to the same authoritative access-change point the upload and recovery
workers already use, and is fire-and-forget: a preparation failure can never surface as an
access-publish fault. It is a scheduling hint only — `runCycle()` re-resolves the owner, re-reads
connectivity, and re-captures its own bounded boundary on every call, so a hint that arrives while
the device is offline, unassigned, or blocked does nothing.

**No desktop build has to emit a new representation.** CP2U added no invoice payload version, so the
desktop keeps emitting `client_contract_version: 2` unchanged and the backend-before-desktop ordering
is satisfied trivially.

---

## 3. Migration and rollback

Migration `0011` is additive: two families of new tables plus one new nullable `sync_queue` column,
backfilled in the same claim order the queue already uses. It is exercised against a **populated**
pre-migration database, not merely a fresh one, and its rollback is asserted against real SQLite —
which, unlike MySQL, does give transactional DDL.

Downgrade behavior: unknown evidence is retained as held. Nothing in the desktop deletes a grant, a
hold, a coverage boundary, a terminal marker, or a queued payload on rollback.

---

## 4. Pre-existing findings, preserved with attribution

**Repository-wide lint FAILS (exit 1) and must not be reported as passing.** 9 problems — 2 errors,
7 warnings — in `scripts/cp3g5LiveUpload.mjs`, `tests/cp3g5HarnessLifecycle.test.mjs`, and
`tests/electron/support/cp3g5/seedReliability.mjs`, each verified byte-identical to HEAD.
**0 introduced** by CP3 or CP4; deliberately unfixed as out of scope.

---

## 5. What the desktop half does **not** establish

- **No GUI smoke was performed and none is claimed.** CP4 ships a readiness screen that has never
  been rendered by a human in this execution. The checklist is
  `pos-backend/docs/audits/cp7-manual-gui-checklist.md`, delivered **unpassed**.
- **No packaged Electron build** was produced or exercised. §10 CP7's "packaged Electron against
  disposable data" is **NOT PERFORMED**.
- **No live-backend integration run.** The 34 skipped Electron cases are exactly those, and they
  remain skipped.
- **No production or production-like data was involved.** Every database was a disposable `mkdtemp`
  sandbox; the harness refuses `:memory:` and cannot resolve the production userData path.

---

## 6. Verification status

- **Engineering implementation:** complete for CP3 and CP4 as authorized.
- **Automated verification:** complete and passing, as tabulated in §1, with §4 attributed.
- **Human GUI acceptance:** **NOT PERFORMED.**
- **Operational activation:** not applicable on the desktop — the capability gate is the backend's.
- **Release activation:** not performed; the desktop has no release path.
