# Automatic updates (V1)

Status: **implemented; Windows upgrade NOT RUN** (there is no Windows environment for this work). An
isolated packaged upgrade on Linux AppImage is the supporting evidence (`pkgupdate` journey). No
production feed exists, and none has been published.

## How it works

| Piece                                                                    | Where                                                         |
| ------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Feed URL (build-time, like the API origin)                               | `src/main/update/updateFeed.ts`                               |
| electron-updater wiring (generic provider)                               | `src/main/update/electronUpdater.ts`                          |
| Checks, download, retry, the restart gate                                | `src/main/update/updateService.ts`                            |
| What a restart would interrupt                                           | `src/main/update/restartBlockers.ts`                          |
| IPC (`updates:get-status`, `check-now`, `restart-to-install`, `changed`) | `src/main/ipc/updates.ipc.ts` (sender-checked, Zod-validated) |
| Settings panel (EN/AR, light/dark)                                       | `src/renderer/src/modules/updates/`                           |

- **No feed, no updates.** `MAIN_VITE_POS_UPDATE_FEED_URL` is read at build time. Without it the
  service reports `not_configured` and never contacts anything. There is no default feed. A
  development (unpackaged) run never checks.
- **The feed must be HTTPS**, with no credentials, query or fragment. A loopback `http://` feed is
  accepted only in a test package built with `MAIN_VITE_POS_ALLOW_LOOPBACK_ORIGIN=true` (the same
  opt-in as a loopback API origin). That package is never a release candidate.
- **Background check and download.** The first check runs 30 seconds after start, then every
  4 hours. While the till is offline (backend unreachable) it waits and looks again 5 minutes
  later. After a failed check or download it retries in 1, 5 and 15 minutes, then hourly; a
  success resets the backoff. A download runs in the background (`autoDownload`).
- **Never installs by itself.** `autoInstallOnAppQuit` is off, so closing the app does not install,
  and `allowDowngrade` is off. The only way to install is the cashier's **Restart to update** in
  Settings.
- **The restart is refused while it would interrupt work.** The refusal names the reason in
  Settings:
  - `sale_in_progress`: a cart line or payment on screen, or a held checkout;
  - `refund_in_flight`;
  - `print_in_progress`;
  - `upload_in_flight` (a request is on the wire right now);
  - `catalog_install`.
    Once nothing is in progress, the app quits through its normal shutdown: workers stop and SQLite
    closes. The installer then runs silently and starts the new version.
- **Queued work does not block an update and is not lost.** Offline sales, refunds and quick-create
  requests waiting to upload are durable SQLite rows. The new version continues them with the same
  local IDs, idempotency keys and bytes. The queue does not have to be empty first. Settings,
  preferences, the device identity and the encrypted credentials sit in the same per-user profile
  (`%APPDATA%\pos-desktop`), which an upgrade never touches.

## Download integrity

- **SHA-512:** electron-updater checks every download against the SHA-512 in the feed's metadata
  (`latest.yml` on Windows, `latest-linux.yml` on Linux) before it is offered for install. A
  mismatch is an `error` and is retried; it is never installed.
- **TLS:** the feed is HTTPS, verified by Chromium's network stack. TLS verification is never
  turned off, and there is no option to turn it off.
- **Windows publisher signature, required:** electron-updater compares a downloaded installer's
  Authenticode signature with the publisher recorded at build time (`publisherName` in
  `resources/app-update.yml`). electron-builder records it when the build is signed, or when
  `win.signtoolOptions.publisherName` is set. electron-updater itself **skips** the check when no
  publisher is recorded (an unsigned build) and **accepts** the update when PowerShell cannot run.
  This app closes both gaps:
  - `src/main/update/updateSigning.ts`: a Windows build with a real (HTTPS) feed and no recorded
    publisher refuses automatic updates. Its status is `not_configured` with `UNSIGNED_BUILD`, and
    Settings says the build is not signed. The only exception is an unsigned internal test build on
    its explicitly opted-in loopback test feed, which Settings labels "checksum only (internal test
    build)".
  - `src/main/update/authenticode.ts`: the Windows signature check fails closed. It requires Status
    Valid, the same file, and the recorded publisher: the full DN when one is recorded, otherwise the
    CN. Any failure to run PowerShell, a timeout, stderr output or unreadable output refuses the
    update (`ERR_UPDATER_INVALID_SIGNATURE`). Record the full DN as the publisher, not just the CN.
  - Settings shows how updates are verified: "checksum and publisher signature", or "checksum only
    (internal test build)".
