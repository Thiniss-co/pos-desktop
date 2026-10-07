# Release notes — Phase 4 closeout (desktop)

Status: local commits on `feat/platform-plans-subscriptions` (desktop slot 1). **Not merged, not pushed, not released.**
Backend counterpart: `pos-backend` `feat/platform-plans-subscriptions`, `docs/release-notes/phase4-platform-plans-subscriptions.md`.

## Recovery of a draft refused while the subscription had lapsed (FU-P4-1)

- A sale refused by the till's own access decision now says so: new checkout failure code `access-denied` ("Selling is
  not allowed on this workstation right now, so this sale was not saved. The cart is kept…", EN/AR) instead of "The
  shift or workstation assignment changed".
- A refusal that claimed nothing no longer locks the draft, even briefly or when the status re-check fails; dismissing
  the dialog or changing the cart removes its message; exact cash (Shift+F9) works again for the same draft.
- After reactivation the cashier refreshes, reviews/rebuilds the kept draft as before and pays it once.
- Contract: `checkoutFailureCodeSchema` gains `access-denied` (main and renderer ship together; nothing persisted uses
  it — a claimed attempt keeps its row state, and the code is not stored). Details and tests:
  [FU-P4-1](../audits/follow-ups/FU-P4-1-refused-draft-recovery.md).

## Not changed

- Unfinished carts are still not restored after an app restart (FU-P3-3).
