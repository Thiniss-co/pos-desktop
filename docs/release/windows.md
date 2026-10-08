# Windows release (V1)

V1 targets Windows. This page records the packaging decisions and what has, and has not, been verified.
Linux results are supporting evidence only; they do not establish Windows readiness.

## Supported platforms

|                                       | V1 target                                           | Verified on Windows                                |
| ------------------------------------- | --------------------------------------------------- | -------------------------------------------------- |
| Windows 11 (23H2 or later), x64       | yes                                                 | **NOT RUN** (no Windows environment was available) |
| Windows 10 22H2, x64                  | yes (Electron 39 supports Windows 10+)              | **NOT RUN**                                        |
| Windows on ARM (arm64), 32-bit (ia32) | **no** — not built                                  | —                                                  |
| Windows 7 / 8 / 8.1, Windows Server   | **no** — unsupported by Electron 39 or not targeted | —                                                  |

Support is claimed only after the Windows validation kit (`tests/windows/README.md`) passes on that
version.

## Installer: NSIS, per-user

| Decision        | Value                                                                                                    | Why                                                                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Format          | NSIS one-click (`pos-desktop-<version>-setup.exe`), x64                                                  | electron-builder default for Windows; supports electron-updater                                                                                               |
| Scope           | **per-user** (`perMachine: false`): `%LOCALAPPDATA%\Programs\Thinis POS`                                 | A cashier's standard account installs and updates the till **without an administrator**; no UAC prompt. Each Windows account that sells installs its own copy |
| Shortcuts       | Start menu and desktop: "Thinis POS"                                                                     |                                                                                                                                                               |
| Upgrade         | Running a newer installer (or an automatic update) replaces the program in place; data untouched         |                                                                                                                                                               |
| Uninstall       | Removes the program and shortcuts; **keeps** `%APPDATA%\pos-desktop` (`deleteAppDataOnUninstall: false`) | Pending sales/refunds and the device identity must never be deleted by an uninstall or reinstall                                                              |
| Single instance | A second launch focuses the running till and exits (`requestSingleInstanceLock`)                         | Two processes must not open the same database                                                                                                                 |

A per-machine install (all accounts, `Program Files`) would require an administrator for every install
and update; there is no V1 reason for it.

## Identity (appId / AUMID)

`appId` in `electron-builder.yml` is still the template's `com.electron.app`, and main sets the same
AppUserModelId (`npm run verify:cp3g5-package` keeps the two equal). **It must become a company-owned
reverse-DNS ID before the first Windows install.** The NSIS installer derives its uninstall registry
key from `appId`, and Windows groups the taskbar and notifications by the AUMID. Changing the ID after
tills are installed makes the next installer a separate application: a second Apps-list entry and stale
shortcuts. The till's data would not move, because the data folder is pinned to `pos-desktop`
independently of the ID and the display name. The ID is a release input; this work does not invent one.

## Paths

| What            | Where                                                                                                                                                                                                                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Program         | `%LOCALAPPDATA%\Programs\Thinis POS\pos-desktop.exe`                                                                                                                                                                                                                                               |
| Data (userData) | `%APPDATA%\pos-desktop\` — pinned for packaged builds (`src/main/app/instanceLocation.ts`), independent of the display name, so a rename never strands the database                                                                                                                                |
| Database        | `%APPDATA%\pos-desktop\pos-desktop.sqlite` (better-sqlite3, main process only)                                                                                                                                                                                                                     |
| Native module   | `resources\app.asar.unpacked\node_modules\better-sqlite3\build\Release\better_sqlite3.node` — the Windows x64 (PE32+) prebuild for Electron's ABI; `scripts/electronBuilderAfterPack.mjs` installs it when cross-building and **fails the build** if the packaged binary does not match the target |

## Credentials

Desktop token and licence are encrypted with Electron `safeStorage`, which on Windows uses **DPAPI**
bound to the Windows user. `SecureStorageService` accepts the OS key store on Windows and refuses to
persist when encryption is unavailable. Consequence: a different Windows account, or a reset profile,
cannot read them — the cashier signs in again (no data loss; the database is not encrypted with DPAPI).

## Security

Same as Linux: `contextIsolation`, `sandbox`, no `nodeIntegration`; DevTools and the default menu off when
packaged; fuses (RunAsNode, NODE_OPTIONS, `--inspect` off; **embedded asar integrity validation is
enforced on Windows**; only-load-from-asar); every IPC channel checks its sender; a packaged build
refuses a non-https API origin.

## Printing

Printers come from Windows (`webContents.getPrintersAsync`); a receipt is sent with
`webContents.print({ silent, deviceName, pageSize })`. The OS callback means the **spooler accepted** the
job, not that paper came out; the till records `submitted`, or `outcome_unknown` on failure, and never
resends automatically. Thermal printer drivers differ in how they honour a custom page size and margins;
this is a hardware acceptance item (`tests/windows/README.md`).

## Signing and updates

- **Code signing: not configured.** The installer and executable are unsigned (no certificate was
  supplied). Unsigned installers trigger SmartScreen warnings and electron-updater cannot verify the
  publisher of an update. A release requires the company's signing certificate and process.
- **Automatic updates:** see `docs/release/updates.md`.
- **Release inputs gate:** `npm run verify:release-inputs` refuses while any company identity,
  origin, feed, icon or signing input is a template value or missing. A package built while it fails
  is a test package, never a release candidate.

## Status

| Item                                                                   | Status                                                            |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------- |
| NSIS installer builds on Linux (x64, per-user, native module verified) | VERIFIED (build only)                                             |
| Install / launch / sell / upgrade / uninstall on Windows               | **BLOCKED** — no Windows environment; run `tests/windows/`        |
| Signed release candidate                                               | **BLOCKED** — signing inputs and production configuration missing |
