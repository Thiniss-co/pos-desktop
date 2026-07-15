---
name: pos-desktop-foundation
description: Set up or extend the base project structure — TypeScript config, Vue Router, Pinia, module layout, and docs — for the pos-desktop Electron/Vue POS app.
---

# POS Desktop Foundation

## When to Use

- Setting up Phase 1 foundation structure (module folders, router, Pinia, path aliases).
- Adding a new domain module (`src/renderer/src/modules/<domain>/`).
- Wiring a new page/route into the app shell.
- Reviewing whether project structure matches `.ai/guidelines/desktop-architecture.md` /
  `vue-structure.md`.

## Rules

- Follow `.ai/guidelines/desktop-architecture.md` and `.ai/guidelines/vue-structure.md` exactly —
  don't invent a different structure.
- Never add Nuxt, Nuxt modules, or Nuxt-style conventions (`pages/` auto-routing, `nuxt.config`) —
  this is a plain Vite + Vue Router app. Nuxt is reserved for a separate future project.
- New modules follow the fixed shape: `pages/`, `components/`, `store.ts`, `service.ts`,
  `types.ts`.
- Pages stay thin — no business logic, no direct API/IPC calls (must go through a store/service).
- Respect existing path aliases (`@renderer/*` → `src/renderer/src/*`, from `tsconfig.web.json`
  and `electron.vite.config.ts`) instead of introducing new ones ad hoc.
- Do not touch `src/main` or `src/preload` for pure UI-structure work — that's
  `pos-electron-security` / `pos-api-integration` territory.

## Steps

1. Read `.ai/guidelines/desktop-architecture.md` and `.ai/guidelines/vue-structure.md`.
2. Check current state: `find src/renderer/src -type f` — confirm what already exists before
   adding anything.
3. Create the module/page/store following the fixed shape; wire routing in
   `src/renderer/src/router` (create it if this is the first route beyond the template).
4. Keep the page thin; put logic in `store.ts`/`service.ts`.
5. Update `docs/architecture/desktop-frontend-architecture.md` if the change is structural
   (a new top-level module, not just a new page inside an existing one).

## Verification

- `npm run typecheck`
- `npm run lint`
- Manually confirm the new route renders via `npm run dev` (interactive check, not part of an
  automated pass).

## Common Mistakes

- Putting API/IPC calls directly in a `.vue` file instead of a service.
- Creating a new shared component under a module folder instead of `shared/components/`.
- Introducing a second router or a second Pinia root instance.
- Copying Nuxt conventions (file-based routing, auto-imports) into this Vite app.
