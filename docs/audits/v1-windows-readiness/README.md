# V1 Windows readiness — pos-desktop

**Verdict: BLOCKED.** V1 targets Windows. Nothing in this report was executed on Windows: no Windows
environment was available. Linux results are supporting evidence only. The release inputs in §6 are
missing, and no installer here is a release candidate. Nothing was pushed, published or deployed, and
no update feed was published. Branch `feat/v1-windows-readiness` is left unmerged for review.

## 1. Identities

| Item           | Identity                                                                                                                                                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical main | `f52521c` (Stage 1: `merge --ff-only feat/v1-production-readiness` from `76ff670`, authorized; not pushed)                                                                                                                                                                      |
| Branch         | `feat/v1-windows-readiness` in `/var/www/html/thinis-pos/pos-desktop-slot-2`, 12 commits on `f52521c`. Gated source: `561f7c7` (every gate in §8); `64eba97` changes two journey files only, and its journeys and packages were re-run (§7, §8); this report is the last commit |
| Backend        | disposable `git archive` export of `pos-backend` `b4c85cf` with its own APP_KEY; SQLite sandboxes behind the guard. No backend edits; no normal backend database was used or migrated. The canonical backend checkout (HEAD and working tree) was fingerprinted: unchanged (§8) |
| Toolchain      | Node 22.13.1, Electron 39.8.10 (Chromium 142), electron-builder 26.15.3, electron-updater 6.8.9, better-sqlite3 12.11.1, PHP 8.4.23, host Ubuntu 26.04 x64                                                                                                                      |
| Evidence       | `/var/www/html/thinis-pos/plans/v1-windows-readiness-evidence-20261009/` (gate logs, journey results and screenshots, receipt-profile run artifacts, fingerprints, artifact hashes; scanned for keys and tokens: none)                                                          |

## 2. Windows release plan (Stage 2)

Full detail: [`docs/release/windows.md`](../../release/windows.md).

| Topic                         | Decision / finding                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supported Windows             | Target: Windows 11 23H2+ x64 and Windows 10 22H2 x64. **Neither is verified**: support is claimed only after `tests/windows/` passes on that version. No arm64 or ia32 build                                                                                                                                                                                  |
| Installer                     | NSIS one-click, **per-user** (`%LOCALAPPDATA%\Programs\Thinis POS`): a standard cashier account installs and updates without an administrator. There is no concrete reason for a per-machine install                                                                                                                                                          |
| Native SQLite                 | **Fixed:** a Linux-built NSIS package contained the Linux ELF `better_sqlite3.node` (`npmRebuild` does not cross-compile). `scripts/electronBuilderAfterPack.mjs` installs the official Windows x64 prebuild for Electron's ABI and **fails the build** if the packaged binary's format does not match the target. Verified on the built installer: PE32+ x64 |
| Paths                         | Program `…\Programs\Thinis POS\pos-desktop.exe`; data `%APPDATA%\pos-desktop` (pinned in code, independent of the display name, so the "Thinis POS" rename moves no data); native module under `app.asar.unpacked`                                                                                                                                            |
| appId / AUMID                 | Still the template `com.electron.app`. Main sets the same AUMID (checked equal by `verify:cp3g5-package`). **Must be final before the first Windows install**: the NSIS uninstall key derives from it                                                                                                                                                         |
| Single instance               | **Added:** a second launch focuses the running till instead of opening a second process on the same database                                                                                                                                                                                                                                                  |
| Install / upgrade / uninstall | Upgrade replaces the program in place; uninstall removes the program and shortcuts and **keeps** `%APPDATA%\pos-desktop` (`deleteAppDataOnUninstall: false`). Start menu and desktop shortcuts                                                                                                                                                                |
| Credentials                   | `safeStorage` uses DPAPI on Windows, bound to the Windows user; the store fails closed when encryption is unavailable                                                                                                                                                                                                                                         |
| Electron security             | contextIsolation, sandbox, no nodeIntegration, sender-checked IPC; fuses (RunAsNode, NODE_OPTIONS and `--inspect` off; asar integrity, enforced on Windows; only-load-from-asar)                                                                                                                                                                              |
| Printing                      | Windows printers through `getPrintersAsync`; silent `webContents.print`. The OS callback means the spooler accepted the job, not that it printed (`submitted` / `outcome_unknown`, never resent). Driver behaviour (page size, margins) is a hardware acceptance item                                                                                         |

