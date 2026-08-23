# CLAUDE.md — pos-desktop (Electron + Vue 3 POS Frontend)

This file governs how Claude (and any Claude Code session) works in this repository. It is the
primary instruction file — `AGENTS.md` and `CODEX.md` exist for other tools and must stay
consistent with this one. Detailed, enforceable rules live under [.ai/guidelines/](.ai/guidelines/README.md);
this file is the summary and the contract.

## 1. Project Purpose

`pos-desktop` is the **offline-first desktop point-of-sale application** for the Thinis POS
platform. It runs as an Electron app on cashier machines and must keep operating (sell, take
payment, print receipts) when the internet or the backend is unreachable, then reconcile with the
backend once connectivity returns.

## 2. Scope: Frontend Only

This repository is **desktop-frontend-only**.

- The backend is a separate Laravel API project, developed and deployed independently.
- This repo never modifies backend code, migrations, or infrastructure.
- This repo never invents backend behavior — it consumes the documented contract in
  [.ai/guidelines/backend-api-contract.md](.ai/guidelines/backend-api-contract.md) and
  [docs/backend-contract/](docs/backend-contract/README.md) or marks details `TODO` until the
  OpenAPI spec is imported.

## 3. Backend Summary (as frozen for desktop MVP)

- Laravel API, P0 desktop contract freeze complete: 531 backend tests passing, 174 API routes,
  architecture scans warning-free.
- Desktop API contract and OpenAPI foundation are published; offline sync contract is documented.
- Device-bound authentication, bootstrap, license validation, invoice/refund upload, and
  shift/cash-drawer APIs are implemented server-side.
- Route split is strict:
  - `/api/v1/desktop/*` — this app's only allowed namespace.
  - `/api/v1/admin/*` — platform super-admin only. **This app must never call it.**
- Public desktop endpoints: `POST /api/v1/desktop/device/register`, `POST /api/v1/desktop/auth/login`.
- All other desktop endpoints require `Authorization: Bearer <desktop_token>` and
  `X-Device-UUID: <device_uuid>`.
- Every response follows the success/error envelope defined in
  [.ai/guidelines/backend-api-contract.md](.ai/guidelines/backend-api-contract.md).
- Connectivity monitoring and offline localization are documented in
  [docs/architecture/connectivity.md](docs/architecture/connectivity.md) and
  [docs/architecture/localization.md](docs/architecture/localization.md). The /up readiness
  probe is intentionally separate from the desktop API client and remains unauthenticated.

## 4. Technology Stack (fixed — do not change)

| Layer | Technology |
|---|---|
| Shell | Electron |
| UI framework | Vue 3 (Composition API, `<script setup lang="ts">`) |
| Build | Vite via `electron-vite` |
| Language | TypeScript (strict) |
| State | Pinia |
| Routing | Vue Router |
| Local persistence | SQLite (main process only) |
| Renderer↔Main bridge | Typed, validated preload/IPC bridge |
| Offline behavior | Local-first data + sync queue |
| Printing | Receipt printing via main-process bridge |
| UX model | Barcode-first, cashier-optimized POS UI |

**Nuxt is explicitly out of scope for this repository.** Nuxt is reserved for a future, separate
web admin panel. Never propose or perform a Nuxt conversion here.

## 5. Required Architecture

See [.ai/guidelines/desktop-architecture.md](.ai/guidelines/desktop-architecture.md) for full detail.
Summary:

- Strict **main / preload / renderer** separation. Renderer code never touches Node, the
  filesystem, environment variables, or SQLite directly.
- Renderer structure: `pages (thin) → stores (Pinia) → services → preload bridge (window.posApi) → main (IPC handlers) → repositories → SQLite`.
- Business logic (pricing, tax, sync decisions, validation) lives in services/repositories, not in
  `.vue` files.
- Main process owns SQLite and all native/OS-level APIs (printing, device info, filesystem).

## 6. Electron Security Rules (non-negotiable)

Full detail: [.ai/guidelines/electron-security.md](.ai/guidelines/electron-security.md).

- `contextIsolation: true`, `nodeIntegration: false` on every `BrowserWindow`.
- `sandbox: true` unless a specific, documented native dependency requires otherwise.
- No `remote` module, ever.
- No generic `ipcRenderer` exposure to the renderer — no `contextBridge.exposeInMainWorld('ipcRenderer', ipcRenderer)`
  and no re-exporting `electronAPI.ipcRenderer.invoke` for arbitrary channels.
