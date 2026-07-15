# Phase 1 — Foundation Structure and Configuration

## Goal

Turn the stock `electron-vite` Vue+TS scaffold into the app's real architectural skeleton: module
layout, routing, state management, a secure typed IPC bridge, and a local database foundation —
with no POS domain screens yet.

## Scope

- `vue-router` and `pinia` added as dependencies and wired into `src/renderer/src/main.ts`.
- `src/renderer/src/modules/` and `src/renderer/src/shared/` directory structure created per
  [.ai/guidelines/desktop-architecture.md](../../.ai/guidelines/desktop-architecture.md) and
  [.ai/guidelines/vue-structure.md](../../.ai/guidelines/vue-structure.md).
- Preload rewritten to expose `window.posApi` (narrow, typed) instead of the current blanket
  `electronAPI` exposure — see
  [../architecture/secure-preload-ipc.md](../architecture/secure-preload-ipc.md).
- `webPreferences.sandbox` flipped to `true` (or the specific blocking dependency documented).
- Zod added as a dependency for IPC payload validation.
- SQLite driver added; `src/main/database/` connection + migration runner scaffolded (schema can
  be minimal/empty at this stage — the mechanism matters more than the entity set).
- A test runner decided and configured, with `npm run test` added to `package.json` and at least
  one real test (e.g. envelope-shape or a trivial IPC contract test) proving the setup works.
- Shared TypeScript types location for IPC contracts, importable from both main/preload and
  renderer configs without breaking either `tsconfig.node.json` or `tsconfig.web.json`.

## Out of Scope

- Any real POS screen (login, catalog, cart, checkout, shifts, refunds).
- Any real backend call (auth, bootstrap, invoices, etc.).
- Any real sync queue logic beyond the schema/mechanism shape.
- Receipt printing implementation.
- Barcode scanning implementation.

## Deliverables

- `package.json` updated with new dependencies + `test` script.
- Router + Pinia wired, at least one placeholder route rendering to prove the shell works.
- `window.posApi` replacing `window.electron`/`window.api` in preload, with at least one working
  example capability (e.g. `device.getInfo()`) end to end (renderer → preload → IPC → main →
  response) to prove the pattern before Phase 2 builds real capabilities on top of it.
- `src/main/database/` with connection + migration runner + one trivial migration, proving startup
  migration works.
- Updated `docs/architecture/*` if the actual implementation differs from what those docs
  currently describe as "target."

## Verification Commands

```bash
npm run typecheck
npm run lint
npm run test          # newly added in this phase
npm run dev            # manual smoke: app launches, placeholder route renders, no console errors
```

## Done Criteria

- `npm run typecheck`, `npm run lint`, and `npm run test` all pass.
- `window.electron`/generic `ipcRenderer` exposure is gone from the built preload bundle.
- `sandbox: true` is set (or the exception is documented with a named reason).
- The example `window.posApi` capability works end-to-end when manually exercised via `npm run dev`.

## Next Phase

[02-activation-login-bootstrap.md](02-activation-login-bootstrap.md) — device registration, login,
secure token storage, bootstrap fetch + local persistence, license validation call.
