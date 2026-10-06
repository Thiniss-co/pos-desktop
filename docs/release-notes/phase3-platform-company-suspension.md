# Release notes — Phase 3: platform company suspension (desktop)

Status: integrated into local `main` on 2026-10-07. **Not pushed, not built for distribution, not released.** Backend
contract: `pos-backend/docs/architecture/platform-company-suspension.md`; error code: [error-codes.md](../backend-contract/error-codes.md).

## What it adds

- The register learns a platform suspension (and its lifting) from `meta.company_access` on sign-in, heartbeat, uploads,
  bootstrap, license validation and every `COMPANY_SUSPENDED` refusal. The state is stored per company with its revision;
  only a newer revision changes it. It survives restarts and offline use and is cleared only by a newer `active` state.
- While suspended: a red banner; new sales and new refunds are refused locally (one message; the cart stays); sales already
  made keep uploading; shift close and sign-out work; nothing on the workstation is deleted and nobody is signed out.
- A held upload (legacy v1) is retried per item no sooner than every 10 minutes and never pauses the queue; a held refund
  stays "Outcome unknown"/resumable and is resent with the same key and bytes after resumption.
- Fixed: titled bar banners rendered their title and body without a space.

## Compatibility

- This desktop works against a backend without Phase 3 (no new codes or fields appear; behaviour unchanged).
- Older desktops against the Phase 3 backend: see the backend contract §7b — they never show the suspension, may keep selling
  inside an already open shift under pre-issued authority, and treat a refund refused during a suspension as terminal.

## Release step (not executed here)

Build and distribute the desktop through the normal release process (`npm run build:linux` / `build:win` per
[setup.md](../setup.md)). **Install it on every till of a company before that company is suspended.**

## Follow-up

- [FU-P3-3](../audits/follow-ups/FU-P3-3-cart-not-restored-after-restart.md): the cart is not restored after an app restart
  (pre-existing, in-memory by design).
