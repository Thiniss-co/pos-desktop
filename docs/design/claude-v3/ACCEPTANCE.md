# V3 acceptance record — 2026-09-28

This record states exactly what was verified, against which desktop and backend content, with which
fixtures, and what remains open. The design guide and matrix are in
[IMPLEMENTATION.md](IMPLEMENTATION.md); the screenshots are in
[verification/final-2026-09-28/](verification/final-2026-09-28/README.md).

## 1. Desktop source identity

- **Base commit:** `2997048` on `feat/claude-design-v3-redesign`. The verified tree is that commit
  plus the working-tree changes committed as the V3 series. The commit SHAs are in the series' final
  report and the git log.
- **Application-content digest:** `15d27d98440034db90bd1cf6f4c7f8d531afbbb6cb46990e1870a51eb77d8658`.
  - It is the sha256 of the sorted `sha256sum` list of every tracked or untracked, non-ignored file
    outside `docs/` and `.ai/` (615 files).
  - The same digest was computed immediately before and after the final gate run below. Nothing in
    application content changed during the run.
  - After committing, recompute it with the same rule on a clean checkout of the series' last commit.
- Documentation (`docs/`, `.ai/`) was edited only after that run: this record, verification notes and
  one guide sentence. The documentation is not part of the digest.

## 2. Backend identity (read-only reference; never modified)

