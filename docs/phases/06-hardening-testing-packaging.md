# Phase 6 — Hardening, Testing, Packaging

## Goal

Close out remaining gaps against the security, testing, and packaging bars before this app is
considered release-ready: a full Electron security audit, completed test coverage per
`.ai/guidelines/testing-and-verification.md`, and verified packaging output for each target
platform.

## Scope

- Full re-audit against
  [.ai/guidelines/electron-security.md](../../.ai/guidelines/electron-security.md) — every item
  (`contextIsolation`, `nodeIntegration`, `sandbox`, no `remote`, no generic `ipcRenderer`, typed
  `window.posApi`, Zod validation on every handler, no raw SQL/filesystem bridge, CSP, navigation
  and popup restrictions, permission handler).
- Test coverage completed per
  [../architecture/testing-strategy.md](../architecture/testing-strategy.md) — all layers (unit,
  IPC contract, component, route guard) at the target coverage, not just the minimum proven in
  earlier phases.
- Packaging verification: `npm run build:linux` / `build:win` / `build:mac` (whichever are
  reachable in the build environment) produce installable artifacts;
  `electron-builder.yml` reviewed for placeholder values (auto-update URL, icons, entitlements)
  that need replacing before a real release.
- `dev-app-update.yml` / auto-update endpoint replaced from the `https://example.com/auto-updates`
  placeholder to a real update server, or explicitly documented as still pending a real server.
- Final review of `docs/backend-contract/*` `TODO` markers — confirmed or explicitly still open
  with an owner/next step.

## Out of Scope

- New POS features.
- Backend changes.

## Deliverables

- Security audit report (pass/fail per item, with file evidence) with all items compliant or an
  explicitly documented, justified exception.
- Test suite covering all layers in the testing strategy doc.
- Verified packaged build(s) for the target platform(s), with placeholder config values resolved
  or explicitly flagged as pending real infrastructure.

## Verification Commands

```bash
npm run typecheck
npm run lint
npm run test
npm run build
npm run build:linux   # or build:win / build:mac depending on target platform(s)
```

## Done Criteria

- Zero non-compliant items in the Electron security audit (or each is a documented, justified
  exception).
- All test layers in the testing strategy have real coverage, not just placeholders.
- At least one target platform produces a working packaged build that launches and runs the core
  cashier flow (open shift → sell → sync → refund → print) end to end.

## Next Phase

None — this is the last phase of the desktop MVP contract as currently scoped. Any further work
(new POS features, admin-panel integration, etc.) is planned separately once this phase's done
criteria are met.
