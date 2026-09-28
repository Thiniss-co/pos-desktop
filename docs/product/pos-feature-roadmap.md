# Thinis POS Desktop — Feature Status & Recommendations

> Scope: the supermarket-focused desktop POS (`pos-desktop`, Electron + Vue 3).
> Baseline: branch `feat/pos-quick-sale-redesign` (V3 redesign + quick-sale checkout), 2026-09-28.
> Status is based on reading the code, not on a live run against a production backend.

Legend: ✅ applied · 🟡 partial · ❌ missing · 🔌 needs a backend endpoint/contract first

---

## 1. Summary

| Area                                         | Status                                                    |
| -------------------------------------------- | --------------------------------------------------------- |
| Device activation, login, license, bootstrap | ✅                                                        |
| Offline-first selling + sync queue           | ✅                                                        |
| Barcode scanning & quick-sale checkout       | ✅ (weighted barcodes ❌)                                 |
| Cart, discounts, tax                         | ✅ (promotions ❌)                                        |
| Payments (split tender, quick cash)          | ✅ (card terminal ❌)                                     |
| Hold / recall sales                          | 🟡 in-memory only                                         |
| Shifts                                       | 🟡 open/pause/resume/close; no cash in/out or X/Z reports |
| Refunds                                      | ✅                                                        |
| Receipt printing & reprint                   | ✅ (cash drawer kick ❌)                                  |
| Supervisor overrides / approvals             | ❌                                                        |
| Customers & loyalty                          | 🟡 attach customer only                                   |
| Hardware (scale, customer display, drawer)   | ❌                                                        |
| Reporting                                    | ❌                                                        |

---

## 2. Applied features

### 2.1 Platform & security

- ✅ Device registration and activation (`activation`), device-bound login (`auth`), session handling.
- ✅ License / commercial-access checks with a blocked-access page (`license`, `access`).
- ✅ Workstation bootstrap and local catalog snapshot with integrity checks (`bootstrap`, migrations 0001–0005).
- ✅ Strict Electron boundaries: typed `window.posApi`, Zod-validated IPC, trusted-sender checks, tokens held in the main process.
- ✅ Company user management (`companyUsers`).
- ✅ Arabic / English UI with RTL, light/dark theme (`preferences`).
- ✅ Connectivity monitoring and a top-bar sync status pill.

### 2.2 Catalog & product lookup

- ✅ Local SQLite catalog, search by name/SKU, categories, pagination.
- ✅ Exact barcode lookup (found / not-found / ambiguous / stale / unavailable outcomes).
- ✅ Stock visibility per product (in stock / low / out), stock allocations for offline selling.
- ✅ Catalog refresh with explicit “rebuild or clear” when prices change under an open cart (never silent repricing).

### 2.3 Quick-sale checkout (cart column)

- ✅ **Scan entry field**: a dedicated add-to-cart field (not search). Enter adds one item immediately.
- ✅ **Quantity prefix**: `3*code`, `1.5x code`.
- ✅ **Next-scan multipliers**: ×2 / ×3 / ×5 / ×10 one-shot tiles (also apply to product-card clicks).
- ✅ Scan result strip (added item · qty · price, or a clear error such as unknown barcode).
- ✅ Scanner works with no field focused (keyboard-wedge listener).
- ✅ Quick actions: **Hold (F4)**, **Recall (F6)**, **+1 last item**.
- ✅ Customer (F7) and invoice discount (F8) shortcuts; Clear cart with confirmation.
- ✅ **Payment inside the cart column** (no modal): method tiles, pre-filled amount due, quick cash
  (exact + round-ups), split tender, change due. **F9** opens payment, then completes the sale.
- ✅ Adding/holding is locked while a sale is completing or awaiting acknowledgment (prevents a
  new sale reusing the previous attempt’s idempotency key).

### 2.4 Cart, pricing & tax

- ✅ Fractional quantities (thousandths), merge of identical lines.
- ✅ Line and invoice discounts (fixed or percentage).
- ✅ Per-item tax (inclusive/exclusive, rates), totals with tax breakdown.
- ✅ Attach a customer to a sale.

