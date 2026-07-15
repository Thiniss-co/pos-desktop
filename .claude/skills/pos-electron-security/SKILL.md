---
name: pos-electron-security
description: Harden or extend Electron main/preload/renderer boundaries, secure IPC, and token storage for the pos-desktop app.
---

# POS Electron Security

## When to Use

- Adding or modifying `BrowserWindow` creation / `webPreferences`.
- Adding a new `window.posApi` capability (preload + main handler pair).
- Reviewing token storage, printing bridge, or filesystem access patterns.
- Any task touching `src/main/index.ts`, `src/preload/`, or anything under `src/main/ipc/`.

## Rules

Full detail: `.ai/guidelines/electron-security.md`, `.ai/guidelines/ipc-contracts.md`.

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` (unless a documented,
  dependency-specific exception exists) on every `BrowserWindow`.
- Never add the `remote` module.
- Never expose `ipcRenderer` (or a generic `invoke(channel, ...)`) to the renderer. Every
  capability is a named method on `window.posApi`.
- Every IPC handler validates its payload with Zod before doing anything with it.
- No raw SQL, no raw filesystem paths, no raw printer/device handles cross the IPC boundary.
- Desktop tokens are stored/held in the main process (or OS-secured storage), never in
  renderer-accessible storage (`localStorage`, `sessionStorage`, cookies).

## Steps

1. Read `.ai/guidelines/electron-security.md` and `.ai/guidelines/ipc-contracts.md` in full before
   editing `src/main` or `src/preload`.
2. For a new capability: define the request/response types once (shared location importable from
   both main and preload without pulling in DOM/Node globals inappropriately), add the Zod schema,
   add the `ipcMain.handle` in main, add the matching method on the `posApi` object in preload.
3. Never add a handler "just in case" — only what the current phase's task actually needs.
4. If you must set `sandbox: false` or otherwise weaken a default, write down which specific
   dependency requires it, next to the setting.

## Verification

- `npm run typecheck` (both `tsconfig.node.json` and `tsconfig.web.json` paths).
- `npm run lint`.
- Manually launch (`npm run dev`) and check DevTools console for Electron security warnings
  (contextIsolation/nodeIntegration/CSP warnings show up there).
- Confirm in DevTools that `window.posApi` exposes only the intended named methods — no
  `window.require`, no `window.electron.ipcRenderer` generic invoke.

## Common Mistakes

- Exposing the whole `electronAPI` object from `@electron-toolkit/preload` (includes a generic
  `ipcRenderer`) instead of a narrow `posApi` surface — this is the current scaffold's state and
  must not be extended, only replaced.
- Skipping Zod validation "because the renderer already validates it" — main must not trust the
  renderer.
- Returning raw driver/exception objects from a handler instead of a sanitized `{ code, message }`
  shape.
- Widening `webPreferences` (e.g. `nodeIntegration: true`) to work around an unrelated bug instead
  of fixing the actual bridge.
