# CP4 — 72-hour horizon, reconnect orchestration, and readiness

**Status:** implemented and wired to a real production trigger. The backend capability still ships
disabled, so on a default deployment every cycle ends `unavailable` without side effects.
**Parent baseline:** CP3 `b826e26`.
**Backend counterparts:** CP2 `fee48ec`, CP2U `58dc24d`, envelope fix `a709b7a`.
**Authoritative plan:** `plans/POS_OFFLINE_STOCK_CONTINUITY_PLAN.md` §7.3, §8.3, §8.5, §8.6, §10 CP4.

---

## 1. The countdown can never renew itself

This is the single property CP4 exists to hold. §8.5: a successful preparation result is a
**historical fact about `prepared_at`**, not a renewable entitlement. `ready_72h` records that a
full window was established _at `prepared_at`_ — not that 72 hours remain whenever the screen is
opened, a response arrives, the app restarts, or a replay re-presents the same decision.

```text
effective_ready_until = MIN(authority_ready_until, every boundary observed since)
remaining_seconds     = max(0, effective_ready_until - trusted_now)
```

`effective_ready_until` starts at the decision's immutable `authority_ready_until` and may only ever
move **earlier**. A later boundary is ignored outright rather than compared and discarded, so the
impossibility is structural instead of a rule someone must remember.

`trusted_now` is the same non-regressing trusted time that governs every commit check (§8.3). When
it is unavailable at all, readiness reports `blocked` rather than estimating: an unanchored device
has no basis for any claim about remaining time, and a wall-clock estimate is exactly the rollback
the trusted clock exists to fence.

**The renderer never computes it.** `remainingSeconds` arrives from main and is displayed verbatim.
The store's refresh interval decides only how often the number is re-read — never what it is. A
renderer clock is precisely how "re-deriving the countdown from the moment the screen opened" would
happen by accident, and §13 lists that as a stop condition.

### The §8.5 acceptance table

| Scenario                                         | Result                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| Two hours after preparation                      | ~70 h remaining; never 72; original window still shown as 72 h                  |
| Delayed response (prepared 10:00, applied 10:20) | expiry stays `10:00 + 72h`; remaining measured from `prepared_at`               |
| Restart                                          | reconstructed anchors reproduce the same `effective_ready_until`; no rebase     |
| Exact expiry                                     | `remaining_seconds = 0`; state `expired`                                        |
| Changed session or observed revocation           | `blocked`, regardless of remaining time                                         |
| Partial consumption                              | time unchanged; quantity reduced; quantity may read zero while time is non-zero |
| Shorter boundary observed after preparation      | shortens with its stable reason; never lengthens                                |

All seven are cases in `preparationReadiness.service.test.ts`.

---

## 2. Two panels, never merged

§8.1: time coverage and quantity coverage are independent. A time-ready workstation can still sell
only the finite allocated quantity, and ample quantity does not extend an earlier time guard. A
single combined "ready" indicator would be a lie in both directions, so the contract carries them as
two members and the UI renders them as two panels.

**Time panel** — `prepared_at`, the originally requested window, the live remaining time, the
supported-until instant, and **every tied limiting reason**. §8.6 forbids hiding a second limiter
that expires at the same instant, so ties are reported as a set rather than a first-wins string.

**Quantity panel** — per product: usable now, covered for the window (`Q72`), expiring early, and
held-but-not-sellable.

- _Usable now_ is the repository's reconciled figure: granted, minus the accepted server coverage
  boundary, minus every local committed consumption above it (§3.2). Deriving it as
  `granted - serverConsumed` would over-report by exactly the amount already sold offline.
- _Covered for the window_ counts only grants whose immutable `consume_until` reaches the window's
  end. A grant ending **exactly** at the deadline qualifies, because no sale may commit _at_ the
  deadline (§8.1). An existing short-lived grant contributes zero here while remaining perfectly
  spendable before its own expiry — different questions, different numbers.
- _Held, not sellable_ keeps expired and quarantined holds visible. §4.4: they are real, conserved,
  and occupy capacity; dropping them from the display because they cannot be sold would hide the
  reason a later preparation is blocked.

The exact full-window phrase is permitted **only** while the whole requested window still remains —
that is, only at the moment of a successful preparation. Main models that as its own state
(`ready_full_window`), so the UI looks it up rather than making the judgement itself.

An operation that is `ambiguous` or `discovered_pending_replay` is **never** rendered as a
successful preparation (§8.6). It appears under `unresolvedOperations` with its pending action.

---

## 3. Reconnect ordering (§7.3)

