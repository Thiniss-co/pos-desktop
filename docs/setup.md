# Setup

## Install

```bash
npm install
```

`postinstall` runs `electron-builder install-app-deps` automatically (rebuilds native modules
against the installed Electron version).

## Development

```bash
npm run dev
```

Runs `electron-vite dev` — starts the Vite dev server for the renderer with HMR and launches
Electron pointed at it. This is a long-running process; stop it with Ctrl+C. Do not run it as part
of an automated verification step.

## Verification Commands

```bash
npm run typecheck   # tsc -p tsconfig.node.json (main/preload) + vue-tsc -p tsconfig.web.json (renderer), no emit
npm run lint          # eslint --cache . — reports only, does not auto-fix
npm run format         # prettier --write . — MUTATES files; only run when explicitly formatting
```

`npm run test` **does not exist yet**. No test runner is configured in `package.json` as of this
writing. Adding one (and the first tests) is scoped to Phase 1 — see
[phases/01-foundation-structure.md](phases/01-foundation-structure.md) and
[../.ai/guidelines/testing-and-verification.md](../.ai/guidelines/testing-and-verification.md).

## Build / Package

```bash
npm run build          # typecheck + electron-vite build
npm run build:win
npm run build:mac
npm run build:linux
npm run build:unpack   # unpacked dir build, no installer — useful for local inspection
```

Packaging is configured via [electron-builder.yml](../electron-builder.yml). Auto-update is
configured against a placeholder URL (`https://example.com/auto-updates` in
[dev-app-update.yml](../dev-app-update.yml) and `electron-builder.yml`) — replace with the real
update server before any real release build; do not treat the placeholder as a working endpoint.

## Environment Variables

No `.env` / `.env.example` file exists in this repository yet. When backend integration lands
(Phase 2), at minimum expect:

| Variable | Purpose | Status |
|---|---|---|
| Desktop API base URL (e.g. `VITE_API_BASE_URL` or a build-time config) | Base URL for `/api/v1/desktop/*` requests | Not yet defined — introduce in Phase 1/2 alongside the central API client; do not hardcode a URL in source |

Do not hardcode a production or staging backend URL anywhere in the codebase — it must come from
environment/build configuration, added when the API client is introduced.

## Backend API Base URL

The desktop app talks only to `/api/v1/desktop/*` on the configured backend host (see
[backend-contract/desktop-api-summary.md](backend-contract/desktop-api-summary.md)). The actual
host/port for local backend development is not documented in this frontend repository — confirm it
against the backend project's own setup docs before wiring the API client; do not guess a
default in this repo's code.

## Linux Electron Sandbox Note

On Linux, Electron's `chrome-sandbox` helper binary must be owned by root with the setuid bit set.
If `npm run dev` (or a packaged AppImage/deb) fails with a sandbox-related permission error:

```txt
The SUID sandbox helper binary was found, but is not configured correctly.
```

this is almost always a local machine/environment issue, not an app bug. Typical causes and fixes
(apply locally, do not bake a workaround into app code or CI):

- `node_modules/electron/dist/chrome-sandbox` ownership/permissions are wrong — fix with
  `sudo chown root:root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 node_modules/electron/dist/chrome-sandbox`.
- As a last-resort **local development only** workaround, Electron can be launched with
  `--no-sandbox`. This must never be shipped in a packaged build or used as a permanent fix — it
  disables a real security boundary.
