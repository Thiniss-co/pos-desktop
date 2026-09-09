# Phase 3G — Manual GUI smoke checklist (user-executed)

> ## AUTOMATED GATE PASS DOES NOT COMPLETE THIS CHECKLIST.
>
> CP-3G-7's automated verification passed in both repositories on 2026-09-03. That result says
> nothing about the thirteen observations below. Every box here is still **unchecked**, and Phase 3G
> stays **BLOCKED ON E1–E13 USER RESULTS** until you fill them in.

**Emitted by:** CP-3G-7, from frozen desktop commit `9a1232ba90b3a2fe3799bc42d02bca1d14c79c22`
(backend `2bcce42e9102d76eb57a24445791499989912a05`).
**Source of truth:** `plans/POS_PHASE_3G_CONTROLLED_UPLOAD_PLAN.md` §12 (revision 5).
**Status:** NOT RUN.

---

## Rules — read before starting

1. **Only you may mark PASS / FAIL / N/A.** No agent, script or CI job may mark any item, and none
   has. If you find an item already marked, treat that as a defect in the document.
2. **Automated tests and database inspection cannot satisfy a GUI observation.** A unit test, an
   Electron harness test, a crash-recovery proof or a `SELECT` is not the on-screen fact. CP-3G-6
   proved E4's *property* at the process, transport and database level; that does **not** close E4.
3. **Run from your own terminal.** `npm run dev` fails in an agent or VS Code integrated shell
   because `ELECTRON_RUN_AS_NODE` is set there. GUI proof comes from a plain terminal you opened
   yourself.
4. **Use isolated test data and an isolated profile.** Never a production company, production
   device, production till or production database.
5. **Never run destructive fault injection against production.** Everything in E7–E10 assumes an
   isolated backend you are free to break.
6. **Record what you actually saw** — the visible result, the console/main-process trace, and the
   `trace_id` on any failure.
7. **Redact before writing anything down**: bearer tokens, passwords, activation codes, device
   secrets and full payment references. A truncated `trace_id` (first 8 characters) is enough.
8. **Stop and report** rather than improvising if an item needs a backend change, a migration, an
   admin/test bypass endpoint, or anything under `/api/v1/admin/*`. None of that is authorized.

---

## Setup (do once, before E1)

- [ ] Open a **plain terminal** — not the agent shell, not the VS Code integrated terminal.
- [ ] Confirm the environment is the frozen baseline:
      `git -C /var/www/html/thinis-pos/pos-desktop rev-parse HEAD` → `9a1232b…`, worktree clean.
- [ ] Point the desktop app at an **isolated backend** (a scratch company, a scratch device, a
      scratch database). Confirm it is **not** your normal development database before continuing.
- [ ] Register/activate the test device and log in as **cashier A**. Create a second cashier,
      **cashier B**, on the same company and the same authorized device — E11 needs it.
- [ ] Confirm cashier A holds `pos.sell` **and** `pos.invoice.upload`, and that the company's
      subscription allows `canSync`.
- [ ] Seed at least one sellable product with tracked stock, and open a shift.
- [ ] Have a way to **stop and start the backend** (E1/E2/E6) and to **revoke and restore**
      `canSync` or `pos.invoice.upload` (E7/E8) through ordinary supported mechanisms — the
      company-users permission screen, or a direct change on the isolated backend. **Do not add a
      test-only bypass endpoint.**
- [ ] Open the sync surface in the app so the pending count, pause reason, **Upload now** control
      and failure-review list are visible while you work.
- [ ] Have the main-process/network trace visible for E13.

Record the environment once here, so every result below is anchored to it:

```
Date/time started : ______________________
Desktop commit    : ______________________
Backend commit    : ______________________
Isolated backend  : ______________________   (confirm: NOT production, NOT normal dev DB)
Test company      : ______________________
Test device       : ______________________
Cashier A / B     : ______________________
```

---

## Checklist

### - [ ] E1 — Sell while the backend is unavailable

Sell while the backend is unavailable. The sync indicator shows one pending invoice and nothing
uploads.

