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

- The app negotiates coverage (`offline_coverage_version: 1` on license validation and bootstrap); the backend extends
  nothing for a build that does not. Final review: a pre-Phase-4 build given an extended authority and catalog did sell
  past the current period's end under its own grace rule, which is why coverage is negotiated, not assumed. Journey
  `p4oldclient` (run against the `870f1bf` build) proves an older till keeps its previous boundary and still installs a
  licence response that carries `offline_coverage`.
- The license response's `subscription.offline_coverage` is parsed, stored with the license status (it survives
  restarts) and used by the local access decision when it starts exactly at the current period's end. The authority and
  catalog the server issued already end at the renewal's end, so a till that validated after the renewal was scheduled
  keeps selling offline across the old boundary; its sales upload once it reconnects.
- A renewal with different entitlements, an unpaid one, or one the till never heard about changes nothing: the till stops
  at the current period's end as before. Every other check (validation due, device, company, suspension, feature,
  permission, authority window, catalog window) is unchanged.
- Test harness: sandbox operations `subscription-end-soon <seconds>[:<grace seconds>]` (labelled precondition), `plan-capacity-change` (platform plan
  edit action), `report` gains `sold_at`/`authority`, `inspect-subscription` gains the last coverage decision; Electron
  journeys `p4renewaloffline` and `p4oldclient`.

## Not changed

- Unfinished carts are still not restored after an app restart (FU-P3-3).

## Running `p4oldclient` against an older build

The journey drives whichever app `tests/playwright/support/app.mjs` builds from its own tree. To test a released build,
export that commit to a scratch directory (not a worktree), overlay the current harness and run it there:

```
git archive <old-commit> | tar -x -C <scratch>
rm -r <scratch>/tests/playwright <scratch>/tests/electron/support/sandbox
cp -r tests/playwright <scratch>/tests/playwright; cp -r tests/electron/support/sandbox <scratch>/tests/electron/support/sandbox
ln -s "$PWD/node_modules" <scratch>/node_modules
cd <scratch> && PW_BACKEND_ROOT=<backend tree> node tests/playwright/run.mjs p4oldclient
```

Final review run: `<old-commit>` = `870f1bf` (desktop `main` before Phase 4); evidence in
`/var/www/html/thinis-pos/plans/phase4-final-evidence-20261007/oldclient-*` (before the fix: the old build committed a sale
after the current period's end; after: refused, nothing committed).
