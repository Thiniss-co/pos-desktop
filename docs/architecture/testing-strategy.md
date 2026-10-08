# Testing Strategy

Rules: [.ai/guidelines/testing-and-verification.md](../../.ai/guidelines/testing-and-verification.md).

## Current State (evidence)

`package.json` defines `typecheck` (split node/web via `tsc`/`vue-tsc`), `lint` (`eslint`),
`test`/`test:watch` (Vitest), the Electron-ABI `smoke:database` and `test:sqlite:electron` commands,
plus packaging scripts.
Foundation tests cover envelope parsing, error normalization, route confinement, device identity,
queue policy, IPC serialization, router decisions, and named preload gateways.

## Layers

```mermaid
flowchart TB
    Unit["Unit tests\n(services, envelope parser, sync state machine, pricing/tax)"]
    IPC["IPC contract tests\n(main-process handlers: valid/invalid payloads)"]
    SQLite["Electron SQLite integration\n(file-backed migrations, repositories, transactions)"]
    Component["Component tests\n(key POS components: cart, keypad, barcode composable)"]
    Smoke["Manual smoke checklist\n(barcode hardware, print hardware, offline toggling)"]

    Unit --> IPC --> SQLite --> Component --> Smoke
```

Automated layers run in CI/local through Vitest except the native SQLite suite. Main/shared tests use
host Node, renderer tests use happy-dom, and `test:sqlite:electron` runs file-backed production
migrations, repositories, and services through Electron's Node runtime. This is deliberate:
`better-sqlite3` is rebuilt for Electron during install, so using Electron preserves the production ABI
without repeatedly rebuilding the native module for incompatible host Node tests. Each integration case
uses a disposable per-test directory under the OS temp directory and never resolves the app user-data
path.
Hardware-dependent behavior (real barcode scanner, real receipt printer) stays in the manual smoke
checklist.

### Live, journey and packaging layers

Above the layers in the diagram, every run uses an isolated Electron profile, a run-local keyring and a
disposable Laravel database behind the sandbox guard (`tests/electron/support/sandbox/`):

| Layer                 | Command                                                         | What it proves                                                                                                                                               |
| --------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Live Electron–Laravel | `node scripts/cp3g5LiveUpload.mjs` (`CP3G5_*` contexts)         | Real uploads, refunds, receipt profiles and owner products against a real backend tree                                                                       |
| Harness safety        | `npm run test:cp3g5-harness`                                    | The live harness refuses real databases and profiles and cleans up after itself                                                                              |
| Playwright journeys   | `node tests/playwright/run.mjs <journey>`                       | The real app driven like a cashier (keyboard, touch via CDP), one journey per feature                                                                        |
| Packaged app          | `node tests/playwright/run.mjs pkgapp`                          | The electron-builder `--dir` output (production bundle, OS print boundary, fuses, files allowlist) through activate → shift → sale → upload → print → refund |
| Package boundary      | `npm run verify:cp3g5-package`, `npm run verify:print-boundary` | `app.asar` holds only production paths; production builds contain only the OS print boundary                                                                 |

Every IPC channel's sender check is enforced by `src/main/ipc/ipcSenderCoverage.test.ts`. The
packaged journey launches with `--no-sandbox` because an unpacked Electron on Ubuntu 24+ needs the
.deb's AppArmor profile (or a root-owned setuid `chrome-sandbox`), which a test run cannot install.

## What Must Be Covered Before Considering a Feature Done

| Feature area         | Minimum coverage                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| API client           | Envelope parsing (success/error/malformed), each documented error `code`                                         |
| IPC handlers         | Valid payload accepted, invalid payload rejected before reaching main logic                                      |
| Sync queue           | Every state transition in `offline-sync-contract.md`, including conflict/rejection review and worker-pause paths |
| Route guards         | Unauthenticated, unbound-token, device-mismatch, license-denied redirects                                        |
| Pricing/tax/discount | Core calculation paths in cart/checkout services                                                                 |

## Manual Smoke Checklist

See [.ai/guidelines/testing-and-verification.md](../../.ai/guidelines/testing-and-verification.md)
for the current checklist; it grows as hardware-dependent features (barcode, printing) land.