*Setup:* stop the backend (or block its origin) **before** completing the sale. Complete one
ordinary sale for cashier A.
*Observe:* the sale completes locally; the sync indicator reads exactly **1 pending**; no upload
attempt appears in the trace.

```
Result      : [ ] PASS   [ f] FAIL   [ ] N/A
Timestamp   : ______________________
Observation : ______________________________________________________
Trace ID    : ______________ (sanitized)
Notes       : i cannot perfrom any action when the pos backednd is unavailable and i got "Affected products: Chips Small. One or more tracked products do not have enough stock allocated to this workstation. Adjust the quantity, or refresh workstation data after an allocation is issued. Refreshing does not create or top up an allocation."
```

### - [ ] E2 — Bring the backend back

Bring the backend back. Within one production trigger cycle the invoice uploads automatically,
pending returns to zero and the invoice receives its server number.

*Setup:* start the backend again. **Do not press Upload now** — this item is about the automatic
trigger.
*Observe:* within one production trigger cycle the invoice uploads by itself; pending returns to
**0**; the invoice shows a server number.

```
Result      : [passed ] PASS   [ ] FAIL   [ ] N/A
Timestamp   : ______________________
Observation : ______________________________________________________
Trace ID    : ______________ (sanitized)
Notes       : it synced all invoices but the first E1 is faild so the enfocred to return backend up to complete the sale and the track the remaining qty
```

### - [ ] E3 — Restart with a pending invoice

Restart with a pending invoice. It uploads after startup exactly once.

*Setup:* with the backend down, complete a sale; close the app fully; start the backend; launch the
app again.
*Observe:* after startup the invoice uploads; the trace shows **exactly one** upload request for it;
pending returns to 0.

```
Result      : [ ] PASS   [fail ] FAIL   [ ] N/A
Timestamp   : ______________________
Observation : ______________________________________________________
Trace ID    : ______________ (sanitized)
Notes       : when i disable the backend all products DISABLED and i cannot add to cart any product and complete any sale
```

### - [ ] E4 — Kill the application mid-upload

Kill the application mid-upload with SIGKILL, restart, and observe eventual synced status while
Laravel contains one invoice, not two.

*Setup:* queue a sale, then `kill -9` the app while its upload is in flight. Restart it.
*Observe on screen:* the invoice eventually reaches **synced**.
*Then confirm on the isolated backend:* exactly **one** invoice for that offline number — **not
two**.
*Reminder:* the database reading alone does not satisfy this item. The on-screen synced status is
the observation; the row count is the corroboration.

```
Result      : [ ] PASS   [ ] FAIL   [ ] N/A
Timestamp   : ______________________
Observation : ______________________________________________________
Backend invoice count for that offline number : ______
Trace ID    : ______________ (sanitized)
Notes       : ______________________________________________________
```

### - [ ] E5 — Upload now with an empty queue

Press Upload now with an empty queue. Nothing uploads and no misleading error appears.

*Setup:* drain the queue first so pending reads 0. Backend reachable.
*Observe:* pressing **Upload now** produces no upload request and **no error message**; the surface
stays calm and truthful.

```
Result      : [ ] PASS   [ ] FAIL   [ ] N/A
Timestamp   : ______________________
Observation : ______________________________________________________
Trace ID    : ______________ (sanitized)
Notes       : ______________________________________________________
```

### - [ ] E6 — Upload now while offline

Press Upload now while offline. A clear offline explanation appears and no attempt occurs.

*Setup:* stop the backend (or disconnect the network) with at least one row queued.
*Observe:* pressing **Upload now** shows a clear **offline** explanation — not a generic failure —
and the trace shows **no** outbound attempt.

```
Result      : [ ] PASS   [ ] FAIL   [ ] N/A
Timestamp   : ______________________
Observation : ______________________________________________________
Trace ID    : ______________ (sanitized)
Notes       : ______________________________________________________
```

### - [ ] E7 — Revoke sync authority

Revoke `canSync` or `pos.invoice.upload` in the isolated backend. The worker visibly pauses with the
correct reason, selling remains available and queued rows retain their states.

*Controlled setup (isolated backend only, supported mechanisms only):*
choose **one** —
(a) remove `pos.invoice.upload` from cashier A's role through the ordinary company-users permission
    screen; or