- **Unsigned packages are internal test builds.** They cannot update from a real feed. The current
  packages are unsigned.
- **Linux** (supporting evidence only): the AppImage updater has no publisher check, so it is
  checksum-only and reported as such.
- The metadata and the installer come from the same origin, so whoever controls the feed controls
  the update. The feed must be operated by the company, behind HTTPS, with write access limited to
  the release process.

## Release inputs still missing

These must be supplied; none are invented here:

- The production update-feed URL (HTTPS, company-operated). It replaces the template
  `publish.url: https://example.com/auto-updates` in `electron-builder.yml` and `dev-app-update.yml`.
- A Windows code-signing certificate and the signing process. Secrets never go into the repository.
- The publisher name that matches the certificate subject.

## Publishing a release (for the release owner; not done in this work)

1. Build with the real values:
   ```
   MAIN_VITE_POS_API_ORIGIN=https://<api> MAIN_VITE_POS_UPDATE_FEED_URL=https://<feed>/ \
     npm run build:win
   ```
   The build is signed by the company's signing step.
2. Upload `pos-desktop-<version>-setup.exe`, its `.blockmap` and `latest.yml` to the
   feed. Upload `latest.yml` **last**, so no till sees metadata before its installer is there.
3. Tills pick the update up within 4 hours (or at once with **Check now**). Each till installs only
   when its cashier presses **Restart to update** with nothing in progress.

The version must increase (semver). The feed never serves an older version, because downgrades are
refused.

## Evidence

| Check                                                                                               | Status                                                                                     |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Service: background check, download, bounded retry, offline wait, no install on quit, restart gate  | VERIFIED — `src/main/update/updateService.test.ts`                                         |
| Feed URL rules (HTTPS only, loopback opt-in, no credentials)                                        | VERIFIED — `src/main/update/updateFeed.test.ts`                                            |
| Restart blockers read from the real database and the draft/payment gate                             | VERIFIED — `tests/electron/suites/v1LongRunning.suite.ts`                                  |
| Settings panel (status, blockers, restart only on request)                                          | VERIFIED — `SoftwareUpdatePanel.test.ts`                                                   |
| Real packaged A→B upgrade with a pending offline sale (Linux AppImage, isolated feed)               | See `pkgupdate` journey results in the readiness report (supporting evidence only)         |
| Real packaged A→B upgrade on Windows (NSIS)                                                         | **NOT RUN** — no Windows environment (`tests/windows/README.md`)                           |
| Unsigned Windows build refuses a real feed; test build labelled; status and Settings                | VERIFIED — `updateSigning.test.ts`, `updateService.test.ts`, `SoftwareUpdatePanel.test.ts` |
| Fail-closed signature decision (Valid, path, CN/DN publisher, PowerShell failure, stderr)           | VERIFIED (logic) — `authenticode.test.ts`                                                  |
| electron-builder records `publisherName` in the format the app reads                                | VERIFIED — NSIS build with `win.signtoolOptions.publisherName`; parser fixture             |
| Signing a Windows binary on this host                                                               | **BLOCKED** — electron-builder's `osslsigncode` needs OpenSSL 1.1 (absent on Ubuntu 26.04) |
| Signed-update verification running on Windows (accept; wrong publisher, unsigned, tampered refused) | **NOT RUN** — no Windows environment, no signing certificate (`tests/windows/README.md` E) |
