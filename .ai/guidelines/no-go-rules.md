# No-Go Rules (Hard Forbidden List)

Any AI tool (Claude, Codex, ChatGPT, or a human copying their output) working in this repository
must treat every item below as a hard stop, not a judgment call.

| # | Forbidden | Why |
|---|---|---|
| 1 | Backend changes of any kind (this is a separate Laravel repo) | Out of scope; backend contract is frozen for desktop MVP |
| 2 | Converting this app to Nuxt | Nuxt is reserved for a future, separate web admin panel |
| 3 | Calling `/api/v1/admin/*` or `/api/v1/auth/*` from this app | Platform/admin auth namespaces; desktop must only use `/api/v1/desktop/*` |
| 4 | Direct SQLite access from the renderer | Breaks main/renderer isolation; see `electron-security.md`, `local-database.md` |
| 5 | Storing desktop tokens in `localStorage`/`sessionStorage` | Renderer-accessible storage is not safe for auth tokens in an Electron app |
| 6 | Exposing raw `ipcRenderer` (or a generic invoke passthrough) to the renderer | Turns the preload bridge into an unbounded attack surface; see `ipc-contracts.md` |
| 7 | A raw SQL bridge (renderer sends SQL, main executes it) | Equivalent to SQL injection by design |
| 8 | Large, unplanned feature jumps ahead of the current phase | Breaks the phase-by-phase contract; see `phase-workflow.md` |
| 9 | Silently bypassing the API response envelope (parsing raw JSON ad hoc) | Breaks consistent error/code handling across the app; see `backend-api-contract.md` |
| 10 | Untyped IPC payloads (no Zod/type validation on a handler) | Defeats the purpose of a typed bridge; see `ipc-contracts.md` |

## Additional Standing Rules

- Do not recreate, rescaffold, or regenerate this application (no `npm create`, no
  electron-vite/Vue generators run against this repo).
- Do not install, remove, or upgrade dependencies without a stated, concrete need for the current
  task.
- Do not run destructive git operations (`reset --hard`, `push --force`, `clean -f`,
  branch deletion) without explicit user approval, even if they seem like they'd "clean things
  up."
- Do not hardcode secrets, production URLs, or real device/license identifiers in code, docs, or
  fixtures.
- Do not invent backend endpoints, fields, or behavior not documented in
  `docs/backend-contract/` — mark unknowns as `TODO` instead.
- Do not claim a verification command (`typecheck`/`lint`/`test`/build) passed unless it was
  actually run in this session, with the real output.
