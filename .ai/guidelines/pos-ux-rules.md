# POS UX Rules

## Cashier-First UX

Every screen is designed for a cashier standing at a counter, often under time pressure, not for a
back-office user. Optimize for speed and error-recovery over information density.

## Barcode Input Priority

- Barcode scanners behave as fast keyboard input (keyboard-wedge). The active POS/checkout screen
  must have a barcode-capture context active by default — a cashier should be able to scan without
  first clicking into a specific text field.
- Distinguish scanner input from manual typing via the composable `useBarcodeScanner()`
  (`vue-structure.md`) using input-speed/terminator heuristics, not by requiring a dedicated
  "scan mode" toggle the cashier has to remember to enable.
- A scanned barcode with no catalog match shows an immediate, clear "not found" state and does not
  silently do nothing.

## Keyboard Shortcuts

- Core actions (new sale, hold/park sale, apply discount, void line, complete payment, print
  reprint) have keyboard shortcuts, documented in a visible cheat-sheet/help overlay.
- Shortcuts must not conflict with barcode-scanner input (scanners typically send digits + Enter —
  avoid binding bare digit keys or Enter to unrelated global actions on the checkout screen).

## Offline Banner

- A persistent, unmissable but non-blocking indicator shows current connectivity/backend
  reachability state (online / offline / backend unreachable). It must not block the cashier from
  continuing to sell.

## Sync Indicator

- A separate indicator (can be adjacent to the offline banner) shows sync queue state: count of
  pending items, whether sync is actively running, and whether sync is `paused` (see
  `offline-sync-contract.md`) with a reason (e.g. license denial) surfaced on hover/click.

## License/Grace Warning

- When the license/subscription enters a grace or restricted state, show a clear, dismissible-but-
  recurring warning (not a silent block) explaining the state and time remaining, per whatever the
  backend's license contract defines (`docs/backend-contract/`, `TODO` until confirmed against
  OpenAPI). Do not block the sale flow purely on the frontend's own guess about license state —
  follow backend-provided status.

## Large Buttons

- Primary checkout actions (product tiles, numeric keypad, complete payment, cash tender buttons)
  use large touch/click targets suitable for touchscreen POS terminals, not dense desktop-style
  controls.

## Fast Product Search

- Product search-by-name/SKU is available as a fallback to barcode scanning, debounced, and
  searches the local SQLite catalog first (offline-first) rather than depending on a live API
  call.

## Clear Modal Flows

- Multi-step flows (payment tendering, refund reason capture, shift close cash count) use a single
  focused modal/step flow with clear forward/back/cancel affordances — not scattered inline forms
  that leave ambiguous partial state.

## Receipt Print/Reprint Expectations

- After a completed sale, printing the receipt is the default next action (auto-print or one clear
  action), with an explicit reprint action available afterward (e.g. from sale history) that does
  not require re-ringing the sale. Print failures show a clear retry path and never silently lose
  the fact that a sale completed even if the printer failed.