(b) move the isolated company's subscription into a state where `canSync` is denied, through the
    ordinary subscription mechanism.
Then let the app refresh its bootstrap/access snapshot, or restart it.
**Do not add an admin or test bypass API. Do not call `/api/v1/admin/*`.**
*Observe:* the sync surface shows the worker **paused** with the correct reason
(`permission-denied` for (a), a commercial-access reason for (b)); **selling still works**; queued
rows keep the states they already had — nothing is rejected, nothing is retried.

```
Revocation used : [ ] (a) pos.invoice.upload   [ ] (b) canSync
Result      : [ ] PASS   [ ] FAIL   [ ] N/A
Timestamp   : ______________________
Pause reason shown : ______________________
Queued row states before / after : ______________ / ______________
Observation : ______________________________________________________
Trace ID    : ______________ (sanitized)
Notes       : ______________________________________________________
```

### - [ ] E8 — Restore access

Restore access. The production commercial-access/bootstrap signal resumes and drains the worker
without a manual trigger.

*Setup:* undo exactly the E7 change, the same supported way.
*Observe:* the pause clears on the production access-change/bootstrap signal and the queue drains
**without** you pressing **Upload now**. Pressing it would invalidate this item — leave it alone.

```
Result      : [ ] PASS   [ ] FAIL   [ ] N/A
Timestamp   : ______________________
Time from restore to drain : ______________
Manual trigger used? : [ ] NO (required)   [ ] YES → item FAILS
Observation : ______________________________________________________
Trace ID    : ______________ (sanitized)
Notes       : ______________________________________________________
```

### - [ ] E9 — Controlled stale-catalog 422

Produce a controlled stale-catalog 422. The invoice appears as rejected with reason and trace ID,
while the local sale, payments and receipt remain intact.

*Controlled setup (isolated backend only):* complete a sale offline so its payload freezes against
the catalog revision then in force. **Before** letting it upload, change that product on the
isolated backend through the ordinary product screen — change its price — so the catalog revision
moves on. Then let the upload run.
*Observe:* the invoice appears in the **failure review list as rejected**, showing the reason and a
`trace_id`; the **local sale, its payments and its receipt data are all still intact and readable**;
the row is not retried.

```
Result      : [ ] PASS   [ ] FAIL   [ ] N/A
Timestamp   : ______________________
Rejection reason shown : ______________________
Trace ID    : ______________ (sanitized)
Local sale / payments / receipt intact? : ______________
Observation : ______________________________________________________
Notes       : ______________________________________________________
```

### - [ ] E10 — Controlled idempotency 409

Produce a controlled idempotency 409. The invoice appears as conflict, is not retried and preserves
both the local evidence and reported reason.

*Controlled setup (isolated backend only):* upload the **same idempotency key** twice with
**different** content, so the backend answers `409 IDEMPOTENCY_CONFLICT`. The supported way is to
let one payload commit on the isolated backend, then present a genuinely different payload under the
same key. Use only ordinary upload traffic — no admin or test endpoint.
*Observe:* the item shows as **conflict**; it is **not retried**; both the local payload evidence
and the reported reason are visible.

```
Result      : [ ] PASS   [ ] FAIL   [ ] N/A
Timestamp   : ______________________
Conflict reason shown : ______________________
Trace ID    : ______________ (sanitized)
Retried? : [ ] NO (required)   [ ] YES → item FAILS
Observation : ______________________________________________________
Notes       : ______________________________________________________
```

### - [ ] E11 — Cross-cashier upload on the same device

Sell as cashier A, log out, log in as cashier B on the same authorized device, and confirm A's
invoice uploads while remaining attributed to A's historical shift.

*Setup:* as cashier A, complete a sale with the backend down. Log out. Log in as **cashier B** on
the **same authorized device**. Restore the backend.
*Observe:* A's queued invoice uploads under B's session, and on the isolated backend it is
attributed to **cashier A's** historical shift — not to B, and not to B's shift.

