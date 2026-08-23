# CODEX.md — Task Guide for Codex in `pos-desktop`

Companion to [AGENTS.md](AGENTS.md) (behavioral rules) and [CLAUDE.md](CLAUDE.md) (project
contract). This file is the practical command/standards reference.

## Recommended Commands

```bash
# install (only when explicitly asked to install/update deps)
npm install

# development (long-running — do not launch as a "verification" step)
npm run dev

# preview a build
npm run start

# verification (safe, read-only in effect)
npm run typecheck     # tsc -p tsconfig.node.json + vue-tsc -p tsconfig.web.json, no emit
npm run lint          # eslint --cache .   (does NOT auto-fix)

# formatting (MUTATES files — only run when the task is explicitly "format the code")
npm run format        # prettier --write .

# packaging (produces installers — do not run casually)
npm run build
npm run build:win
npm run build:mac
npm run build:linux
npm run build:unpack
```

npm run test runs the Vitest unit suite. Run it alongside type checking and linting for changes to
contracts, IPC, services, stores, or localized UI.

## Repository Structure

```txt
pos-desktop/
├── electron.vite.config.ts     # electron-vite build config (main/preload/renderer)
├── electron-builder.yml        # packaging config
├── tsconfig.json                # project-references root
├── tsconfig.node.json           # main + preload TS config
├── tsconfig.web.json            # renderer TS config (@renderer/* alias)
├── eslint.config.mjs
├── .prettierrc.yaml
├── src/
│   ├── main/                    # Electron main process (Node context)
│   │   └── index.ts             # app lifecycle, BrowserWindow creation
│   ├── preload/                 # contextBridge boundary
│   │   ├── index.ts
│   │   └── index.d.ts
│   └── renderer/                # Vue 3 app (browser context, no Node)
│       ├── index.html
│       └── src/
│           ├── main.ts          # Vue app bootstrap
│           ├── App.vue
│           ├── components/
│           └── assets/
├── resources/                   # packaged assets (icons, etc.)
├── build/                       # electron-builder resources (icons, entitlements)
├── .ai/guidelines/              # enforceable architecture/security rules
├── .claude/skills/              # Claude skill definitions for this project
└── docs/                        # architecture, backend contract, phase docs
```

This is currently the stock `electron-vite` Vue+TS template — no POS domain code exists yet
(`src/renderer/src/modules`, stores, services, and the local database layer are Phase 1+ work).

## Implementation Standards

- One capability per PR/task where possible; keep diffs scoped to the active phase.
- Never introduce a second way to do something the architecture already defines a way for
  (e.g. a second API client, a second IPC pattern).
- Every new IPC channel: named, typed request/response, validated on the main side, documented in
  `.ai/guidelines/ipc-contracts.md`-style shape.
- Connectivity and localization behavior are defined in docs/architecture/connectivity.md and
  docs/architecture/localization.md; preserve their main-process ownership, offline behavior, and
  restricted bridge surface.

## TypeScript Standards

- Strict mode (inherited from `@electron-toolkit/tsconfig`). No `any`, no `@ts-ignore` to silence
  real errors (the one existing `@ts-ignore` in `src/preload/index.ts` is template boilerplate for
  the non-isolated-context fallback — do not treat it as a pattern to copy).
- Main/preload code type-checks against `tsconfig.node.json`; renderer code against
  `tsconfig.web.json`. Keep types that cross the boundary (IPC payloads/results) in a shared
  location importable from both sides without pulling in Node or DOM globals inappropriately.
- Use the `@renderer/*` alias inside renderer code instead of deep relative imports.

## Vue Standards

- `<script setup lang="ts">` only. Composition API only.
- Pages/views stay thin: template + store/composable calls. Logic lives in stores, services, or
  composables — see `.ai/guidelines/vue-structure.md`.
- Components are organized by role: `common/`, `layout/`, `pos/`, `forms/`, `feedback/` once the
  module structure lands (Phase 1) — not yet present in the current scaffold.

## Electron Standards

- Every `BrowserWindow`: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
  unless a documented exception exists.
- All Node/OS/SQLite/printing access lives in `src/main`, exposed to the renderer only through the
  typed `window.posApi` preload surface.
- No `remote` module, no generic `ipcRenderer.invoke` passthrough to the renderer.

## Testing Standards

- Run `npm run typecheck` and `npm run lint` before considering any code task done.
- Unit-test API envelope parsing, IPC contract validation, connectivity transitions, locale
  resolution, sync-queue state transitions, and route guards, per
  `.ai/guidelines/testing-and-verification.md`.
- Manual smoke test checklist lives in `.ai/guidelines/testing-and-verification.md` — use it for
  anything a unit test can't cover (barcode input, print bridge, offline banner).

## Commit / Checklist Guidance

Before finishing a task:

- [ ] Change is scoped to the current phase (`docs/phases/*.md`).
- [ ] `npm run typecheck` run and passing (or failure explained).
- [ ] `npm run lint` run and passing (or failure explained).
- [ ] No forbidden action from `.ai/guidelines/no-go-rules.md` occurred.
- [ ] No new dependency added without a stated reason.
- [ ] No secrets, tokens, or production URLs hardcoded.
- [ ] Report follows the format in `CLAUDE.md` §14 / `AGENTS.md` "How to Report Results".

Do not create a git commit unless explicitly asked to.
