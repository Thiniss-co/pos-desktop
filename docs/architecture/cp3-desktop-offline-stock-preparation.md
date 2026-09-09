# CP3 — Desktop durable preparation and bounded dependencies

**Status:** implemented. No production trigger is wired yet — CP4 owns the reconnect orchestration
and the readiness UI that call this.
**Backend counterparts:** CP2 `fee48ec` (prepare endpoint), CP2U `58dc24d` (upload contract).
**Authoritative plan:** `plans/POS_OFFLINE_STOCK_CONTINUITY_PLAN.md` §5.2–§5.6, §7.2, §10 CP3.

---

## 1. The two objects CP3 keeps apart

§7.2 is emphatic that the **evaluation cycle** and the **API operation** are different things, and
that confusing them is what made an earlier revision of the plan contradict itself. They get two
tables:

|                        | `prepare_cycles`  | `prepare_operations`                                 |
| ---------------------- | ----------------- | ---------------------------------------------------- |
| What it is             | local bookkeeping | the immutable API identity                           |
| Mutable?               | until it freezes  | never, once created                                  |
| Reaches the wire?      | no                | yes                                                  |
| Holds the blocked set? | yes               | no — a blocked product never occupies a request slot |

Keeping the cycle out of the canonical bytes is what lets a superseded, never-dispatched cycle be
abandoned without changing the hash of an operation that may already have reached Laravel.

## 2. The other two facts CP3 keeps apart

§5.4 names two truths that must never be conflated:

- **Grant ingested** — per allocation. Safe alone; an ingested grant is spendable under the ordinary
  rules whether or not its operation is complete. Lives in `stock_allocation_grants`.
- **Decision applied** — per operation. The only fact that closes one. Lives in
  `prepare_operations.state`.

No amount of grant ingestion moves an operation to `applied`. A zero outcome creates **no allocation
row at all**, so a discovery channel that returns allocations cannot in principle carry the zero half
of a decision — which is why only an authoritative replay can close an operation.

---

## 3. Lifecycle and ordering

```text
capture cycle boundary   (one SQLite transaction: high-water + cycle + partition + dependencies)
  -> partition           (pure, in memory)
  -> freeze operation    (one SQLite transaction; bytes immutable from here)
  -> mark dispatching    (one SQLite transaction, BEFORE the request leaves)
  -> HTTP                (NO transaction is open)
  -> apply or classify   (one SQLite transaction)
```

**No HTTP ever happens inside a SQLite write transaction.** Splitting persistence into short
transactions around the call is what satisfies that plan invariant.

**`dispatching` is written before the request leaves.** §7.2 makes ambiguity the _default_
classification: an implementation that cannot prove a request never left must treat it as ambiguous.
A durable write is the only thing that survives process death, so an in-memory flag would silently
downgrade a possibly-dispatched operation to "provably undispatched" after a crash — and editing or
replacing a body that may already have reached Laravel is exactly what produces either a `409` or a
second, unlinked grant.

### States (§5.6)

```text
captured -> superseded_before_dispatch | dispatching
dispatching -> ambiguous | superseded_uncommitted | applied
ambiguous -> discovered_pending_replay | applied | conflicted
discovered_pending_replay -> applied | conflicted
applied, conflicted, superseded_before_dispatch, superseded_uncommitted   [terminal]
```

Only two server answers are definitive:

- `409 POLICY_REVISION_STALE` proves no operation and no grant were created →
  `superseded_uncommitted`, terminal, and a new cycle may follow immediately;
- `409 IDEMPOTENCY_CONFLICT` proves this identity was used with different bytes → `conflicted`.

**Everything else is ambiguous** — a timeout, a 5xx, an aborted connection, a malformed success body.
A malformed body in particular is ambiguous rather than a failure: Laravel may well have committed
the decision and reserved the grants, so a new operation identity is never burned over it.

An operation that is `captured`, `dispatching`, `ambiguous`, or `discovered_pending_replay` is
resumed by **exact replay** before any new cycle may run (§5.6 step 5a). Resuming all four states,
rather than only the pre-dispatch ones, matters: falling through to a new cycle would partition the
unresolved operation's products into the blocked set and terminate as `blocked`, leaving the device
permanently unable to prepare products the server may already have granted.

---

## 4. Request identity

Canonical bytes, key order fixed by §5.3:

```json
{
  "prepare_contract_version": 1,
  "requested_policy_revision": 17,
  "authority": {
    "authority_reference_version": 1,
    "license_validation_uuid": "…",
    "catalog_revision": "…"
  },
  "selection": { "selection_version": 1, "kind": "products", "product_uuids": ["…"] }
}
```

- `operation_uuid` is the replay **scope**, not a hashed field.
- `response_representation_version` grants no authority and is excluded.
- Duplicates are **rejected**, never collapsed: two different intents must never produce one hash.
- The withdrawn `{"kind":"all","product_uuids":[]}` form is unrepresentable — it made two different
  eligible sets hash identically.

Recovery replays the **stored** bytes verbatim (`replayBodyFromCanonical`). It never re-partitions,
re-freezes, or re-hashes, however much local state has moved on. Database triggers enforce this
rather than convention: `canonical_request_json`, `request_hash`, `operation_uuid`, and
`selected_product_uuids_json` cannot be updated at all.

