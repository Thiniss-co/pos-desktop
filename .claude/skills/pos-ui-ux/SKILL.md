---
name: pos-ui-ux
description: Build cashier-first POS UI — barcode input, keyboard shortcuts, offline/sync indicators, receipt UX — for the pos-desktop app.
---

# POS UI/UX

## When to Use

- Building/modifying the checkout/cart screen, product search, or numeric keypad.
- Implementing barcode scanner input handling.
- Building the offline banner or sync status indicator.
- Building payment tendering, refund, or shift-close modal flows.
- Building receipt display/print/reprint UI.

## Rules

Full detail: `.ai/guidelines/pos-ux-rules.md`.

- Checkout screens are barcode-capture-ready by default — no click-into-a-field requirement to
  start scanning.
- Distinguish scanner input from manual typing via `useBarcodeScanner()` — don't require a manual
  "scan mode" toggle.
- Keyboard shortcuts must not collide with scanner input (avoid bare digit/Enter global bindings
  on checkout screens).
- Offline and sync-queue state are always visible, never blocking.
- License/grace warnings are visible and recurring, not a silent block — and reflect
  backend-provided status, not a frontend guess.
- Primary actions use large, touch-friendly targets.
- Product search falls back to and prioritizes the local SQLite catalog (offline-first), not a
  live API call.
- Multi-step flows (payment, refund reason, cash count) are a single focused modal, not scattered
  inline state.
- Receipt printing is the default next action after checkout, with an explicit reprint path that
  doesn't require re-ringing the sale; print failures never hide that the sale itself succeeded.

## Steps

1. Read `.ai/guidelines/pos-ux-rules.md`.
2. Check `shared/composables/` for an existing composable (`useBarcodeScanner`,
   `useOfflineStatus`, `useKeyboardShortcuts`, `usePrintJob`) before writing new input-handling
   logic.
3. Keep the page thin (`vue-structure.md`) — UI state/behavior in composables/components, business
   decisions in stores/services.
4. For anything touching printing, go through `window.posApi.print.*` only — never a direct OS
   print call from the renderer (`pos-electron-security` skill).

## Verification

- `npm run typecheck`, `npm run lint`.
- Manual: simulate a barcode scan (rapid keystrokes + terminator) and confirm it's captured
  correctly without a manual click-in.
- Manual: toggle network off/on and confirm the offline banner and sync indicator update.
- Manual smoke checklist in `.ai/guidelines/testing-and-verification.md`.

## Common Mistakes

- Requiring a dedicated input field focus before barcode scans register.
- Binding a global shortcut to a bare digit key or Enter, breaking scanner input.
- Blocking the whole UI on an offline/sync/license state instead of showing a non-blocking
  indicator.
- Making checkout product search hit the live API instead of local SQLite first.
- Losing the "sale completed" state in the UI when only the print step fails.
