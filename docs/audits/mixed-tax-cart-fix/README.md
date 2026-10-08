# Mixed-tax cart refusal on the owner's register (2026-10-05)

## Symptom

The running desktop app (`electron-vite dev` from this checkout, `main` @ 19aaaea, started 14:12) showed
"Products with different tax modes cannot share this cart." for carts mixing inclusive, exclusive and
untaxed products.

## Root cause

- The guard is `calculateCart` in `src/shared/pos/posCalculator.ts`. It returns `CART_MIXED_TAX_MODE`
  when the **installed** catalog contract has `mixedTaxModePolicy === 'single_invoice_mode'` and the
  cart holds more than one `tax.mode`. Every cart path goes through it: card click, barcode, quantity,
  removal, held-cart recall and catalog re-apply (`cart.store.ts` `commit`/`candidate`/`setContract`).
  `LocalSaleService` repeats the check in main.
- The desktop code was current: `main` contains a5fca7d/dae3411, and every bootstrap negotiates
  `catalog_tax_policy_version=2`.
- The local backend (`../pos-backend`, `main` @ 6b5a051, `php artisan serve` on :8000) runs the
  mixed-tax code against a MySQL database that **has not been migrated**. Seven migrations are pending,
  including `2026_10_09_090000_add_mixed_tax_support`. The register's refresh at 14:13:17 failed with
  `SQLSTATE[42S22] Unknown column 'mixed_tax_mode_policy'`, raised in
  `DesktopCatalogContractService::persistContract` (laravel.log).
- The register therefore kept its cached contract, issued 2026-10-04 12:19 UTC as
  `single_invoice_mode` and valid until 2026-10-28. Under that contract the guard refused the cart, as
  designed.

## Change

- The `CART_MIXED_TAX_MODE` text (EN/AR) now explains that the installed catalog does not allow mixed
  tax modes, and that the fix is a refresh or a server that enables them. The guard and the
  compatibility gate are unchanged.
- `cart.store.test.ts` now covers a `per_line` cart in both orders with quantity changes, a removal and
  hold/recall.
- Harness fixes:
  - `sandbox.stop()`/`start()` can now restart the disposable backend. A signal-killed child keeps
    `exitCode === null`, so `start()` used to return early.
  - `mixed-tax-report` now reports sync records, stock movements and accounting journals per invoice.
- New journey `tests/playwright/journeys/qc4mixedtaxe2e.mjs`.

## Evidence (`playwright/qc4mixedtaxe2e/`, passing run 2026-10-05T11:38Z)

Desktop built from this checkout. Disposable backend from `pos-backend-phase2-4-integration` @
afaeb2e (code identical to backend `main`), served through the guarded HTTP router.

| Step | Result |
|---|---|
| L | With the issuance gate off, `single_invoice_mode` refuses the second mode with the new text. With the gate on and a refresh, `per_line` is installed. |
| A | Card clicks build one cart (none, exclusive 15%, inclusive 15%, exclusive 0% zero-rated, inclusive 0% exempt). Then +1, a removal, a 10% discount, and the cart is held. |
| B | Barcode entry in reverse order, +1 and a removal. Sale 1: v5 `mixed`, server lines and totals equal. |
| C | The recalled cart is identical to the held one (lines, discount, totals). Sale 2 is accepted with the discount allocated per line. |
| D | An offline mixed sale, then a restart while offline. The payload hash is unchanged. |
| E | A server with `POS_MIXED_TAX_PARSE_V4_V5=false` answers `DESKTOP_CONTRACT_VERSION_UNSUPPORTED`. The sale stays `retryable_error` with the same payload, and the server stores nothing. |
| F | Parser restored and the first answer lost; the replay syncs. Result: 3 server invoices, each with 1 sync record, stock movements = tracked lines, and 1 journal. |
| G | For each sale, the printed ZATCA QR total/VAT equals the invoice, the local snapshot and the server's stored and recomputed QR. The printed VAT breakdown lists each category. |

## To see it in the normal app

1. Back up, then migrate the local backend database: `cd ../pos-backend && php artisan migrate`.
   This is the owner's decision; it was not run here.
2. Restart `npm run dev` in pos-desktop to pick up the new text. It is optional for the fix itself.
3. In the register, press **Refresh workstation** and check that it reports installed. Mixed carts
   work from then on.
