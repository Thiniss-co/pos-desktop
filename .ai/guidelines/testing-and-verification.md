# Testing and Verification Rules

## Required Before Any Task Is "Done"

Run whatever of the following exist in `package.json` (verify by reading `package.json` — do not
assume):

```bash
npm run typecheck   # tsc (main/preload) + vue-tsc (renderer), no emit
npm run lint          # eslint --cache . (no auto-fix)
npm run test           # unit tests — NOT YET DEFINED as of this writing
```

If a script doesn't exist, say so explicitly in the task report rather than skipping silently or
fabricating a result. Adding a real `test` script/runner is tracked in
`docs/phases/01-foundation-structure.md`.

## Unit Tests Required (once a test runner exists)

Priority order for coverage as functionality lands:

1. **API envelope parser** — success/error shape parsing, error-code branching, malformed-response
   handling.
2. **IPC contract handlers** — payload validation (accepts valid, rejects invalid), typed
   result/error shape.
3. **Sync queue state machine** — transitions in `offline-sync-contract.md`
   (`pending → syncing → synced`, `failed` retry/backoff, `conflict` quarantine, `paused` on
   license denial).
4. **Route guards** — auth/device/license-gated routes redirect correctly when unauthenticated,
   unbound, or license-denied.
5. **Pricing/tax/discount logic** in cart/checkout services.

## IPC Contract Tests Where Possible

Each `window.posApi.<namespace>.<method>` should have a test exercising: a valid payload path, an
invalid payload path (rejected before reaching a repository/network call), and the shape of the
resolved/rejected value the renderer receives.

## API Envelope Parser Tests

Cover: well-formed success envelope, well-formed error envelope (each known `code` from
`backend-api-contract.md`), and malformed/unexpected-shape responses (must fail safely, not throw
an unhandled exception into a component).

## Sync Queue Tests

Cover each transition in `offline-sync-contract.md`, including: idempotency-key retry-after-loss
behavior, invoice-before-refund ordering, stale-price and oversell quarantine, and license-denial
pausing the whole queue rather than one item.

## Route Guard Tests

Cover: unauthenticated access to a protected route, a token present but not device-bound
(`DESKTOP_TOKEN_NOT_BOUND`), device mismatch (`DESKTOP_TOKEN_DEVICE_MISMATCH`), and license-denied
states — each should redirect/block per the intended UX (`pos-ux-rules.md`), not silently render a
broken screen.

## Manual Smoke Checklist

Use when a change touches something a unit test can't reasonably cover:

- [ ] App launches (`npm run dev`) without console errors.
- [ ] Barcode scan input is captured correctly on the active checkout screen.
- [ ] Offline banner reflects actual connectivity state when toggling network.
- [ ] Sync indicator reflects queue state (pending count, paused reason if applicable).
- [ ] Receipt print (or the print bridge stub, pre-hardware) is invoked correctly after checkout.
- [ ] No DevTools warning about `contextIsolation`/`nodeIntegration`/insecure preload.
- [ ] No network call is made to `/api/v1/admin/*` (check DevTools Network tab).