```text
1. restore transport and authorization      reads; may precede upload
2. read-only authoritative refresh          reads; monotonic reconciliation only
3. capture a bounded cycle and partition    local; grants nothing
4. drain captured dependencies              uploads for affected products only
5. prepare the eligible set                 the only step that creates authority
6. retire only selected grants              NEVER on ordinary reconnect
7. acknowledge proof, then optionally release   separate gates; release stays disabled
```

Two rules the plan had to correct, both encoded here:

- **There is no global sale pause and no single total order.** The cashier keeps selling from
  already valid local rights throughout. Unsafe _mutations_ are what the ordering fences; reads are
  not fenced.
- **"Every refresh before every upload is unsafe" is false** (§2.2 finding 1). The frozen
  reconciliation representation makes a verified refresh safe before upload. Reintroducing an
  upload-first rule would recreate the exact deadlock §7.3 removes: uploads need refreshed
  authority, and refresh would wait for an empty queue that §7.1 proves never comes. A failed
  refresh therefore does **not** stop the drain — a queued invoice's payload is immutable and its
  authority historical.

**Step 6 is a deliberate no-op**, recorded explicitly in the trace. §7.3 item 6 and §14.2 item 8:
healthy allocations are not sealed merely because connectivity returned. Making the non-action
visible is what stops a future change from quietly adding one.

---

## 4. The IPC boundary

Two channels, both taking a **strict empty object**:

| Channel                     | Returns                     |
| --------------------------- | --------------------------- |
| `preparation:get-readiness` | the readiness projection    |
| `preparation:run-cycle`     | a categorical cycle outcome |

`.strict()` on an empty shape is the point. A renderer cannot smuggle a product set, a quantity, a
duration, an owner tuple, or a clock through either channel, because _any_ key is a validation
failure. §4's invariant — "renderer cannot supply authoritative quantities, ownership, time, or
grant rights" — is enforced by the schema rather than by review.

The façade methods on `ApplicationServices` take no arguments either, and resolve the owner tuple
fresh from main's own session and bootstrap state on every call. A device that is unauthenticated or
unassigned has no preparation owner, and every entry point reports that rather than guessing one.

The renderer learns _what happened_, never a quantity it could act on as authority and never an
allocation identifier.

---

## 5. The production trigger

Subscribed to `CommercialAccessPublisher.publish()` — the same authoritative access-change point the
upload and recovery workers already use. It fires on licence validation, bootstrap-refresh
completion, catalog refresh, and connectivity, so it covers "connectivity returned" and "authority
was restored" without polling and without a fabricated event.

It is a scheduling hint and nothing more. `runCycle()` re-resolves the owner, re-reads connectivity,
re-captures its own bounded boundary, and re-partitions on every call, so a hint arriving while the
device is offline, unassigned, or blocked simply does nothing — and one arriving while an operation
is unresolved replays that operation's frozen bytes rather than starting a new one (§5.6).

Fire-and-forget by design: a preparation failure must never surface as an access-publish fault, and
every outcome the cycle can reach is already persisted durably by the cycle itself.

---

## 6. Candidate resolution, and what it deliberately does not do

`resolveCandidates` returns the tracked products this device already holds allocation evidence for,
in this warehouse. That is narrower than "every catalog product" on purpose: the desktop has no
policy-visibility contract, so naming products the server has no policy for would ask it to evaluate
scopes this device has no business naming, and would turn an ordinary configuration gap into a
refused operation.

`policyDisabledProducts` returns empty for the same reason. Nothing is _locally_ known to be
policy-disabled, and the server refuses an unconfigured product outright — the fail-closed
direction. A product wrongly believed eligible is refused; one is never granted.

The policy revision is learned from the server. A `409 POLICY_REVISION_STALE` names the applied
revision, which is persisted so the next cycle carries it. Without that the desktop would send
revision 0 forever and never converge, because there is no other channel through which it could
learn the number. The value is a server observation, never a client claim, and persisting it grants
no authority — it only changes which revision the next request declares having evaluated against.

---

## 7. What CP4 does **not** do

- **No release, no seal.** Release stays a separate, still-disabled CP6 branch.
- **No change to the invoice upload representation.** CP2U introduced no payload version, so the
  desktop keeps emitting `client_contract_version: 2` unchanged.
- **No new sale-path guard.** The catalog-expiry guard shipped in Revision 2.3 and CP4 only keeps it
  passing; CP4 adds no commit-time check of its own.
- **No reassignment or revocation quarantine.** That is CP5.
- **No production activation.** The backend capability ships disabled; a default deployment reaches
  `unavailable` and stops.
