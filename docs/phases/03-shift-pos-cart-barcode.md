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
  handled explicitly.
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
- Barcode scanning captured correctly per the manual smoke checklist in
  [.ai/guidelines/testing-and-verification.md](../../.ai/guidelines/testing-and-verification.md).
- Cart pricing logic has unit test coverage and lives outside `.vue` files.

## Next Phase

[04-local-sale-sync-queue.md](04-local-sale-sync-queue.md) — completing a sale locally and
implementing the sync queue to upload it.