- **HEAD:** `4cb3d2b89b23f2c35d8265d27959e4793d90550a` ("feat(company-owner): read-only sales history
  and shift monitoring").
- **The working tree was NOT clean.** It had 92 entries not written by this work: 52 modified
  tracked files and 40 untracked files. Every backend run here therefore tested
  **HEAD `4cb3d2b` + that dirty set**, not HEAD alone.
  - Entry list: [acceptance/backend-worktree-status.txt](acceptance/backend-worktree-status.txt).
  - Per-file content hashes: [acceptance/backend-dirty-files.sha256](acceptance/backend-dirty-files.sha256).
  - Dirty-set digest (sha256 of that hash list): `0f3cfa904cc540fdf971c5a06d76f71530ca3372f599dafd861a22c4c6a694e2`,
    unchanged from before the first GUI run (newest dirty mtime 2026-09-28 14:24 +03:00) to after the
    final gate run (re-checked after the run: same HEAD, same digest).
- Dirty files on paths these tests exercise:
  - `database/seeders/DesktopMvpSmokeSeeder.php` `ad54cf73…` — adds a purge of existing demo data
    (a no-op on the fresh databases used here);
  - `app/Modules/POS/Actions/UploadDesktopInvoiceAction.php` `110a6f3c…` — the invoice upload used by
    the exactly-once checks;
  - `app/Modules/Shifts/Actions/OpenDesktopShiftAction.php` and `CloseDesktopShiftAction.php`.
- Fixture code used at its HEAD content (clean):
  - `database/seeders/RolesAndPermissionsSeeder.php` `ba70683c…`;
  - `app/Console/Commands/SeedPhysicalPresenceFixture.php` `54852073…`;
  - `app/Modules/Devices/Services/DeviceAssignmentFenceService.php` `bc8fac40…`;
  - `app/Modules/POS/Actions/UpsertPosOfflineSalePolicyAction.php` `9551686d…`;
  - `app/Modules/Inventory/Actions/UpsertStockAllocationExposurePolicyAction.php` `9c6fb9d1…`;
  - `app/Modules/Inventory/Services/OfflineStockPreparationService.php` `956a3806…`.

## 3. Fixtures and harness

**Database safety (committed):** `tests/electron/support/sandbox/laravelSandboxGuard.php`, used by
`guardedArtisan.php` and `guiFixture.php`.

- It requires, before Laravel loads:
  - `APP_ENV=testing`, `DB_CONNECTION=sqlite`, no `DB_URL`;
  - `DB_DATABASE` equal to `POS_SANDBOX_EXPECTED_DB`: an existing, non-symlinked file under the system
    temporary directory, outside both repositories and outside `~/.config/pos-desktop`;
  - an `APP_CONFIG_CACHE` that names a not-yet-existing file in the sandbox.
- It refuses `thinis_pos` and `thinis_pos_testing` by name or file stem.
- After boot, it verifies the resolved connection in the same process that writes.
- `tests/sandboxGuard.test.mjs` proves 18 refusals against a fake backend: nothing reaches Laravel or a
  database.

**Automated live gates (committed scripts)**

| Gate                  | Command                                                                                                                                                                                              | Fixture                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Receipt-profile       | `CP3G5_MINT_RECEIPT_PROFILE_CONTEXT=1 RECEIPT_PROFILE_ARTIFACT_DIR=<run dir> node scripts/cp3g5LiveUpload.mjs`, then `RECEIPT_PROFILE_ARTIFACT_DIR=<run dir> node scripts/runReceiptRenderCheck.mjs` | The existing CP-3G-5 seeder contract, migrated through `guardedArtisan.php`         |
| PS7 physical presence | `node scripts/ps7LivePhysicalPresence.mjs`                                                                                                                                                           | Migrate and `ps7:seed-physical-presence-fixture`, both through `guardedArtisan.php` |

**GUI runs (real Electron app, driven over CDP)**

- **Backend:** `guardedArtisan.php migrate` and `db:seed DesktopMvpSmokeSeeder`, then these `guiFixture.php`
  operations, which call only supported backend services and actions:
  - `assign-device <uuid>` → `DeviceAssignmentFenceService::applyAssignment`;
  - `mode-physical-presence` → `UpsertPosOfflineSalePolicyAction` (72h). Run B, server started with
    `POS_OFFLINE_PHYSICAL_PRESENCE_ENABLED=true`;
  - `mode-allocation COLA-CAN,WATER-500,CHIPS-S` → `UpsertPosOfflineSalePolicyAction` (allocation) plus
    `UpsertStockAllocationExposurePolicyAction` (budget 20 000, cap 10 000, target 5 000 milli). Run A,
    server started with `STOCK_ALLOCATION_PREPARATION_ENABLED=true`;
  - `report <uuid>`, which is read-only.
- **App:** built with `MAIN_VITE_POS_API_ORIGIN` pointing at the run's loopback server. Isolated profile
  (`XDG_CONFIG_HOME`), isolated keyring (a private D-Bus session with `gnome-keyring-daemon`), CDP.
- **Driver scripts (not committed):** the launcher and CDP driver were session tooling with local
  absolute paths, so they stay out of the repository. The recipe is in the list above. Their sha256
  prefixes for traceability:
  - `sandbox.mjs` `a6e2e8ed…`
  - `capture.mjs` `ffed433e…`
  - `cdp.mjs` `337719a3…`
  - `helpers.js` `2026bbb5…`
  - `navcheck.js` `e163de24…`
  - `audit.js` `3e972d25…`

## 4. Gates run on the verified tree

Final run, sequential, on the tree with the digest in §1:

| Gate                                                         | Result                                                                                                                                                                                          |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck` (node + web)                             | exit 0, 0 errors                                                                                                                                                                                |
| `npm run lint`                                               | exit 1: 2 errors and 6 warnings, **all pre-existing** (7 in `tests/electron/support/cp3g5/seedReliability.mjs`, 1 in `tests/cp3g5HarnessLifecycle.test.mjs`), 0 in files changed by this series |
| `npx vitest run`                                             | 136 files, 1248 tests passed, 0 failed                                                                                                                                                          |
| `npm run test:sqlite:electron`                               | 421 tests: 364 passed, 0 failed, 57 skipped (the live suites skip without a live fixture)                                                                                                       |
| `npm run test:cp3g5-harness`                                 | 56 passed, 0 failed (includes 18 sandbox-guard refusals)                                                                                                                                        |
| `npm run build` (runs typecheck, then `electron-vite build`) | exit 0                                                                                                                                                                                          |
| Receipt-profile live gate + render check                     | Passed; 16 files in `runs/v3-acceptance-2026-09-28-committed-tree/`; all 4 gate documents are PDF page count = plan page count                                                                  |
| Committed baseline receipt artifacts                         | byte-identical after the run (`sha256sum -c`)                                                                                                                                                   |
| PS7 physical-presence live gate                              | 421 tests: 371 passed, 0 failed, 50 skipped                                                                                                                                                     |
| Application digest after the run                             | unchanged (`15d27d98…`)                                                                                                                                                                         |
| Backend after the run                                        | HEAD `4cb3d2b`, dirty-set digest unchanged (`0f3cfa90…`)                                                                                                                                        |

**Receipt evidence runs** (each internally consistent: its HTML/JSON and PNG/PDF come from one run)

- `docs/audits/artifacts/receipt-profile/runs/v3-acceptance-2026-09-28-committed-tree/` — the run on
  the tree in §1. **This is the acceptance evidence.**
- `…/runs/v3-acceptance-2026-09-28-final/` — an earlier run on the same code. Twelve files were
  Prettier-reformatted after it (whitespace only). Kept as history.
- `…/runs/v3-acceptance-2026-09-28/` — the first run after the integration repair, before the later
  main-process fixes. Kept as history.
- The committed baseline set in `docs/audits/artifacts/receipt-profile/*` was byte-identical after
  every run.

**GUI acceptance (same application source; the build embedded a per-run origin).** Detailed in
IMPLEMENTATION.md §8:

- activation, sign-in and the negotiated bootstrap, with no proxy;
- receipt-profile publish, revisions 1 → 2;
- company-user create and edit;
- offline selling in both modes, including a tracked physical-presence sale, restart survival, and
  exactly-once upload (1 sync record, 1 invoice, 1 stock movement);
- the `POLICY_REVISION_STALE` recovery on the stuck operation, with its frozen bytes unchanged;
- 134 screenshots.

## 5. Known limitations (manual and operational)

- **Prepared stock is not spendable until the next bootstrap refresh.** The prepare response has no
  verifiable coverage boundary, and the documented reconnect order refreshes only before preparing.
  **Follow-up, not part of this series:** decide between a post-apply read-only refresh and a
  verifiable boundary in the prepare response. The protocol was deliberately not changed here.
- **Not verified:** physical printing (Print was never pressed); the access-blocked and fatal-error
  screens live (simulated renders only); the packaged installer; Windows/macOS.
- Rejected checkout attempts keep their tender rows until removed (existing behaviour).
- Some secondary controls are under 44px, following the prototype's sizing.
- `npm run lint` still reports 2 errors and 6 warnings, all in pre-existing
  `tests/electron/support/cp3g5/seedReliability.mjs` and `tests/cp3g5HarnessLifecycle.test.mjs`.
- The receipt-profile live suite leaves one 1×1 PNG in a `pos-desktop-cp3g5-logo-*` directory under
  the system temporary directory (existing suite behaviour).
- The backend results depend on the uncommitted backend changes listed in §2. Once those are
  committed or changed, re-run the gates against the new backend HEAD.
