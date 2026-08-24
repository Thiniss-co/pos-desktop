# .ai/ — AI Guideline Index

This directory holds the enforceable, practical rules that `CLAUDE.md`, `AGENTS.md`, and
`CODEX.md` summarize. When those root files and a guideline here seem to disagree, the guideline
here is the detailed source of truth — update both together.

## Guidelines

| File                                                                  | Covers                                                                       |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [desktop-architecture.md](guidelines/desktop-architecture.md)         | main/preload/renderer split, service/repository/store pattern, module layout |
| [electron-security.md](guidelines/electron-security.md)               | window hardening, IPC exposure, validation, printing bridge                  |
| [vue-structure.md](guidelines/vue-structure.md)                       | module layout, stores, composables, component categories                     |
| [backend-api-contract.md](guidelines/backend-api-contract.md)         | desktop routes, auth headers, envelope, error handling                       |
| [offline-sync-contract.md](guidelines/offline-sync-contract.md)       | sync queue states, idempotency, conflict/quarantine rules                    |
| [local-database.md](guidelines/local-database.md)                     | SQLite ownership, migrations, repositories, sync fields                      |
| [ipc-contracts.md](guidelines/ipc-contracts.md)                       | `window.posApi` shape, channel typing, validation                            |
| [pos-ux-rules.md](guidelines/pos-ux-rules.md)                         | cashier-first UX, barcode input, offline/sync indicators                     |
| [design-system.md](guidelines/design-system.md)                       | light/dark tokens, contrast usage rules, theme preference, component reuse   |
| [testing-and-verification.md](guidelines/testing-and-verification.md) | required checks, coverage targets, manual smoke checklist                    |
| [phase-workflow.md](guidelines/phase-workflow.md)                     | phase sequence and what belongs in each phase                                |
| [no-go-rules.md](guidelines/no-go-rules.md)                           | hard forbidden-action list                                                   |

## How These Relate to `docs/`

`docs/architecture/*` and `docs/backend-contract/*` explain and illustrate (diagrams, examples,
narrative); `.ai/guidelines/*` states the rule tersely and enforceably. When writing or reviewing
code, guidelines are what to check against; docs are what to read to understand why.