## 3. Product gaps closed (Stage 3)

| Gap                                                              | Change                                                                                                                                                                                                                                                  | Validation                                                                                                                                                                                             |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Refund user switch / logout during a delayed preview or dispatch | `refund.service` re-checks the owner after the invoice read and refuses another owner's preview at submit; resume requires the same company and device; the refunds store drops stale responses (generation guard) and is reset at sign-out (`bc236c8`) | unit tests; live gate scenario `owner_switch` (mutation-checked)                                                                                                                                       |
| Offline quick-create through a real process kill (SIGKILL)       | **Bug found and fixed:** a request killed while `dispatching` stayed stuck. It is now reclaimed as INTERRUPTED at the first drain after start and replayed once (`e873883`)                                                                             | repository and worker tests; journey `qckill` (A: offline quick-create, kill, restart offline, reconnect; B: server commits, answer held, kill, replay) → exactly one customer on the server each time |
| Quick-create price by touch only                                 | Journey with touch events only (`49d39f1`)                                                                                                                                                                                                              | `qc5touchprice`: 1, 2, ., 5 tapped on the keypad; the request and the server carry 1250 minor units                                                                                                    |
| Fractional refund quantity with the keypad                       | Refund line → keypad entry (3 decimals) bounded by the refundable remainder; over-refund refused with a message, in the dialog and in the service (`ab36b25`)                                                                                           | unit tests; live gate scenario `fractional`; journey `refundfraction` (by touch: 0.5 of 1.250, then 0.8 refused against 0.75 remaining, then exactly 0.75; two server refunds, nothing left)           |
| Blocked-migration recovery                                       | A till that cannot start shows a bilingual error box (keep the data folder, contact support) instead of exiting silently; support procedure `docs/support/blocked-migration-recovery.md` (copy the folder, never delete the database) (`30d46b8`)       | unit test of the message; the native dialog itself is not exercised in a real app (NOT RUN)                                                                                                            |
| Test-server cleanup leaks                                        | The runner stops any sandbox, proxy or packaged app a journey leaves running and records it (`12eecae`); three journeys that leaked now stop their servers                                                                                              | every journey run in §8 ended with no survivors (no `cleanup` record); no test process left running after the gates                                                                                    |

## 4. Automatic updates (Stage 5)

Full detail: [`docs/release/updates.md`](../../release/updates.md).

- **Main-owned updates** (`src/main/update/`) with sender-checked, Zod-validated IPC. Background
  check and download: first check 30 s after start, then every 4 h; a 5-minute wait while offline;
  bounded backoff of 1, 5 and 15 minutes, then hourly.
- **Settings panel** in EN/AR and light/dark.
- **Never installs by itself.** Installation happens only on the cashier's **Restart to update**. It
  is refused while a sale or payment is on screen, or while a refund, print, upload or catalog install
  is in flight. Queued offline work does not block it and survives the upgrade.
- **Downloads are checked** against the feed's SHA-512. On Windows, a signed build is additionally
  checked against the publisher's Authenticode signature; the current builds are unsigned, so this
  check does not yet apply. TLS is never disabled. There is no default feed: a build without
  `MAIN_VITE_POS_UPDATE_FEED_URL` reports `not_configured`.
- **Real packaged A→B upgrade:** journey `pkgupdate`, on Linux AppImage as supporting evidence.
  - Two AppImages (1.0.0, 1.0.1) and an isolated local feed.
  - A downloaded B in the background.
  - An offline sale was left pending.
  - The restart was refused with a cart line on screen and accepted once the cart was empty.
  - The updater installed B (byte-identical to the feed) and relaunched it.
  - B, at 1.0.1, ran on the same profile and was still signed in.
  - The pending sale had the same idempotency key and bytes, and uploaded exactly once.
  - B then reported itself up to date.
- **Windows NSIS upgrade: NOT RUN** (no Windows).

## 5. Windows acceptance (Stage 6): NOT RUN

There is no Windows machine, VM or image here. The VirtualBox VMs on this host are the owner's lab
machines and were not touched; Wine is not acceptance. The kit is ready: `tests/windows/README.md`
(procedure A–F covering every item the owner listed, with PASS/FAIL/NOT RUN per row) and
`tests/windows/Test-WindowsPackage.ps1` (the installer lifecycle on a disposable VM: preflight,
install, profile, upgrade, uninstall that keeps data, reinstall). The script has not been executed or
parsed (no PowerShell on this host). Hardware rows (F) need the owner's authorization for each
physical print.

