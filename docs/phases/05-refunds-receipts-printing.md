# Phase 5 — Refunds, Receipts, Printing

## Goal

Complete the transaction lifecycle: refunding a prior sale (respecting invoice-before-refund
ordering) and printing/reprinting receipts through a secure printing bridge.

## Scope

- `refunds` module: refund flow (invoice lookup, reason capture, amount/line selection), building
  an immutable local refund record with sync-status fields, referencing its parent invoice's
  `local_uuid`/`remote_uuid`.
- Sync queue extended to respect invoice-before-refund ordering (a refund whose invoice hasn't
  synced stays `pending`, not `retryable_error`) per
  [.ai/guidelines/offline-sync-contract.md](../../.ai/guidelines/offline-sync-contract.md).
- `POST /api/v1/desktop/refunds/upload` integration.
- `window.posApi.print.receipt(payload)` implemented against a real or configured printer,
  following [.ai/guidelines/electron-security.md](../../.ai/guidelines/electron-security.md)
  (main-process-owned, validated payload, no raw OS print access from renderer).
- Auto-print-after-sale + explicit reprint-from-history action, per
  [.ai/guidelines/pos-ux-rules.md](../../.ai/guidelines/pos-ux-rules.md).
- Print failure handling that never contradicts the recorded sale/refund state.

## Out of Scope

- Full security/packaging hardening pass (Phase 6).
- Any new POS feature beyond refunds/printing.

## Deliverables

- A refund can be issued against a synced invoice, queues correctly, and uploads once online.
- A refund against an invoice that hasn't synced yet stays correctly ordered (pending, not
  errored).
- Receipt prints automatically after a completed sale; reprint works from sale history without
  re-ringing the sale.
- A simulated printer failure leaves the sale/refund state intact and shows a clear retry path.

## Verification Commands

```bash
npm run typecheck
npm run lint
npm run test                # refund ordering tests, print-bridge contract tests
npm run dev                   # manual: full sale -> print -> refund -> reprint cycle
```

## Done Criteria

- Refund/invoice ordering is enforced and tested.
- Print bridge is fully main-process-owned with a validated payload contract.
- Manual smoke checklist in
  [.ai/guidelines/testing-and-verification.md](../../.ai/guidelines/testing-and-verification.md)
  passes for print/reprint.

## Next Phase

[06-hardening-testing-packaging.md](06-hardening-testing-packaging.md) — full security pass, test
coverage completion, packaging verification.
