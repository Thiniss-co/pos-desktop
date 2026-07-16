# Electron Security Rules

These rules are non-negotiable for a POS app handling payment data, auth tokens, and device
identity. Every rule below states the requirement and where to verify it in this repo.

## 1. `contextIsolation: true`

Required on every `BrowserWindow`'s `webPreferences`. Electron defaults to `true` since v12; keep
it explicit once `webPreferences` is otherwise customized. Verify: `src/main/index.ts`
`webPreferences` block.

## 2. `nodeIntegration: false`

Required — never set `nodeIntegration: true`. The renderer must have zero direct Node access.

## 3. `sandbox: true` where compatible

Current scaffold sets `sandbox: false` in `src/main/index.ts` (template default, needed historically
for some preload patterns). Target for this app: `sandbox: true`. If a native dependency genuinely
requires `sandbox: false`, document the specific dependency and reason next to the setting — don't
disable sandboxing silently "to make something work."

## 4. No `remote` Module

The `@electron/remote` module (or legacy `electron.remote`) must never be added as a dependency or
imported anywhere in this repo.

## 5. No `ipcRenderer` Exposed to the Renderer

- Do not do `contextBridge.exposeInMainWorld('ipcRenderer', ipcRenderer)`.
- Do not expose `electronAPI.ipcRenderer` (from `@electron-toolkit/preload`) as a generic
  invoke/on passthrough for arbitrary channel names. The template bridge was removed in Phase 1;
  maintain the narrow, named `window.posApi` surface described in `ipc-contracts.md`.

## 6. Typed Preload Bridge Only

`window.posApi` exposes one function per capability (`login`, `getBootstrap`, `queueSale`,
`printReceipt`, ...), each with a fixed TypeScript signature. No capability may accept an arbitrary
channel name or arbitrary handler as an argument.

## 7. Input Validation with Zod

Every IPC handler in `src/main` validates its incoming payload with a Zod schema before touching
SQLite, the filesystem, or the network. Invalid payloads are rejected with a typed error, never
passed through.

## 8. No Raw SQL From Renderer

The renderer never constructs or sends SQL. It calls a named `window.posApi` method
(`posApi.sales.queue(payload)`); the main process repository decides the SQL.

## 9. No Filesystem Access From Renderer

`fs`, `path` (for arbitrary paths), and similar Node modules are never imported in
`src/renderer/**`. File operations (export, license file read, log write) go through a main-process
handler.

## 10. Safe Printing Bridge

Receipt printing is invoked via `window.posApi.print.receipt(payload)`, validated in main, and
executed against a specific, configured printer — the renderer never receives raw printer/device
handles or OS-level print API access.

## 11. Additional Hardening Checklist

| Item | Requirement |
|---|---|
| Navigation | `webContents.on('will-navigate', ...)` restricts navigation to the app's own renderer origin/file. |
| New windows/popups | `setWindowOpenHandler` denies in-app window creation for arbitrary URLs; external links open via `shell.openExternal` only (already present for all `details.url` in the current scaffold — tighten in Phase 1 to allow-list trusted destinations, e.g. printer driver help links, rather than opening any URL). |
| Permission requests | `session.setPermissionRequestHandler` denies by default; only grant what a feature explicitly needs (e.g. USB/serial for a barcode scanner or printer, if used). |
| CSP | A restrictive `Content-Security-Policy` is set (meta tag or response header) once the renderer serves richer content; at minimum disallow remote script execution. |
| Preload scope | Preload script only imports what it needs to build the bridge — no incidental Node API exposure via closures. |
| Token storage | Desktop tokens are held in main-process memory / OS-secured storage (e.g. `keytar`-equivalent or an encrypted local store), never in renderer `localStorage`/`sessionStorage`/`cookies`. |

## Current State vs. Target (evidence-based)

| Requirement | Current state | Status |
|---|---|---|
| `contextIsolation` | Explicit `true` | Hardened |
| `nodeIntegration` | Explicit `false` | Hardened |
| `sandbox` | Explicit `true` | Hardened; Linux helper prerequisite documented |
| `remote` module | Not present | Hardened |
| `ipcRenderer` exposure | Five named frozen `window.posApi` methods only | Hardened |
| Payload validation | Every foundation handler validates a Zod input schema | Hardened |
| CSP | Runtime dev/prod header plus template meta CSP | Hardened |