```
Result      : [ ] PASS   [ ] FAIL   [ ] N/A
Timestamp   : ______________________
Uploaded under session of : ______________________
Attributed on backend to  : ______________________ (must be cashier A's shift)
Observation : ______________________________________________________
Trace ID    : ______________ (sanitized)
Notes       : ______________________________________________________
```

### - [ ] E12 — Upload after the originating shift closes

Upload an invoice after its originating shift closes. It succeeds through the post-close adjustment,
while signed-off shift totals remain unchanged.

*Setup:* with the backend down, complete a sale in the current shift. **Close that shift** and note
its signed-off totals. Restore the backend and let the queued invoice upload.
*Observe:* the upload **succeeds** through the post-close adjustment path; the closed shift's
**signed-off totals are unchanged**.

```
Result      : [ ] PASS   [ ] FAIL   [ ] N/A
Timestamp   : ______________________
Signed-off totals before : ______________________
Signed-off totals after  : ______________________ (must be identical)
Observation : ______________________________________________________
Trace ID    : ______________ (sanitized)
Notes       : ______________________________________________________
```

### - [ ] E13 — Outbound namespace

Observe one sale and upload in the network/main-process trace. All outbound application calls stay
under `/api/v1/desktop/*`.

*Setup:* with the trace visible, complete one ordinary sale and let it upload.
*Observe:* **every** outbound application request is under `/api/v1/desktop/*`. Not one
`/api/v1/admin/*` and not one `/api/v1/auth/*` request appears. (The unauthenticated `/up`
readiness probe is intentionally separate from the desktop API client and is not an application API
call — note it if you see it, but it does not fail this item.)
*Note:* this item **replaces** the Phase 3F smoke item D20, which asserted that no upload is
attempted. On this build an upload **is** expected once a sale is queued and sync authority is
available.

```
Result      : [ ] PASS   [ ] FAIL   [ ] N/A
Timestamp   : ______________________
Distinct outbound paths seen : ______________________________________
Any non-/api/v1/desktop/* application call? : [ ] NO (required)   [ ] YES → item FAILS
Observation : ______________________________________________________
Trace ID    : ______________ (sanitized)
Notes       : ______________________________________________________
```

---

## Cleanup (after E13)

- [ ] Close the app.
- [ ] Restore any permission, role or subscription you changed for E7/E8 on the isolated backend.
- [ ] Restore any product price you changed for E9.
- [ ] Leave the isolated test data in place if you want the results reproducible; do **not** clean
      any normal development or production database.
- [ ] Confirm no stray Laravel server or test port is left listening from your session.
- [ ] Re-read your notes and confirm no token, password, activation code, device secret or full
      payment reference was written down.

---

## Result summary

| Item | PASS | FAIL | N/A | Timestamp | Sanitized trace ID |
|---|---|---|---|---|---|
| E1 — offline sale, one pending | | | | | |
| E2 — automatic upload on recovery | | | | | |
| E3 — restart uploads exactly once | | | | | |
| E4 — SIGKILL mid-upload, one invoice | | | | | |
| E5 — Upload now, empty queue | | | | | |
| E6 — Upload now, offline | | | | | |
| E7 — sync authority revoked, worker pauses | | | | | |
| E8 — access restored, drains automatically | | | | | |
| E9 — stale-catalog 422 → rejected | | | | | |
| E10 — idempotency 409 → conflict | | | | | |
| E11 — cross-cashier upload, A's attribution | | | | | |
| E12 — upload after shift close | | | | | |
| E13 — outbound namespace | | | | | |

```
Items passed : ____ / 13
Items failed : ____
Items N/A    : ____
Executed by  : ______________________
Completed    : ______________________
```

---

## Standing status until you return these results

```
Manual GUI items passed:      0/13 — USER ONLY
CP-3G-7 automated verification: PASS
CP-3G-7 overall:              AWAITING USER GUI SMOKE
Phase 3G closure:             BLOCKED ON E1–E13 USER RESULTS
Allocation release:           DISABLED
BE-3F-4:                      NOT STARTED
Production activation:        NOT AUTHORIZED
```

**AUTOMATED GATE PASS DOES NOT COMPLETE THIS CHECKLIST.**
