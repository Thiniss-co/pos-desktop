# Electron Process Model

## Processes in This App

| Process | Entry point | Runtime |
|---|---|---|
| Main | [src/main/index.ts](../../src/main/index.ts) | Node.js (full OS access) |
| Preload | [src/preload/index.ts](../../src/preload/index.ts) | Node.js subset, runs before renderer scripts, bridges via `contextBridge` |
| Renderer | [src/renderer/src/main.ts](../../src/renderer/src/main.ts) → [App.vue](../../src/renderer/src/App.vue) | Chromium (Vue 3 SPA), no Node |

Build orchestration: [electron.vite.config.ts](../../electron.vite.config.ts) defines separate
build targets for `main`, `preload`, and `renderer` (electron-vite convention); output goes to
`out/main`, `out/preload`, `out/renderer` (see `main` field in
[package.json](../../package.json): `./out/main/index.js`).

## Main Process Responsibilities

- App lifecycle (`app.whenReady`, `window-all-closed`, `activate`) — current implementation in
  `src/main/index.ts:41-71`.
- `BrowserWindow` creation and `webPreferences` (security-critical — see
  [secure-preload-ipc.md](secure-preload-ipc.md)).
- All IPC handler registration (target: organized under `src/main/ipc/`, one module per domain).
- SQLite connection, migrations, repositories (target: `src/main/database/`).
- Printing, device identity, secure token storage, outbound HTTP to the backend.

## Preload Responsibilities

- The sole place `contextBridge.exposeInMainWorld` is called.
- Assembles and exposes `window.posApi` — see
  [secure-preload-ipc.md](secure-preload-ipc.md) and
  [.ai/guidelines/ipc-contracts.md](../../.ai/guidelines/ipc-contracts.md).
- Contains no business logic — purely wiring between `ipcRenderer.invoke` calls and the typed
  surface.

## Renderer Responsibilities

- Vue 3 app: routing, Pinia stores, UI components, presentation logic.
- Reaches main-process capability exclusively through `window.posApi`.
- Bootstrapped in [src/renderer/src/main.ts](../../src/renderer/src/main.ts), mounted into
  [src/renderer/index.html](../../src/renderer/index.html).

## Window Creation (current state)

`createWindow()` in `src/main/index.ts`:

- 900×670 window, `show: false` until `ready-to-show` (avoids a white-flash on load).
- `webPreferences.preload` points at the built preload bundle; `sandbox: false` is set explicitly
  (template default — target is `true`, see
  [secure-preload-ipc.md](secure-preload-ipc.md)).
- Loads `ELECTRON_RENDERER_URL` in dev (Vite dev server) or the built `index.html` in production.
- `setWindowOpenHandler` denies in-app window creation and forwards to `shell.openExternal` —
  functional today but not yet allow-listed to specific trusted destinations (Phase 6 hardening).

## Process Boundary Enforcement

Enforcement mechanisms, from strongest to weakest:

1. **Build-time**: `tsconfig.node.json` scopes `src/main` + `src/preload`; `tsconfig.web.json`
   scopes `src/renderer/src` — each type-checks independently, catching accidental cross-imports
   of Node-only or DOM-only APIs at compile time.
2. **Runtime**: `contextIsolation` + no generic `ipcRenderer` exposure means renderer code
   physically cannot reach Node/main-process memory even if it tried.
3. **Convention/review**: `.ai/guidelines/desktop-architecture.md` and this doc are what a
   reviewer (human or AI) checks a change against.
