# FU-P3-3 — The POS cart is not restored after an app restart

**Status:** Open. **Found:** Phase 3 closeout review, 2026-10-06 (Electron journey `p3suspension`, screenshot
`05b-offline-restart-still-suspended`). **Introduced by Phase 3:** no.

## What happens

A cart with lines (and any held/parked drafts) is empty after the app is closed and opened again. This is the current
design: `src/renderer/src/modules/pos/cart.store.ts` keeps the live draft and held drafts **in memory only** ("never
persisted", discarded by `resetDraft`). Committed sales are not affected: they are in SQLite with their upload queue
rows and survive restarts (`tests/electron/suites/companySuspensionQueue.suite.ts`).

## Reproduction

1. Scan an item so the cart has a line (optionally hold a second cart).
2. Close the app and open it again on the same profile (online or offline).
3. The POS opens with an empty cart and no held drafts.

Observed in the journey after an offline restart during a platform suspension; the suspension banner and the queued
sales survived, the unpaid cart did not.

## Known impact

- The cashier re-scans the items of an unfinished sale after a crash, an update or a restart.
- No money or stock effect: an unpaid draft is not a sale, and a sale attempt that was claimed before the restart is
  tracked separately by the sale-attempt recovery (not the cart).
- During a platform suspension the draft cannot be completed anyway; after a restart it is simply gone.

## Uncertainty

- Whether restoring drafts is wanted at all (shared tills, privacy between cashiers, stale prices and catalog revisions
  after a restart, shift changes). Persisting them would need rules for all of those.
- Not checked: whether a renderer reload (not a full restart) behaves the same.

## Not done

No change in Phase 3.
