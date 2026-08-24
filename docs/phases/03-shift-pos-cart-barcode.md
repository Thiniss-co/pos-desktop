# Phase 3 — Shift, POS Cart, Barcode

## Goal

Build the core cashier workflow: opening a shift, browsing/searching the catalog, scanning
barcodes, and building a cart — entirely against local SQLite data (from the Phase 2 bootstrap
snapshot), with no sale finalization or sync yet.

## Scope

- `shifts` module: open shift (starting cash count), pause/resume, close shift (cash count,
  variance display) — calling the backend shift/cash-drawer endpoints via
  `window.posApi.shifts.*`, with shift-state error codes
  (`SHIFT_ALREADY_OPEN`, `SHIFT_NOT_OPEN`, `SHIFT_CLOSED`, `SHIFT_PAUSED`, `SHIFT_NOT_PAUSED`)
  handled explicitly. The main-process shift service must call
  `CommercialAccessService.assertCanSell()` before opening a shift; it is never a renderer-side
  decision.
- `pos`/`cart` module: product catalog browsing/search reading from local SQLite (offline-first,
  per [.ai/guidelines/pos-ux-rules.md](../../.ai/guidelines/pos-ux-rules.md)), cart line
  add/remove/quantity-adjust, running totals (pricing/tax logic in a service, not the page).
- `useBarcodeScanner()` composable implemented and wired into the checkout screen per
  [.ai/guidelines/pos-ux-rules.md](../../.ai/guidelines/pos-ux-rules.md).
- Shell-level offline banner and (stub, since sync doesn't exist yet) sync indicator placeholder.
- Keyboard shortcuts for core cart actions, avoiding collision with scanner input.

## Out of Scope

- Finalizing/completing a sale (payment, invoice creation) — cart can be built and priced, but
  "pay" is not implemented yet.
- Sync queue / invoice upload.
- Refunds, receipt printing.

## Deliverables

- Shift open/pause/close screens working against the real backend shift endpoints.
- Product search/browse working fully offline from the local catalog.
- Barcode scan reliably adding the correct product to the cart without requiring manual field
  focus.
- Cart totals (subtotal, tax, discounts if applicable) computed correctly in a service with unit
  test coverage.

## Verification Commands

```bash
npm run typecheck
npm run lint
npm run test            # including cart pricing/tax and shift-state tests
npm run dev               # manual: open shift, scan/search products, build a cart, close shift
```

## Done Criteria

- Shift lifecycle works end-to-end against the backend.
- Opening a shift is denied by the main-process commercial-access guard when the local license,
  trusted clock, session, or `pos.sell` permission does not permit selling. Sale finalization
  (Phase 4) must use the same guard, and any future outbox worker must call `assertCanSync()`
  before draining queued work.
- Barcode scanning captured correctly per the manual smoke checklist in
  [.ai/guidelines/testing-and-verification.md](../../.ai/guidelines/testing-and-verification.md).
- Cart pricing logic has unit test coverage and lives outside `.vue` files.

## Commercial Access Enforcement Contract

Phase 3 uses the main-process `CommercialAccessService` as the only authority for protected work.
Renderer access state and disabled buttons are UX only; they are never an authorization boundary and no
IPC channel lets the renderer set an access decision.

- Opening or resuming a shift calls `assertAllowed('sell')` in the main process.
- Cart edits remain renderer-only drafts and do not need a guard.
- Phase 4 must call `assertAllowed('sell')` at the local invoice/outbox transaction boundary, because
  that is the durable sale rather than the cart.
- Upload and manual retry call `assertAllowed('sync')` immediately before sending. Invoice upload must
  also assert `pos.sell`, matching the backend route contract; the generic sync guard intentionally does
  not add that sell-only rule.

The decision is fail-closed and ordered: device registration/status, session, valid persisted license and
trusted clock, grace and validation deadline, bootstrap/company, POS feature, license capability,
`pos.sell`, then connectivity. Deadline and grace equality deny access. Selling is intentionally
offline-capable once business guards pass; syncing requires online connectivity. A backwards clock requires
license validation before access can recover. Session failures route to login, while device failures route
to device recovery and retain durable local data.

The first bootstrap remains a sync operation: it may proceed without a cached company/feature snapshot so
the workstation cannot deadlock itself. After a long offline period, validate the license before bootstrap,
because bootstrap requires current `can_sync` access. To add a future protected action, add a named action
and its persisted-state checks in the main-process guard, project only its sanitized decision through the
read-only access IPC, and enforce it again at the durable operation boundary.

## Next Phase

[04-local-sale-sync-queue.md](04-local-sale-sync-queue.md) — completing a sale locally and
implementing the sync queue to upload it.
