# Vue / Frontend Structure Rules

## Module Layout

```txt
src/renderer/src/modules/<domain>/
├── pages/         # route-level views, thin
├── components/     # module-specific components
├── store.ts         # Pinia store for this domain
├── service.ts        # calls API client / window.posApi
├── types.ts
└── composables/       # module-specific composables, if any
```

Shared, cross-module code lives in `src/renderer/src/shared/` (components, composables, API
client, types) — see `desktop-architecture.md` for the full target tree.

## Pinia Stores Per Domain

- One store per domain (`auth`, `pos`/`cart`, `catalog`, `shifts`, `sync`, `license`, `refunds`).
- Stores hold reactive state + orchestration actions; they call services, they are not services
  themselves import-order-wise (a store may call a service; a service must not import a store).
- Cross-domain workflows (e.g. "complete sale" touching cart, shift, and sync) live in a service
  that reads/writes multiple stores or repositories — not duplicated logic inside one store.

## Composables for UI Behavior

Reusable, non-domain UI behavior belongs in composables under `shared/composables/`:

- `useBarcodeScanner()` — captures fast keyboard-wedge input, distinguishes it from manual typing.
- `useOfflineStatus()` — exposes connectivity/sync state for banners/indicators.
- `useKeyboardShortcuts()` — registers/cleans up global shortcuts for cashier flows.
- `usePrintJob()` — wraps `window.posApi.print.*` with loading/error state for components.

Composables may read from stores; they should not contain business rules that belong in a store or
service.

## Component Categories

Components under `shared/components/` are split by role:

| Folder | Purpose |
|---|---|
| `common/` | Generic building blocks (Button, Input, Modal, Table) with no domain knowledge |
| `layout/` | App shell, sidebar, header, offline/sync status bar |
| `pos/` | POS-specific but reusable across pages (ProductTile, CartLine, NumericKeypad) |
| `forms/` | Form field groups, validation display |
| `feedback/` | Toasts, banners, loading/empty/error states |

Module-specific components that aren't reusable stay inside that module's own `components/`.

## Pages Stay Thin

A page/view:

- Reads state from its module's store (or a composable wrapping it).
- Dispatches store actions on user interaction.
- Contains layout and conditional rendering only.

A page must not: call `fetch`/`axios`/`window.posApi` directly, contain pricing/tax/discount math,
or decide sync/conflict behavior.

## Services Handle API/Main-Bridge Calls

- `shared/api/client.ts` — the one central HTTP client (see `backend-api-contract.md`).
- Module `service.ts` files call the central client and/or `window.posApi`, translate
  responses/errors into store-friendly shapes, and are the only place components indirectly reach
  either boundary (indirectly, via the store).

## Current State (evidence)

Only the stock scaffold exists today: `src/renderer/src/App.vue`, `main.ts`,
`components/Versions.vue`, `assets/*`. No router, no Pinia, no modules, no API client yet — all of
the structure above is Phase 1 scope (see `docs/phases/01-foundation-structure.md`).
