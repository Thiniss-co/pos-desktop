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

## Offline selling across a paid, scheduled renewal (O-7)

- The license response's additive `subscription.offline_coverage` is parsed, stored with the license status (it survives
  restarts) and used by the local access decision when it starts exactly at the current period's end. The authority and
  catalog the server issued already end at the renewal's end, so a till that validated after the renewal was scheduled
  keeps selling offline across the old boundary; its sales upload once it reconnects.
- A renewal with different entitlements, an unpaid one, or one the till never heard about changes nothing: the till stops
  at the current period's end as before. Every other check (validation due, device, company, suspension, feature,
  permission, authority window, catalog window) is unchanged.
- Test harness: sandbox operations `subscription-end-soon` (labelled precondition), `plan-capacity-change` (platform plan
  edit action), `report` gains `sold_at`/`authority`, `inspect-subscription` gains the last coverage decision; Electron
  journey `p4renewaloffline`.

## Not changed

- Unfinished carts are still not restored after an app restart (FU-P3-3).