### 2.5 Offline sale & sync

- ✅ Durable local sale write, offline sale readiness checks and policy.
- ✅ Invoice upload worker with idempotency, crash recovery, failure classification, rejected-invoice
  recovery tooling, disposition discovery.
- ✅ Sale recovery banner: retry / abandon (with confirmation) / acknowledge.
- ✅ Sync page with queue state and review of failures.

### 2.6 Shifts

- ✅ Open (opening cash), pause, resume, close (counted cash, expected cash, variance).
- ✅ Local shift authority so selling continues when the backend is unreachable.

### 2.7 Refunds, sales history, receipts

- ✅ Sales history and sale detail pages.
- ✅ Refund against the original invoice, partial refunds, optional stock return, refund upload.
- ✅ Receipt preview, print, **reprint** (sale and refund), print job tracking/cancel.
- ✅ Printer settings per workstation (printer, paper width, direct/silent dispatch, **auto-print after sale**).
- ✅ Receipt profile (header/footer/logo) published per company.

---

## 3. Missing features

### 3.1 Critical for a supermarket

| #   | Feature                                                                             | Status | Notes                                                                                                                             |
| --- | ----------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| M1  | **Weighted / price-embedded barcodes** (EAN-13 prefix 20–29: PLU + weight or price) | ❌     | Lookup is exact-match only; scale labels will be “not found”. Needs a configurable barcode-rule parser.                           |
| M2  | **Scale integration** (serial/USB weight read)                                      | ❌     | Main-process bridge; weight → quantity.                                                                                           |
| M3  | **Cash drawer kick** on cash sale / “no sale” open                                  | ❌     | ESC/POS pulse via the existing printing bridge; audit every manual open.                                                          |
| M4  | **Cash in / cash out (pay-in, payout, expenses)**                                   | ❌ 🔌  | Backend shift report already exposes `expense_payout_amount` and `cash_drawer_movement_count`; desktop has no UI/endpoint wiring. |
| M5  | **X report / Z report** (mid-shift and end-of-shift)                                | ❌ 🔌  | Sales by tender, refunds, discounts, tax, variance; printable.                                                                    |
| M6  | **Supervisor override / manager PIN**                                               | ❌ 🔌  | For voids, refunds, discounts above a limit, price override, drawer open, clearing a cart.                                        |
| M7  | **Persistent held sales**                                                           | 🟡     | Held sales live in memory and are lost on app restart/sign-out/shift change. Needs a SQLite table + IPC.                          |
| M8  | **Post-sale void** (same shift, before upload)                                      | ❌ 🔌  | Today corrections go through refunds only.                                                                                        |

### 3.2 Important

| #   | Feature                                                                           | Status | Notes                                                                                   |
| --- | --------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------- |
| I1  | **Promotions engine** (buy X get Y, multi-buy, mix & match, time-based, category) | ❌ 🔌  | Needs pricing-rule contract in the bootstrap snapshot.                                  |
| I2  | **Loyalty** (earn/redeem points, member prices)                                   | ❌ 🔌  | Loyalty payment type exists but is marked ineligible.                                   |
| I3  | **Price check mode**                                                              | ❌     | Scan without adding to cart.                                                            |
| I4  | **Open-price / unknown item** with approval                                       | ❌     | Sell an unlabeled item at a typed price; report the barcode.                            |
| I5  | **SKU / PLU in the scan field**                                                   | ❌     | Scan field matches barcodes only; cashiers often type short PLU codes for produce.      |
| I6  | **Age-restricted item prompt**                                                    | ❌ 🔌  | Product flag + confirmation.                                                            |
| I7  | **Line quantity typing / line discount UI**                                       | 🟡     | Store supports `setQuantity` and line discounts; the cart line only has +/− and remove. |
| I8  | **Customer-facing display** (second screen / pole display)                        | ❌     | Total, last item, change due.                                                           |
| I9  | **Card terminal integration**                                                     | ❌     | Card is recorded manually with a reference.                                             |
| I10 | **Cash rounding rules**                                                           | ❌ 🔌  | Needed where small coins are not in use.                                                |
| I11 | **E-invoicing QR / tax authority fields on receipt** (e.g. ETA, ZATCA)            | ❌ 🔌  | Depends on the target country.                                                          |
| I12 | **Wallet / bank transfer tenders**                                                | ❌ 🔌  | Present in catalog, disabled at checkout by contract.                                   |

