# pos-desktop Documentation

`pos-desktop` is the offline-first Electron + Vue 3 desktop point-of-sale frontend for the Thinis
POS platform, integrating with a separate Laravel backend via a frozen desktop API contract.

This directory is the narrative/reference documentation. For enforceable rules AI tools must
follow, see [.ai/guidelines/](../.ai/guidelines/README.md) and the root [CLAUDE.md](../CLAUDE.md) /
[AGENTS.md](../AGENTS.md) / [CODEX.md](../CODEX.md).

## Map

| Section | Purpose |
|---|---|
| [setup.md](setup.md) | Install, run, verify — commands and environment |
| [architecture/](architecture/desktop-frontend-architecture.md) | How the app is built: processes, data flow, sync, testing strategy |
| [backend-contract/](backend-contract/desktop-api-summary.md) | What the backend provides — routes, envelope, auth, errors, sync contract |
| [phases/](phases/00-ai-rules-and-docs.md) | The phase-by-phase implementation plan, one doc per phase |

## Current Project State (as of this writing)

This repository is the stock `electron-vite` Vue 3 + TypeScript template — Electron main/preload
entry points and a minimal Vue renderer exist, but no POS domain code (modules, stores, local
database, API client, sync queue) has been implemented yet. Phase 0 (this documentation) is
complete; Phase 1 (foundation structure) has not started. See
[phases/00-ai-rules-and-docs.md](phases/00-ai-rules-and-docs.md) and
[phases/01-foundation-structure.md](phases/01-foundation-structure.md).
