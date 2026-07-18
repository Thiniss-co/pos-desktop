# Phase 2 — Activation, Login, Bootstrap

**Status: implemented.** Device registration, login, encrypted token/JWT persistence, one-shot
license validation, and full bootstrap persistence (migration `0002_activation_auth_bootstrap`)
are wired end-to-end against the real backend contract, confirmed from the Laravel source (see
[../backend-contract/auth-device-contract.md](../backend-contract/auth-device-contract.md) and
[../backend-contract/bootstrap-license-contract.md](../backend-contract/bootstrap-license-contract.md)).
Deferred: license/entitlement timers, incremental bootstrap, and everything listed under Out of
Scope below — those remain for later phases.

## Goal

Implement the app's entry flow against the real backend contract: device registration, login,
secure token handling, and initial bootstrap data persistence, so the app can authenticate and
have local data to operate on.

## Scope

- `auth` module: device-registration screen/flow (first run), login screen, session state (Pinia
  store), route guards for authenticated vs. unauthenticated routes.
- Central API client (`shared/api/client.ts`, main-process-resident per
  [../architecture/api-integration-architecture.md](../architecture/api-integration-architecture.md))
  implementing envelope parsing and the two auth headers.
- `window.posApi.auth.*` and `window.posApi.bootstrap.*` capabilities, following
  [.ai/guidelines/ipc-contracts.md](../../.ai/guidelines/ipc-contracts.md).
- Secure token storage in the main process (never renderer-accessible storage).
- `bootstrap` module: fetch + persist snapshot to local SQLite (schema extended from Phase 1's
  minimal migration), used to hydrate the app on subsequent offline launches.
- `license.validate` call wired in, with basic license-state exposure to the renderer (full
  grace/warning UX can be minimal here — refined further in later phases if needed).
- Handling for the auth-related error codes in
  [../backend-contract/error-codes.md](../backend-contract/error-codes.md)
  (`UNAUTHENTICATED`, `DESKTOP_LOGIN_FORBIDDEN`, `DESKTOP_TOKEN_NOT_BOUND`,
  `DESKTOP_TOKEN_DEVICE_MISMATCH`, `DESKTOP_CONTEXT_REQUIRED`, `DESKTOP_ACCESS_FORBIDDEN`).

## Out of Scope

- Shift/cart/checkout screens.
- Barcode scanning.
- Sync queue / offline sale upload.
- Refunds, receipt printing.

## Deliverables

- Working device registration + login flow against the real backend (or a documented mock/staging
  target if the real backend isn't reachable during development — do not fabricate success).
- Bootstrap snapshot persisted locally and available offline after first successful fetch.
- Route guards redirecting appropriately for each auth-error scenario.
- Any previously `TODO`-marked request/response shape in
  `docs/backend-contract/auth-device-contract.md` confirmed or still explicitly marked `TODO` if
  not yet confirmable.

## Verification Commands

```bash
npm run typecheck
npm run lint
npm run test           # including new auth/bootstrap unit tests
npm run dev              # manual: register device, log in, confirm bootstrap persists, relaunch offline
```

For activation request diagnostics, see the opt-in `POS_API_TRACE` instructions in
[setup.md](../setup.md#diagnostics).

## Done Criteria

- A fresh install can register a device, log in, and receive/persist a bootstrap snapshot against
  the real (or documented staging) backend.
- Relaunching without network still loads the app using the persisted snapshot.
- Desktop token is verifiably not present in `localStorage`/`sessionStorage` (manual DevTools
  check).
- All auth-related error codes have explicit, non-generic handling.

## Next Phase

[03-shift-pos-cart-barcode.md](03-shift-pos-cart-barcode.md) — shift/cash-drawer flow, catalog
browsing/search, barcode scanning, cart building.