### 3.3 Later

- Gift cards, vouchers, coupons; store credit issued on refund.
- Bottle / container deposits.
- Shelf-label and barcode label printing.
- Self-checkout mode.
- Sales dashboards (hourly sales, top sellers) — usually the web admin, not the till.
- Receipts by SMS / WhatsApp / e-mail.
- Stock counts and goods receiving (back-office app, not the cashier screen).

---

## 4. Recommendations

### 4.1 Priority order

1. **Persist held sales (M7)** — small, local-only (SQLite migration + repository + IPC); removes the biggest
   data-loss risk of the new hold feature.
2. **Weighted barcodes + PLU in scan field (M1, I5)** — local-only, highest daily impact for produce/deli/meat.
3. **Cash drawer kick (M3)** — reuses the printing bridge; pair with an audited “no sale” action.
4. **Supervisor PIN (M6)** — agree the approval contract with the backend first, then gate discount limits,
   refunds, clear cart and drawer open.
5. **Cash in/out + X/Z reports (M4, M5)** — the backend shift report already has the fields; wire the endpoints
   and a printable report through the receipt pipeline.
6. **Promotions and loyalty (I1, I2)** — largest backend dependency; request the pricing-rule and loyalty
   contracts early so the desktop work can start once they are frozen.
7. **Hardware: scale, customer display (M2, I8)**.

### 4.2 Backend contract requests (🔌)

Raise these with the Laravel team before starting the desktop side (all under `/api/v1/desktop/*`):

- Shift cash movements (pay-in / payout / expense) and X/Z report endpoints.
- Supervisor approval (PIN verification or signed approval token) and the list of guarded actions.
- Pricing rules / promotions in the bootstrap snapshot, evaluated identically offline and on upload.
- Loyalty balance, earn and redeem rules.
- Product flags: age-restricted, open-price allowed, weighted item + barcode rule configuration.
- Cash rounding policy and e-invoicing fields per company/country.

### 4.3 UX

- Try the one-column checkout on the real cashier screen sizes (340/380/420px cart column) and with a
  real scanner; tune the scan field, multiplier tiles and quick-cash buttons for touch.
- Add editable quantity on the cart line (tap the quantity → keypad), and a line-discount action.
- Auto-focus the scan field after every completed/held/recalled sale (already done) and after closing dialogs.
- Show the held-sales count in the top bar so parked customers are never forgotten.
- Keep every shortcut on function keys only (scanners send digits + Enter).

### 4.4 Engineering

- Run the Electron-dependent test suites (`test:sqlite:electron`, receipt profile tests) in CI with the
  Electron binary installed.
- Fix the two pre-existing lint errors in `tests/electron/support/cp3g5/seedReliability.mjs`.
- Add an end-to-end smoke (Playwright + Electron): scan → hold → recall → pay → print → refund → reprint.
- Keep business rules in stores/services (cart store, quickSale helpers); keep `shared/components/pos`
  presentational (enforced by `importBoundary.test.ts`).

### 4.5 Operations

- Document a till setup checklist: printer + paper width, auto-print, scanner suffix (Enter), scale port,
  drawer cable to printer.
- Keep sync failures visible and reviewed daily (Sync page); add an alert when the queue stays non-empty
  for longer than a threshold.

---

## 5. Keyboard shortcuts (current)

| Key      | Action                       |
| -------- | ---------------------------- |
| F1       | Help / shortcuts             |
| F2       | Focus product search         |
| F3       | Focus scan field             |
| F4       | Hold sale                    |
| F6       | Recall held sale             |
| F7       | Choose customer              |
| F8       | Invoice discount             |
| F9       | Open payment → complete sale |
| `3*code` | Add a quantity in one scan   |
| Esc      | Close dialog / clear field   |
