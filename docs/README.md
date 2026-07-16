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

Phase 1’s application foundation is complete: hardened Electron boundaries, a narrow typed
`window.posApi`, Router/Pinia startup shell, main-owned configuration/HTTP/identity/secure storage,
SQLite migrations and repositories, and a test/packaging baseline. Activation, login, bootstrap
fetching, sync work, and all POS workflows remain Phase 2+ work. See
[phases/01-foundation-structure.md](phases/01-foundation-structure.md).
