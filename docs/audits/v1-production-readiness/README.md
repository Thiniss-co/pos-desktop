# V1 production-readiness audit — pos-desktop

Date: 2026-10-08. Branch `feat/v1-production-readiness` (desktop slot 2), based on local `main` `76ff670`
(the V1 desktop-readiness release, fast-forwarded with the owner's approval). Scope:
[Phase 6](../../phases/06-hardening-testing-packaging.md) (security audit, test layers, packaging, contract
TODOs) plus touch numeric input and packaged-app testing. Local commits only; nothing pushed or deployed.
Backend counterpart: none — every change consumes `pos-backend` `b4c85cf` as it is.

## 1. Electron security audit (after the fixes on this branch)

| #   | Item                                                                                          | Result                             | Evidence                                                                                                                                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Main window: contextIsolation, nodeIntegration off, sandbox, webSecurity, no insecure content | PASS                               | `src/main/app/createMainWindow.ts`                                                                                                                                                                                                              |
| 2   | Hidden receipt window: no preload, own partition, `data:` only, permissions denied, no popups | PASS                               | `src/main/receipt/receiptRenderer.ts`                                                                                                                                                                                                           |
| 3   | No `remote` / `@electron/remote`                                                              | PASS                               | no reference in `src/` or `package.json`                                                                                                                                                                                                        |
| 4   | No generic ipcRenderer; one typed, frozen `window.posApi`                                     | PASS                               | `src/preload/index.ts`, `src/preload/posApi.ts`                                                                                                                                                                                                 |
| 5   | Zod validation on every IPC handler                                                           | PASS                               | every `ipcMain.handle` goes through `handleIpcRequest` (`safeParse`); no `ipcMain.on`                                                                                                                                                           |
| 6   | Sender/frame check on every IPC handler                                                       | **PASS (fixed)**                   | 41 channels had none; now `handleTrustedIpcRequest`. `src/main/ipc/ipcSenderCoverage.test.ts` fails on any unchecked channel                                                                                                                    |
| 7   | No raw SQL or filesystem bridge                                                               | PASS                               | `src/shared/constants/ipcChannels.ts`                                                                                                                                                                                                           |
| 8   | CSP                                                                                           | **PASS (fixed)**                   | header policy (`securityPolicy.ts`) and the `index.html` meta tag now carry the same directives except `frame-ancestors` (ignored in meta). `style-src 'unsafe-inline'` remains: Vue style bindings need it; no script relaxation in production |
| 9   | Navigation, popups, openExternal                                                              | **PASS (fixed)**                   | production navigation and the IPC sender check accept only the app's own `index.html` (was: any `file:` URL); popups denied; no `shell.openExternal`                                                                                            |
| 10  | webview                                                                                       | PASS / N/A                         | no `webviewTag`, no `<webview>`                                                                                                                                                                                                                 |
| 11  | Permission request/check handlers deny all                                                    | PASS                               | `securityPolicy.ts`, receipt partition                                                                                                                                                                                                          |
| 12  | Desktop token storage                                                                         | PASS with **open decision**        | main-only `safeStorage`; never in renderer storage. Linux `basic_text` backend (no keyring) is accepted silently — see §6                                                                                                                       |
| 13  | `/api/v1/admin/*` never called                                                                | PASS                               | only a deny guard, `src/main/http/desktopApiClient.ts`                                                                                                                                                                                          |
| 14  | No Node/env access in the renderer                                                            | PASS                               | only `import.meta.env.DEV`                                                                                                                                                                                                                      |
| 15  | Electron fuses                                                                                | **PASS (fixed)**                   | `electron-builder.yml` `electronFuses`: RunAsNode, NODE_OPTIONS, --inspect off; asar integrity, only-load-from-asar on. Read back from the packaged binary by journey `pkgapp`                                                                  |
| 16  | DevTools / default menu in production                                                         | **PASS (fixed)**                   | `devTools: !app.isPackaged`; no application menu when packaged (macOS keeps app + Edit)                                                                                                                                                         |
| 17  | Production API origin                                                                         | **PASS (fixed)** with release step | a packaged till refuses a loopback HTTP origin unless the build opted in (`MAIN_VITE_POS_ALLOW_LOOPBACK_ORIGIN=true`, test packages only); shown live by `pkgapp` step 0. A release build must set `MAIN_VITE_POS_API_ORIGIN=https://…`         |

Accepted, documented: `--remote-debugging-port` is not a fuse (it needs local access to start the
binary with arguments; the packaged-app journey uses it). `GrantFileProtocolExtraPrivileges` stays on
(`loadFile` serves the renderer from `file://`).

## 2. Packaging

- **Fixed: the package shipped the repository.** `app.asar` was 110 MB and contained `docs/`,
  `tests/`, `scripts/`, `.ai/`, `.claude/` and the Playwright harness build `out/pw-test` (virtual
  print boundary, fault seams, loopback origin). `files` is now an allowlist; `app.asar` is 26 MB with
  production paths only; `verify:cp3g5-package` fails on any other path.
- **Fixed:** snap target dropped; missing mac entitlements path and template usage strings removed;
  Linux category Office; description and window title; Windows AppUserModelId equals `appId`
  (checked by `verify:cp3g5-package`).
- Native module: `better-sqlite3` only, rebuilt for Electron by `postinstall`; correct for Linux x64.
  `npmRebuild: false` means win/mac packages must be built on their own OS (or set `npmRebuild: true`).
- **Linux sandbox on Ubuntu 24+:** Chromium needs user namespaces, which AppArmor now denies to
  unconfined binaries. The **.deb** installs an AppArmor profile (or the setuid `chrome-sandbox`), so an
  installed till starts normally. The **AppImage** has no installer and aborts ("SUID sandbox helper …
  not configured correctly") unless started with `--no-sandbox` or given a profile. Recommendation:
  ship the .deb for Ubuntu tills.

## 3. Touch numeric input

The on-screen keypad (`NumericAmountInput` / `NumericKeypad`) now serves every cashier amount: tender,
invoice discount, cart-line quantity, **shift opening float and counted cash**, and the **quick-create
product price** (capped at the catalog currency's minor units). A pre-filled shift amount is selected
on focus, so the first key replaces it. Evidence: component tests (`ShiftDialogs.test.ts`,
`QuickCreateDialog.test.ts`, `NumericKeypad.test.ts`, `PaymentPanel.test.ts`) and journey `qc5touch`
parts B, C, E and F (touch only, via CDP touch events). Not served: free-text fields (names, notes,
references), which use the system keyboard.

## 4. Test layers

See [testing-strategy.md](../../architecture/testing-strategy.md#live-journey-and-packaging-layers).
New: `ipcSenderCoverage.test.ts`, `securityPolicy.test.ts`, runtime-config packaging cases,
`handleTrustedIpcRequest` cases, touch component tests, journey `pkgapp` (packaged app) and `qc5touch`
part F. Gaps that remain (recorded, not blocking): about a third of IPC channels have no handler-level
contract test (their schemas and sender check are covered generically); route-guard redirects for
`NOT_BOUND` / `DEVICE_MISMATCH` / licence denial are covered at service level only.

## 5. Backend contract TODOs

Resolved and updated in the docs: shift routes, invoice/refund consumption, heartbeat, sync-status.
Still open (backend-owned or blocked upstream): OpenAPI import, cash-drawer routes (not consumed),
acknowledgement of allocation consumptions in the upload response, token refresh and re-registration
triggers, per-endpoint `data` shapes for catalog/customer/report routes until the OpenAPI import.

## 6. Pending decisions and infrastructure (not fixable locally)

| Item                                                                                                    | Needed                                                                                                                    |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Product identity: `appId` (`com.electron.app`), author, homepage, deb maintainer, icons (template icon) | Owner's real identifiers and artwork. Change `appId` and `setAppUserModelId` together                                     |
| Production API origin                                                                                   | The HTTPS origin, set as `MAIN_VITE_POS_API_ORIGIN` for the release build                                                 |
| Auto-update                                                                                             | Update server (publish URL is `example.com`); `electron-updater` is a dependency but never imported. Remove it or wire it |
| Code signing / notarization                                                                             | Windows certificate; Apple identity                                                                                       |
| Linux `basic_text` secret storage                                                                       | Decide: refuse to store the desktop token without a keyring, or accept and document                                       |
| AppImage on Ubuntu 24+                                                                                  | Ship the .deb, or document `--no-sandbox` / an AppArmor profile for the AppImage                                          |
| Physical printer and scanner                                                                            | Manual smoke on hardware; automated runs use the virtual boundary or an absent printer                                    |

## 7. Validation of this branch

Run on the exact tree `e40a792` (tree `691c231`), slot clean before and after, against a disposable
git-archive export of backend `b4c85cf` (own APP_KEY, SQLite sandboxes behind the guard). The
canonical backend tree, the real `~/.config/pos-desktop` profile and the committed receipt-profile
artifacts were fingerprinted before and after: unchanged.

| Gate                                                                                                                                                                                                    | Result                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                                                                                                                                                                                     | pass                                                                                                                                    |
| `npm run test` (vitest)                                                                                                                                                                                 | 1928 / 1928                                                                                                                             |
| `npm run test:sqlite:electron`                                                                                                                                                                          | 479 pass, 0 fail, 63 skipped (live-only cases; same as before this branch)                                                              |
| `npm run test:cp3g5-harness`                                                                                                                                                                            | 72 / 72                                                                                                                                 |
| `verify:fixture`, `verify:print-boundary`                                                                                                                                                               | pass                                                                                                                                    |
| Live CP-3G-5 gate (refund, receipt-profile, owner-product contexts, 32 payloads)                                                                                                                        | pass                                                                                                                                    |
| Backend targeted Pest (physical presence, disposition, sync status, refunds)                                                                                                                            | 76 / 76                                                                                                                                 |
| Journeys `qc5touch` (incl. new part F), `ps6bdisposition`, `qc2offline`, `qc4mixedtax`, `qc6receipts`, `qc7autoprint`, `stage7upload`, `e2offers`, `p3suspension`, `p6lifecycle`, `smoke`, **`pkgapp`** | pass                                                                                                                                    |
| Journey `ws2checkout`                                                                                                                                                                                   | **fails, baseline** — see below                                                                                                         |
| `npm run build:unpack` + `verify:cp3g5-package`                                                                                                                                                         | pass (app.asar production paths only; AUMID = appId)                                                                                    |
| `npm run build:linux`                                                                                                                                                                                   | pass: `pos-desktop-1.0.0.AppImage` (125 MB), `pos-desktop_1.0.0_amd64.deb` (98 MB)                                                      |
| `npm run lint`                                                                                                                                                                                          | 2 errors, 12 warnings — all pre-existing (`tests/electron/support/cp3g5/seedReliability.mjs` return types; warnings in untouched files) |

**`ws2checkout` part C** ("a lookup that finished after editing began reached the cart") failed in 4 of
4 runs on this branch and identically on `main` `76ff670` and on each intermediate commit (bisected),
while it passed twice earlier the same day on `76ff670`. The journey opens the editor with
`setTimeout(0)` and assumes the barcode lookup is still in flight then; when the IPC answer arrives
first, the add happens legitimately before editing begins. The product guard itself is intact
(`PosPage.vue`: an add is refused when editing is active before or after the lookup) and is covered by
`PosPage.offlineShiftAuthority.test.ts`, which also flakes under full-suite load on `main`. Follow-up:
make the race deterministic (hold the lookup in main, then begin editing).

Not verified here: Windows and macOS packages (Linux host only; build on each OS), installing the .deb
(needs root; the installer's AppArmor step is electron-builder's standard template), a physical
receipt printer, scanner or touchscreen.
