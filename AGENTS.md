# AGENTS.md — Instructions for Codex / Automated Coding Agents

This file tells any autonomous or semi-autonomous coding agent (Codex, Codex CLI, or similar) how
to work safely in `pos-desktop`, an Electron + Vue 3 + TypeScript offline-first POS desktop app.
For deep rules see [.ai/guidelines/](.ai/guidelines/README.md); for a task-oriented command guide
see [CODEX.md](CODEX.md).

## How to Inspect the App

Before changing anything, always look first:

1. Read this file, `CLAUDE.md`, and `.ai/guidelines/no-go-rules.md`.
2. Check what phase the work belongs to: `docs/phases/*.md`.
3. Inspect real structure — do not assume: `src/main`, `src/preload`, `src/renderer/src`.
4. Check `package.json` for the scripts that actually exist. Do not assume `test` or `build:*`
   exist or behave a certain way — read them.
5. Check whether the change touches Electron security surfaces (`webPreferences`, preload,
   IPC channel list) — those require extra care (see Security Boundaries below).

## How to Make Changes Safely

- Make the smallest change that satisfies the current phase's declared deliverables
  (`docs/phases/*.md`). Do not pull forward later-phase work "while you're in there."
- Prefer editing existing files over creating new ones, except where the module/architecture
  rules in `.ai/guidelines/desktop-architecture.md` require a new module/service/store file.
- Never restructure unrelated code as a side effect of a task.
- Never add a dependency without a concrete need tied to the current task; state the need when
  you do.
- Keep main/preload/renderer boundaries intact (see Security Boundaries). If a task seems to
  require breaking one of these, stop and flag it instead of doing it.

## Coding Conventions

- TypeScript everywhere, strict mode, no `any` used to silence errors.
- Vue: Composition API with `<script setup lang="ts">`. No Options API in new code.
- Formatting/lint config is authoritative: `.prettierrc.yaml` (single quotes, no semicolons,
  100 print width, no trailing commas) and `eslint.config.mjs`. Do not hand-format against them.
- Path alias `@renderer/*` maps to `src/renderer/src/*` (see `tsconfig.web.json`); use it instead
  of long relative paths inside the renderer.
- File/module layout follows `.ai/guidelines/desktop-architecture.md` and
  `.ai/guidelines/vue-structure.md` — modules under `src/renderer/src/modules/<domain>`, shared
  code under `src/renderer/src/shared`.

## Security Boundaries (hard stops — do not cross without explicit instruction)

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` unless already documented
  otherwise for a specific dependency.
- No generic `ipcRenderer` exposure. Preload exposes only a typed `window.posApi` surface.
- No SQLite access, no Node `fs`, no raw `process.env` access from renderer code.
- `/api/v1/admin/*` must never appear in this codebase's API calls.
- Desktop tokens never go into `localStorage`/`sessionStorage`.
- Full checklist: `.ai/guidelines/electron-security.md`.

## Testing Commands

Run whatever of these exist in `package.json` before declaring work done (as of Phase 0 inspection,
`typecheck`, `lint`, `format`, and packaging scripts exist; a `test` script does not yet exist —
see `.ai/guidelines/testing-and-verification.md` for what to add and when):

```bash
npm run typecheck   # tsc (node) + vue-tsc (web), no emit
npm run lint         # eslint --cache .
npm run test         # NOT YET DEFINED — do not assume it exists; check first
```

Do not run `npm run format` (it rewrites files with `--write`) or `npm run dev`/`npm run start`
as a "verification" step inside an automated task — `dev` starts a long-running process, and
`format` mutates files outside the scope of a review. Only run them when the task is explicitly to
format or to manually smoke-test interactively.

## When to Stop

Stop and ask (or report a blocker) instead of proceeding when:

- A task would require calling `/api/v1/admin/*` or an undocumented backend endpoint.
- A task would require weakening Electron security settings.
- A task spans more than the current phase's declared scope.
- A required backend field/endpoint is not in `docs/backend-contract/` and is marked `TODO`.
- Verification commands (`typecheck`/`lint`/`test`) fail and the fix is non-obvious or out of
  scope for the current task.

## How to Report Results

Every task report should state, plainly:

1. What changed (files/paths), and why.
2. What was explicitly left out of scope.
3. Which verification commands were run and their real output/result — never claim a command
   passed without running it, and say so explicitly if a command doesn't exist yet.
4. Any new dependency added and why it was necessary.
5. Confirmation that Section "Security Boundaries" above was respected.
