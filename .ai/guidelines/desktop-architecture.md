# Desktop Architecture Rules

## Process Separation

The app is three isolated worlds. Code must never blur these boundaries:

| Process | Location | Has access to | Does not have access to |
|---|---|---|---|
| Main | `src/main/**` | Node.js, filesystem, SQLite, OS APIs, printers, `BrowserWindow` | Vue, DOM |
| Preload | `src/preload/**` | `contextBridge`, a narrow slice of Node needed to build the bridge | Business logic, SQLite queries, arbitrary Node APIs at runtime from renderer's perspective |
| Renderer | `src/renderer/src/**` | Vue 3, DOM, `window.posApi` (typed bridge only) | Node, `fs`, `process.env`, SQLite, raw `ipcRenderer` |

Rule of thumb: **if it touches the OS, a file, a database, or a printer, it lives in `src/main`.**
The renderer only ever asks for data/actions through `window.posApi` and receives typed results.

## Layered Flow (Renderer Side)

```txt
pages/views (thin)
   -> Pinia stores (state + orchestration)
      -> services (API client, sync service, print service)
         -> preload bridge (window.posApi)
            -> IPC (main process handlers)
               -> repositories (SQLite access, one per entity)
                  -> SQLite (main process only)
```

- **Pages/views**: layout + user interaction only. No fetch, no SQL, no cross-cutting business
  rules. A page calls a store action and renders store state.
- **Stores (Pinia)**: one per domain (`auth`, `catalog`, `cart`, `shifts`, `sync`, `license`,
  etc.). Own the domain's reactive state and orchestrate service calls. May contain
  domain-specific derived logic (e.g. cart totals) but not I/O.
- **Services**: the only place allowed to call the API client, the preload bridge, or
  cross-domain logic (e.g. "finalize sale" touching cart + shift + sync). Pure-ish, testable,
  framework-agnostic where possible.
- **Preload bridge / IPC / repositories / SQLite**: see `electron-security.md`,
  `ipc-contracts.md`, `local-database.md`.

## No Business Logic in Vue Pages

Pricing, tax computation, discount rules, sync-conflict resolution, and validation are **service
or store logic**, not `.vue` template/script logic. A `.vue` file should be readable as "what does
the user see and do here," not "how does the system decide X."

## Module-Based Frontend Structure (target — lands starting Phase 1)

```txt
src/renderer/src/
├── modules/
│   ├── auth/          # login, device registration, session
│   ├── bootstrap/      # bootstrap fetch + local persistence
│   ├── pos/            # cart, product search, checkout
│   ├── shifts/         # shift open/close/pause, cash drawer
│   ├── refunds/        # refund flow
│   ├── sync/            # sync queue UI/state, conflict/quarantine views
│   └── license/         # license/subscription status, grace warnings
│       each module/: pages/ | components/ | store.ts | service.ts | types.ts
├── shared/
│   ├── components/     # common/, layout/, forms/, feedback/
│   ├── composables/    # useBarcodeScanner, useOfflineStatus, useShortcuts, ...
│   ├── api/             # central API client, envelope parsing
│   └── types/           # cross-module shared types
├── router/
├── stores/              # only if a store is genuinely cross-module; prefer module-local stores
└── App.vue, main.ts
```

This structure does not exist yet in the current scaffold (only `App.vue`, `main.ts`,
`components/Versions.vue` exist). Introducing it is Phase 1 scope — see
`phase-workflow.md` and `docs/phases/01-foundation-structure.md`.

## Main Process Owns Native/SQLite

- SQLite connection, schema/migrations, and all repositories live under `src/main` (e.g.
  `src/main/database/`, `src/main/repositories/`).
- Printing, device UUID generation, secure token storage, and filesystem access live under
  `src/main` as well, each exposed through one narrow IPC handler.