## 6. Release inputs (Stage 4): missing, none invented

`npm run verify:release-inputs` refuses a release build until all of these are supplied. Today it lists
all ten:

| Input                               | Current (template)                                  | Needed from the owner                                                              |
| ----------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Production API origin               | none (`.env` is `http://127.0.0.1:8000`)            | the production `https://` origin                                                   |
| Application ID (appId / AUMID)      | `com.electron.app`                                  | a company-owned reverse-DNS ID, final before the first Windows install             |
| Legal publisher and support contact | `author: example.com`, `maintainer: electronjs.org` | legal company name and support e-mail (`Name <email>`)                             |
| Homepage                            | `https://electron-vite.org`                         | company URL                                                                        |
| Icons                               | scaffold `resources/icon.png`; no `build/icon.ico`  | real artwork: png 512+, ico                                                        |
| Windows signing                     | none (installer and exe unsigned)                   | a code-signing certificate or signing service, the process, and the publisher name |
| Update feed                         | `publish.url: https://example.com/auto-updates`     | a company-operated HTTPS feed URL                                                  |

The display name "Thinis POS" is set. The data folder is pinned, so identity metadata changes never
move user data. Signing secrets must never enter the repository.

## 7. Packages built from `64eba97` (NOT release candidates)

Built with the tracked development `.env` (loopback API origin, no feed). The packages therefore
report `not_configured` and are unsigned.