---

## 5. Bounded dependency capture (§7.2)

`sync_queue` gains a monotonic `queue_sequence`, assigned in the same transaction that commits each
queue row, and backfilled over existing rows in `(created_at, local_queue_uuid)` order — the same
order `claimDue()` already uses.

A cycle captures `MAX(queue_sequence)` inside the transaction that persists it, so a concurrently
committed row either lands below the mark and is captured, or lands above it and belongs to the next
cycle. There is no third possibility, which is what stops continuous selling from starving a cycle
rather than merely making it unlikely.

### Dependency effects

| Queue state       | Effect                                           |
| ----------------- | ------------------------------------------------ |
| `pending`         | blocks the touched product/allocation only       |
| `uploading`       | ambiguous; same narrow scope                     |
| `retryable_error` | same narrow scope                                |
| `conflict`        | terminal quarantine on the touched scope         |
| `rejected`        | terminal manual-review hold on the touched scope |
| `synced`          | **blocks nothing**                               |

`synced` blocking nothing is load-bearing: §7.1 forbids any physical-table-emptiness gate, because
`synced`, `conflict`, and `rejected` rows are all retained forever.

A row whose scope cannot be resolved blocks **every** candidate for this owner and warehouse, with
`dependency_scope_unknown`. §7.2 calls this an explicit data-integrity exception rather than the
normal policy, and it must never silently narrow to "no products affected".

Reasons have a fixed precedence so a product blocked several ways reports the one an operator can
act on: `dependency_scope_unknown` > `owned_by_unresolved_operation` > `terminal_conflict` >
`terminal_rejection` > `blocked_by_unreleased_hold` > `uploading_ambiguous` > `pending_upload` >
`retryable_error` > `policy_disabled`.

**A blocked product never blocks an unrelated one** (§6.8). Cola held by a terminal conflict is
recorded as blocked with its reason, as cycle state; Water is frozen, dispatched, and granted. The
Revision 2.1 tension is resolved by scope, not exception: Cola was never a dependency of Water's
operation because Cola was never _in_ it.

---

## 6. The completeness predicate (§5.4)

`evaluateCompleteness` is pure — no database, no clock — so it can be exercised exhaustively and no
part of it can be satisfied by a side effect. Six conditions, in order:

1. exact operation identity and request hash, compared against the **locally frozen** values;
2. exact frozen selected product set — same members, no more, no fewer;
3. one decision per selected product; a product with no record is a _missing decision_, not a zero;
4. complete grant linkage **in both directions** — every non-zero outcome names its allocation and
   that allocation is actually being ingested, and every locally discovered grant appears in the
   decision;
5. manifest and authority references present and coherent, including
   `authority_ready_until <= required_ready_until`;
6. atomic local application — the caller's obligation, enforced by `runSerializedWrite` at the call
   site and by the schema's refusal to store `applied` without a manifest.

**Forbidden inferences.** Completeness is never fabricated from matching quantities, one
`origin_operation_uuid`, a grant count equal to the selected-product count, an envelope with no
further grants, elapsed time, or operator assertion. `discoveryCanCompleteOperation()` returns
`false` as an explicit exported constant, because "just this once, the shapes line up" is exactly the
reasoning §5.4 forbids.

§6.7 is the damage this prevents: an operation over Cola, Water and Juice where bootstrap reveals
only Cola's grant. Treating absence as zero would silently convert Water's 12 real units into an
assumed zero _and_ let a later cycle re-request Juice against a cap the server has already charged.

---

## 7. Immutability enforced by the schema

Three triggers, because convention is not enforcement:

| Trigger                                    | Refuses                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `trg_prepare_operations_frozen_bytes`      | editing the canonical bytes, hash, identity, or selected set                                |
| `trg_prepare_operations_immutable_anchors` | rewriting `prepared_at`/`required_ready_until`, or moving `authority_ready_until` **later** |
| `trg_prepare_operations_terminal_state`    | any transition out of a terminal state                                                      |

`authority_ready_until` may only ever move **earlier** — a newly observed shorter subscription,
grace, license, catalog, session, or shift boundary shortens it. Nothing moves it later. §13 lists a
window that lengthens as a stop condition.

Two `CHECK` constraints carry the rest: `applied` requires a complete manifest, and an outcome's
allocation link is present exactly when it granted something.

---

## 8. What CP3 does **not** do

- **No production trigger.** Nothing calls `PreparationService.runCycle()` from a live code path yet;
  CP4 owns reconnect orchestration, IPC, and the readiness UI.
- **No renderer involvement.** §5.2: a renderer may _ask_ for preparation, but it never names the
  product set. `PreparationCandidateSource.resolveCandidates` is main's own policy resolution.
- **No quantity, duration, or target is ever sent.** The request carries none of them.
- **No change to the invoice upload representation.** CP2U introduced no payload version, so the
  desktop keeps emitting `client_contract_version: 2` unchanged.
- **No readiness projection.** The live countdown, `effective_ready_until`, and the §8.6 two-panel UI
  are CP4.
