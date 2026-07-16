# Phase 0 — AI Rules and Documentation Foundation

## Goal

Establish the AI-instruction and documentation foundation so Claude, Codex, and ChatGPT can work
on this Electron/Vue POS desktop app safely and consistently, phase by phase.

## Scope

- Root instruction files: `CLAUDE.md`, `AGENTS.md`, `CODEX.md`.
- `.ai/guidelines/` — enforceable architecture, security, sync, database, IPC, UX, testing, phase,
  and no-go rules.
- `.claude/skills/` — six project-specific Claude skills.
- `docs/` — setup guide, architecture docs (with diagrams), backend contract summary, and this
  phase-by-phase plan.
- Inspecting the existing repository structure to ensure documentation matches reality.

## Out of Scope

- Any application source code changes (`src/**`).
- Any dependency install/removal/upgrade.
- Any project regeneration/rescaffolding.
- Implementing any POS feature, however small.
- Backend changes of any kind.

## Deliverables

- `CLAUDE.md`, `AGENTS.md`, `CODEX.md` at repo root.
- `.ai/README.md` + 10 files under `.ai/guidelines/`.
- 6 skill directories under `.claude/skills/`, each with a `SKILL.md`.
- `docs/README.md`, `docs/setup.md`.
- 8 files under `docs/architecture/`.
- 5 files under `docs/backend-contract/`.
- 7 files under `docs/phases/` (including this one).

## Verification Commands

```bash
git diff --check     # repository integrity check
npm run typecheck     # safe, read-only in effect
npm run lint           # safe, read-only in effect (no --fix)
npm run test            # does not exist — documented as a gap, not run
```

## Done Criteria

- All files listed under Deliverables exist with real, specific content (no empty placeholders).
- No file under `src/**` was modified.
- No dependency was added, removed, or upgraded.
- `package.json` was not modified.

## Next Phase

[01-foundation-structure.md](01-foundation-structure.md) — module layout, router, Pinia, typed
`window.posApi` bridge, central API client skeleton, SQLite + migration runner skeleton, base
Electron security hardening (`sandbox: true`, narrowing the preload surface).
