# Phase 3F — manual GUI smoke checklist (user-executed)

**This is the last gate standing between Phase 3F and closure.** Everything else in Phase 3F is
implemented, committed and verified (see `cp-5e-7-combined-verification-checkpoint.md`).

## Rules

- **Nothing here may be claimed by an agent.** A GUI item is **never** satisfied by a unit test, an
  Electron harness test, or a database reading. If an item is not observed on screen, it is not done.
- Run from **your own terminal**, not an agent/VS Code shell: `ELECTRON_RUN_AS_NODE` is set in the
  agent environment and `npm run dev` will not start the GUI there.
  ```
  cd /var/www/html/thinis-pos/pos-desktop
  npm run dev          # or: npm run dev:linux   (adds --ozone-platform=x11)
  ```
- Record the result next to each item: **PASS**, **FAIL** (with what you saw), or **N/A** (with why).
- A FAIL is useful information, not a setback. Report it as observed — do not work around it.

## Already proven automatically — do NOT re-derive by hand

These carry executable proof and need no GUI confirmation: exact deficit sizing; one top-up per
attempt; zero HTTP when grants suffice; untracked-only carts never reaching the allocation endpoint;
foreign / stale / malformed / partial grant refusal; crash-replay under the identical derived key;
concurrent-completion coalescing; zero business writes on every rejection path; one queue row per
invoice; movement `synced` being impossible.

---

## A. Tracked stock and allocation

> Revision 3's old item 17 ("with no allocation a tracked cart is blocked even while connected") is
> **historical and contradicted** by the approved connected-acquisition design. Do not execute it.
> A1–A3 replace it.

- [ ] **A1 — Connected, no local allocation.** Ring a tracked product with no usable grant, online.
  - exactly **one** exact-deficit acquisition happens for that attempt;
  - the request asks for **only** the missing quantity — no buffer, no whole-catalog top-up;
  - the grant is persisted, local authority is re-read, and the sale commits **only** after coverage
    is proven;
  - in the backend, exactly **one** allocation request and **one** grant were created;
  - rejection / partial-grant / malformed / ambiguous outcomes leave the till in an explained state,
    and an ambiguous outcome offers a safe retry of the **same** sale.
- [ ] **A2 — Offline, no sufficient allocation.** Disconnect, ring the same tracked product.
  - tracked completion is **rejected**, and the message **names the affected product**;
  - the draft remains and is recoverable;
  - **no business rows** are written (invoices, payments, movements, consumptions, queue counts all
    unchanged);
  - **no HTTP request is attempted at all.**
- [ ] **A3 — Existing sufficient allocation.**
  - selling within the remaining quantity performs **no top-up request** — check this **while
    online**, not only while offline;
  - sell up to the local remaining quantity; **the next unit is rejected**, cart retained, product
    named;
  - then **Refresh workstation data** and try again: the refresh must **not** resurrect the consumed
    quantity, and the next unit must **still** be rejected.

## B. Ordinary sale and receipt

- [ ] **B1** Open a shift; build a cart with a fractional quantity, a line discount and an invoice
  discount.
- [ ] **B2** Disconnect the network; the offline indicator appears and pricing still works.
- [ ] **B3** Split cash + card with a reference; change/due are correct in the preview.
- [ ] **B4** Complete once — the number appears **labelled local/offline and explicitly non-fiscal**,
  the cart clears, and the "Completing sale…" pending state **resets**.
- [ ] **B5** Double-click Complete on a fresh cart — **exactly one** sale, one invoice row, one queue
  row.
- [ ] **B6** Complete an **untracked Service Item while disconnected** — succeeds, with no allocation
  request, no consumption and no stock movement.
- [ ] **B7** Exactly **one invoice and one queue row per commit**, and the sync indicator now shows a
  non-zero pending count (expected — the first time in the product's life).

## C. Recovery and attempt lifecycle

- [ ] **C8** Hard-kill mid-completion (`kill -9`), relaunch. The recovery banner appears from on-disk
  state alone. No second sale exists.
- [ ] **C9** From that banner, **retry** — exactly one sale results, totals match what was rung.
- [ ] **C10** Repeat C8, then **abandon** — no sale exists, the till unblocks, and the tender warning
  was shown and required explicit confirmation.
- [ ] **C11** With a `claimed` attempt outstanding, start a new sale — blocked, with the recovery
  route offered.
- [ ] **C12** Log out and back in as the same cashier with an unacknowledged sale — still recoverable.
- [ ] **C13** Log in as a **different** cashier — the first cashier's attempt is not offered, and the
  new cashier can sell normally.
- [ ] **C14** Complete two sales while suppressing each response/ack, restart, discover both,
  acknowledge one, prove the other remains, then acknowledge it independently.
- [ ] **C15** Claim in shift S1, kill before commit, close S1 and open S2, then retry —
  `context-changed`, and no S2 sale.
- [ ] **C16** Repeat with branch/warehouse reassignment — `context-changed`, and no re-scoped stock
  movement.
- [ ] **C17** Hard-kill mid-completion, change the catalog, then retry — `refresh-required`, and
  **no repricing**.

## D. Guards and boundaries

- [ ] **D18** Pause the shift; attempt completion — refused, cart retained.
- [ ] **D19** Device with no assigned branch or warehouse — **every** sale is refused cleanly as
  `workstation-unassigned`, not as a misleading closed-shift message.
- [ ] **D20** Nothing touches `/api/v1/admin/*`, and the **only** outbound desktop call a sale can
  make is `POST /api/v1/desktop/stock-allocations/top-up` — in particular **no invoice upload is
  attempted**.

> **D20 has an expiry date.** It is true only while Phase 3G has not shipped. The moment the
> controlled-upload worker lands (CP-3G-3), D20 inverts: invoice upload *must* be attempted. Run this
> checklist **before** starting 3G implementation, or record which items were run after it.

---

## Reporting back

Paste the results in any form — a list of item ids with PASS/FAIL is enough. On FAIL, include what
you saw on screen and, if you have it, the `trace_id` or the console output.

Once these are reported, Phase 3F closes and the Phase 3G plan
(`/var/www/html/thinis-pos/plans/POS_PHASE_3G_CONTROLLED_UPLOAD_PLAN.md`) is unblocked end to end.