| Artifact                                  | SHA-256                                                            | Notes                                                                                                                                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pos-desktop-1.0.0-setup.exe` (NSIS, x64) | `ab3f1506124a5e0ce091abeeb0bb04290bddd1177064ae755709394a02e7faee` | **Unsigned** (empty Authenticode directory in the installer and in `pos-desktop.exe`); `better_sqlite3.node` PE32+ x86-64 (afterPack: `pe/x64 platform=win32`); `latest.yml` sha512 `+aQyl/1lm8UB…` |
| `pos-desktop-1.0.0.AppImage`              | `2c5a81fee44773f11ecc672325c76f4e8738ca8ed3a9d5e95e439d329a1c64a9` | supporting only                                                                                                                                                                                     |
| `pos-desktop_1.0.0_amd64.deb`             | `0d0cec9fd6c109e27de342bf7b12e36973f3ffecc4e0f5940cd92b1250da8d72` | supporting only                                                                                                                                                                                     |

`npm run verify:cp3g5-package` passes over all of `dist/` (Windows and Linux): no test harness, fixture or
live-gate file is packaged, and the AUMID equals the appId. The packages stay in the slot's ignored `dist/`.
Version 1.0.0; backend compatibility: `pos-backend` `b4c85cf`.

## 8. Gates

On `561f7c7`, one run (`gates/summary.txt` in the evidence), with `RECEIPT_PROFILE_ARTIFACT_DIR` set to a run directory.
The committed receipt-profile artifacts and the canonical backend (HEAD and working tree) were fingerprinted before
the gates and after the last journey: unchanged.

| Gate                                                                             | Result                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| typecheck, lint                                                                  | pass (lint 0 errors)                                                                                                                                                                                                                                                                                                                                                                              |
| vitest                                                                           | 1964 / 1964 (193 files)                                                                                                                                                                                                                                                                                                                                                                           |
| `test:sqlite:electron`                                                           | 489 pass, 0 fail, 65 skipped (live-only; run by the live gate)                                                                                                                                                                                                                                                                                                                                    |
| harness safety (`test:cp3g5-harness`)                                            | 72 / 72                                                                                                                                                                                                                                                                                                                                                                                           |
| release-inputs gate tests                                                        | 3 / 3. `verify:release-inputs` itself **fails as intended**: ten missing inputs (§6)                                                                                                                                                                                                                                                                                                              |
| fixture parity, print boundary                                                   | pass                                                                                                                                                                                                                                                                                                                                                                                              |
| live CP-3G-5 gate (refund, receipt-profile, owner-product contexts, 32 payloads) | pass; the receipt-profile run wrote its four HTML/document pairs to the run directory (the scenario ran)                                                                                                                                                                                                                                                                                          |
| backend targeted Pest                                                            | **not re-run**: no backend change (`b4c85cf`, as in the previous closeout's 76 / 76)                                                                                                                                                                                                                                                                                                              |
| journeys on `561f7c7` (29)                                                       | **24 pass**: `smoke`, `qc5touch`, `qc5touchprice`, `ws4touch`, `qc2offline`, `qckill`, `qc4mixedtax`, `qc4mixedtaxe2e`, `qc6receipts`, `qc7autoprint`, `receiptSnapshot`, `p9identity`, `stage3renewal`, `e2offers`, `p3suspension`, `p6lifecycle`, `ps6bdisposition`, `keystore`, `refundkill`, `refundfraction`, `ws2checkout`, `soak`, `pkgapp`, `pkgrelease`. **5 failed**: see the next rows |
| `stage7upload`                                                                   | **failed** on `561f7c7`: test race (all 5 sales on the server exactly once, but the last local row still read `uploading` when checked). Journey fixed in `64eba97` (bounded wait, same requirement); **pass** on `64eba97`                                                                                                                                                                       |
| `pkgupdate`                                                                      | **failed** on `561f7c7`: the tmpfs filled while building B (`EDQUOT`), because two earlier runs kept their ~1 GB builds. The journey now removes them (`64eba97`); **pass** on `64eba97` (and earlier on `9c9a78c`)                                                                                                                                                                               |
| `ws3persist`, `ws5matrix`                                                        | **failed** on display `:0`: this monitor clamps 1920×1080 to 1919×1043 (environment). **Pass** on `64eba97` under a nested Xephyr display with exact viewports                                                                                                                                                                                                                                    |
| `p8images`                                                                       | **failed**: COLA image not shown at step 1, the same failure as on `main` `76ff670` (pre-existing baseline, not caused by this branch; not fixed here)                                                                                                                                                                                                                                            |
| `build:linux`, NSIS `--win nsis --x64`, package boundary                         | pass on `64eba97` (§7)                                                                                                                                                                                                                                                                                                                                                                            |
| Windows install / launch / upgrade / uninstall                                   | **NOT RUN** (no Windows)                                                                                                                                                                                                                                                                                                                                                                          |

No journey left a server or process running (the runner records survivors; none were recorded). Not run on
this source: the other historical journeys (stage 4–10, `ws1measure`, `p4*`, `qc1permissions`, `qc3actions`,
`ownerOpeningStock`, `g0live`, `p8ownerUpload`, `stage5install`, …) and the .deb container install, which was run on this branch after the packaging change in `eb36440` (installed, started sandboxed as "Thinis POS" with `CAP_SYS_ADMIN`) but not re-run on `64eba97`.

## 9. Remaining blockers

1. **Windows acceptance not run.** No step of `tests/windows/` has been executed on Windows 10 or 11:
   install, native SQLite, DPAPI credentials, the selling journeys, upgrade, uninstall, EN/AR ×
   light/dark, or touch.
2. **Release inputs missing** (§6): API origin, appId, publisher and support, homepage, icons, signing
   and the update feed.
3. **Code signing.** The installers are unsigned. SmartScreen will warn, and the update publisher
   check is not active.
4. **Hardware**: receipt printer through the Windows spooler and its driver, barcode scanner,
   touchscreen and cash drawer (`tests/windows/README.md` F; every physical print needs explicit
   authorization).
5. **Backend rollout**: the backend's normal database still lacks the pending migrations (backend
   checklist, outside this repository). Backend compatibility was verified against `b4c85cf` only.
6. **Not exercised in a real app:** the startup error box (native dialog).
7. **Recorded limitations:** the refund quantity panel squeezes the line table at 1366×850. Operator
   dispositions reach an online till at its next renewal, refresh or reconnect.

## 10. Next steps

1. The owner supplies the §6 inputs. `npm run verify:release-inputs` must then pass.
2. Build a signed NSIS candidate from the reviewed branch. Record its version, commit and SHA-256.
3. Run `tests/windows/` on disposable Windows 11 and Windows 10 VMs, then on the pilot hardware.
4. Move the verdict to READY FOR WINDOWS PILOT only when rows A–E pass, and to READY FOR WINDOWS
   RELEASE only when F also passes and the installer is signed.
