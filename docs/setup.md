# Setup

## Install

```bash
npm install
```

`postinstall` runs `electron-builder install-app-deps` automatically (rebuilds native modules
against the installed Electron version). `better-sqlite3` is rebuilt for Electron, not host Node;
run `npm run postinstall` again after an install if the Electron-ABI smoke reports a mismatch.

The resolved foundation versions are Electron 39.8.10, Vue 3.5.39, Vite 7.3.6,
electron-vite 5.0.0, TypeScript 5.9.3, electron-builder 26.15.3, Pinia 4.0.2,
Vue Router 5.2.0, Zod 4.4.3, better-sqlite3 12.11.1, and Vitest 4.1.10.

## Development

```bash
npm run dev
```

Runs `electron-vite dev` — starts the Vite dev server for the renderer with HMR and launches
Electron pointed at it. This is a long-running process; stop it with Ctrl+C. Do not run it as part
of an automated verification step. Run GUI verification from an external Ubuntu terminal, where
Electron is not affected by the agent shell's `ELECTRON_RUN_AS_NODE` setting.

## Verification Commands

```bash
npm run typecheck   # tsc -p tsconfig.node.json (main/preload) + vue-tsc -p tsconfig.web.json (renderer), no emit
npm run lint          # eslint --cache . — reports only, does not auto-fix
npm run test          # Vitest unit tests (main/shared in Node; renderer in happy-dom)
npm run smoke:database # real migrator via Electron's Node runtime and a disposable SQLite database
npm run format         # prettier --write . — MUTATES files; only run when explicitly formatting
```

Vitest never imports the Electron-ABI `better-sqlite3` driver from host Node unit tests; use the
dedicated Electron smoke command above for that boundary.

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

Copy [.env.example](../.env.example) only when configuring a local backend origin. The main process
reads `MAIN_VITE_POS_API_ORIGIN`; its absence intentionally leaves the foundation in the
`not_configured` state and causes no request. HTTP is accepted only for loopback development hosts;
all other origins must use HTTPS.

| Variable | Purpose | Status |
|---|---|---|
| `MAIN_VITE_POS_API_ORIGIN` | Main-only base origin for `/api/v1/desktop/*` | Optional; required for activation, login, and bootstrap calls |
| `POS_API_TRACE` | Main-process opt-in HTTP diagnostics (`1` enables) | Development diagnostics only; off by default |

Do not hardcode a production or staging backend URL anywhere in the codebase. `.env*` files are
excluded from packaging; `.env.example` contains no secret.

## Diagnostics

To trace desktop API requests while running the app from an external terminal:

```bash
POS_API_TRACE=1 npm run dev
```

The main process writes one sanitized start line and one terminal line per request to stderr. Lines
contain only the method, origin and path, elapsed time, response status/content type, backend code,
backend trace ID, failure classification, and validation field names. They never contain request or
response bodies, credentials, tokens, activation/company-code values, fingerprint data, or headers.

## Secure Storage and CSP

Desktop secrets remain in the main process. The safe-storage wrapper fails closed when encryption
is unavailable and reports Linux's `basic_text` backend so it is never mistaken for hardware-backed
encryption. Tokens never cross `window.posApi`.

The main process applies a restrictive runtime CSP: development derives the allowed Vite HTTP and
WebSocket origins from `ELECTRON_RENDERER_URL`, while production permits only local application
resources. The template meta CSP remains a second, intersecting policy.

## Linux Electron Sandbox Prerequisite

With `sandbox: true`, Electron's `chrome-sandbox` helper binary **must** be owned by root with the
setuid bit set. Verify this prerequisite after `npm install` (which can reset it) and before
running `npm run dev` or a packaged build:

```bash
stat -c '%U:%G %a %n' node_modules/electron/dist/chrome-sandbox
```

The required result is `root:root 4755 node_modules/electron/dist/chrome-sandbox`. If Electron
reports a sandbox permission error:

```txt
The SUID sandbox helper binary was found, but is not configured correctly.
```

this is almost always a local machine/environment issue, not an app bug. Fix it locally; do not
bake a workaround into app code or CI:

- `node_modules/electron/dist/chrome-sandbox` ownership/permissions are wrong — fix with
  `sudo chown root:root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 node_modules/electron/dist/chrome-sandbox`.
- Do not use `--no-sandbox`; it disables a required security boundary.