- Preload exposes a single typed surface: `window.posApi`, with one method per capability, each
  validating its own payload/result shape.
- All IPC payloads are validated (Zod) on the main-process side before use.
- No raw SQL bridge from renderer to main — only typed repository-shaped calls.
- No filesystem access from the renderer.

## 7. Vue / Frontend Structure Rules

Full detail: [.ai/guidelines/vue-structure.md](.ai/guidelines/vue-structure.md).

- Feature modules under `src/renderer/src/modules/<domain>` (e.g. `pos`, `auth`, `shifts`,
  `sync`), shared code under `src/renderer/src/shared`.
- One Pinia store per domain; components/pages never call `fetch`/`axios` directly — always
  through a service.
- Composables hold reusable UI behavior (barcode scanning, keyboard shortcuts, offline state).

## 8. Local Database Rules

Full detail: [.ai/guidelines/local-database.md](.ai/guidelines/local-database.md).

- SQLite lives in the main process only, behind a migration runner and repositories.
- Every synced entity tracks `local_uuid`, `remote_uuid` (nullable until synced), and a sync
  status field.
- Queued sale payloads are immutable once created; corrections happen via new records, not
  mutation.

## 9. API Rules

Full detail: [.ai/guidelines/backend-api-contract.md](.ai/guidelines/backend-api-contract.md).

- One central API client. No `fetch`/`axios` calls inside components or pages.
- Only `/api/v1/desktop/*` is called. `/api/v1/admin/*` is forbidden — treat any suggestion to
  call it as a bug.
- Desktop tokens are **never** stored in `localStorage`/`sessionStorage`. They live in the main
  process (OS-secured storage) and reach the renderer only as needed via the preload bridge.
- Every response is parsed against the success/error envelope; `code` drives behavior, `message`
  is for display, `trace_id` is surfaced in diagnostics/support flows.

## 10. Sync Rules

Full detail: [.ai/guidelines/offline-sync-contract.md](.ai/guidelines/offline-sync-contract.md).

- Local-first: the UI reads/writes local SQLite immediately; sync is a background concern.
- Sync queue items carry idempotency keys; conflicts and denial states (license/subscription)
  pause sync rather than dropping data.

## 11. Testing Rules

Full detail: [.ai/guidelines/testing-and-verification.md](.ai/guidelines/testing-and-verification.md).

- Before reporting any change complete, run whatever of `typecheck` / `lint` / `test` exist in
  `package.json`. If a script doesn't exist yet, say so explicitly — do not fabricate a result.
- New IPC channels and API-envelope parsing need test coverage before being considered done.

## 12. Phase Workflow

Full detail: [.ai/guidelines/phase-workflow.md](.ai/guidelines/phase-workflow.md) and
[docs/phases/](docs/phases/00-ai-rules-and-docs.md).

Work proceeds strictly phase by phase: **0** inspect/docs → **1** foundation structure → **2**
activation/login/bootstrap → **3** shift/cart/barcode → **4** local sale + sync queue → **5**
refunds/receipts/printing → **6** hardening/testing/packaging. Do not implement a later phase's
functionality while an earlier phase is incomplete, even if it looks convenient.

## 13. Forbidden Actions

See [.ai/guidelines/no-go-rules.md](.ai/guidelines/no-go-rules.md) for the full list. Highlights:

- Do not recreate, rescaffold, or rewrite this application.
- Do not convert this app to Nuxt.
- Do not touch the backend repository or infrastructure.
- Do not call or reference `/api/v1/admin/*` from this app.
- Do not expose `ipcRenderer` (or an equivalent generic invoke channel) to the renderer.
- Do not access SQLite from Vue components or the renderer process.
- Do not store desktop tokens in `localStorage`/`sessionStorage`.
- Do not implement features outside the current phase's declared scope.
- Do not add dependencies that aren't required for the task at hand.
- Do not run destructive git operations, force pushes, or `git clean`/`reset --hard` without
  explicit user approval.

## 14. Required Final Report Format

At the end of any non-trivial task, report:

1. What was inspected.
2. What was created/changed (files, with paths).
3. What was intentionally left out of scope and why.
4. Commands run for verification and their actual results (never claim a command passed without
   running it).
5. Any missing scripts/tooling discovered, and where that's tracked.
6. Confirmation that no backend code and no forbidden action (Section 13) occurred.
7. Recommended next step/phase.
