# CP-5D — Exact-deficit stock-allocation acquisition

Date: 2026-08-30

Scope: Phase 3F only. This checkpoint adds the missing production Electron caller for the existing
authenticated `POST /api/v1/desktop/stock-allocations/top-up` endpoint. It adds no release path, no
seal/acknowledgment path, no upload worker, no Phase 3G work, no backend change, no deployment, no
staging, no commits, and no pushes.

## Approved-policy conformance

No conflict was found between the approved acquisition behaviour and the authoritative plan.
§3.3 of the plan already specifies "an idempotent allocation request/top-up endpoint accepts
product/quantity demand but the server decides the granted quantities under allocation policy and
locks", and §3.2's rule that a connected sale "must already own enough allocation" is preserved
literally: the grant is acquired *before* the business transaction, and the transaction still proves
ownership by re-reading persisted grants from SQLite. Being online never substitutes for owning
allocation, and shared/unreserved stock is never consulted.

## Idempotency key — the one deliberate deviation from "reuse `attemptKey`"

The checkpoint permits reusing the existing `attemptKey` "only after verifying it satisfies
Laravel's real request contract". It does not.

`StockAllocationService::topUp()` stores `stock_allocation_requests.idempotency_key` bound to
`sha256(json(['version' => 1, 'items' => $aggregatedDemands]))` and answers any later request that
reuses the key with different content with `409 IDEMPOTENCY_CONFLICT` (`assertSameHash()`). A single
sale attempt legitimately produces different demand sets across retries, because the backend grants
`min(demand, unreserved_available)` — a partial grant is persisted locally, so the next retry of the
*same* attempt has a strictly smaller deficit. The bare attempt key would turn that correct retry
into a permanent conflict.

The key is therefore `sha256(canonical({version, purpose, attemptKey, items:[{productUuid,
quantityMilli}]}))`. It keeps every property the checkpoint requires:

- **bound to the sale attempt** — the attempt key is part of the pre-image;
- **durable** — never stored and never random; recomputed from the durable attempt row's canonical
  intent plus the durable grant rows, so a relaunch reproduces it byte-for-byte;
- **replay-stable** — a lost response, an ambiguous transport outcome, or a crash before persistence
  all leave the demand unchanged, so the replay hits Laravel's stored, effect-free result.

No migration and no new durable transition were required.

## Where the acquisition runs

`LocalSaleService.complete()`/`retry()` were split into a read-only `prepareCompletion()`/
`prepareRetry()` and the unchanged `runPrepared()` business transaction; the synchronous
`complete()`/`retry()` compositions remain and behave exactly as before. `SaleCompletionService`
(new, async) owns the ordering and is what `checkout:complete` / `checkout:retry-attempt` now call:

```text
durable claim / resolve attempt (read-only)
  → tracked-line resolution through the single company-scoped catalog snapshot
  → exact-deficit calculation from usable persisted grants only
  → [connected] one exact-deficit HTTP request, no SQLite transaction open
  → one synchronous transaction persisting the strict server envelopes verbatim
  → authoritative re-read of grants from SQLite
  → the existing local-sale transaction, repeating every guard
```

Making completion async reopened a window main previously could not have: two `checkout:complete`
calls for one attempt could interleave across the await. `SaleCompletionService` therefore holds one
in-flight operation per attempt key, restoring "one top-up request, one sale attempt, at most one
invoice" in main rather than relying on the renderer's (still present) guard.

## Fail-closed classification

| Observation | Result | Terminal? |
|---|---|---|
| Coverage already sufficient | no request; normal completion | — |
| Offline / no allocation capability / request preconditions unmet | no request; existing `stock-allocation-unavailable` with affected line IDs | yes (T3) |
| Backend 403 | `permission-denied` | no |
| Backend 401 | `policy-blocked` | no |
| Backend 422 naming `device` | `workstation-unassigned` | no |
| Backend 422 otherwise | `refresh-required` | no |
| Commercial/licence denial | `context-changed` | no |
| Transport failure, 429/5xx, 409 conflict, malformed body, stale revision, foreign envelope, failed atomic persist | `allocation-acquisition-unresolved` | no |
| Grant persisted but coverage still short | `stock-allocation-unavailable` | yes (T3) |

`allocation-acquisition-unresolved` is the one new failure code. It is non-terminal by design: any
outcome whose server-side effect cannot be established must leave the attempt `claimed` so the retry
replays the identical key, rather than being rejected into a fresh key that could double-reserve
stock. Definitive authority denials keep their real reason instead of collapsing into a stock
message. No raw backend message, payload, or identifier reaches the renderer.

## Persistence

`StockAllocationRepository.ingestTopUpGrants()` writes verbatim server envelopes in the caller's
single transaction. A top-up is an **incremental** issue, not a snapshot, so the grants join the
current bootstrap revision and the capability revision is deliberately **not** advanced — advancing
it would mark every previously bootstrapped grant as omitted from the current snapshot and silently
strip its sale authority. Replay of an identical grant is idempotent; the same immutable identity
with different content, a lifecycle rollback, or a duplicate identity rolls the whole set back.
Server lifecycle status is preserved exactly and never normalized to `active`.

## Files changed (desktop only)

- `src/shared/constants/apiRoutes.ts` — the existing authenticated top-up route.
- `src/main/http/desktopResources.contract.ts` (+ test) — strict top-up data/meta schemas reusing
  the one allocation envelope contract bootstrap already enforces.
- `src/main/services/allocationDeficit.ts` (+ test) — pure exact-deficit calculation, backend
  bounds, deterministic ordering, derived idempotency key.
- `src/main/services/allocationAcquisition.service.ts` (+ test) — the production caller: strict
  validation, atomic persistence, authoritative re-read, failure classification, diagnostics.
- `src/main/services/saleCompletion.service.ts` (+ test) — ordering and per-attempt single flight.
- `src/main/services/localSale.service.ts` — `prepare`/`run` split, `trackedDemand()`, new code.
- `src/main/services/stockAllocation.service.ts` — `usableRemainingMilli()`.
- `src/main/repositories/stockAllocation.repository.ts` — `ingestTopUpGrants()`, `diagnostics()`.
- `src/main/services/catalogRefresh.service.ts`, `src/shared/contracts/catalog.contract.ts` —
  optional sanitized refresh diagnostics.
- `src/main/ipc/checkout.ipc.ts` (+ test), `src/main/app/applicationServices.ts` — wiring.
- `src/shared/contracts/checkout.contract.ts`, `src/renderer/src/i18n/locales/{en,ar}.json` — the
  new failure code and its cashier-facing message.
- Tests: `tests/electron/suites/stockAllocationTopUp.suite.ts`,
  `tests/electron/support/allocationTopUp.ts`, `tests/electron/support/localSaleFixture.ts`
  (unique local consumption UUIDs), `src/preload/posApiSurface.test.ts`,
  `src/renderer/src/modules/pos/payment.store.test.ts`, `src/renderer/src/i18n/i18n.test.ts`.

No renderer completion/recovery behaviour was rewritten: the loading-state fix, affected-product
display, localized rejection messages, and refresh action are unchanged.

## Verification run in this checkpoint

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS — exit 0, no errors, no warnings |
| `npm run test` | PASS — 90 files, 726 tests |
| `npm run verify:fixture` | PASS — 4 artifacts byte-identical |
| `npm run smoke:database` | PASS |
| `npm run test:sqlite:electron` | PASS — 160 tests (was 134) |
| `npm run build` | PASS |
| `git diff --check` | PASS |
| `php artisan test --filter=DesktopStockAllocationApiTest` | PASS — 11 tests, 86 assertions |
| `php artisan test --filter=StockAllocation` | PASS — 14 tests, 13 passed, 93 assertions, 1 skipped |
| `vendor/bin/pint --dirty` | PASS |
| backend `git diff --check` | PASS |

The single skipped backend test is the pre-existing `StockAllocationMySqlConcurrencyTest`, which
`markTestSkipped`s itself unless run explicitly against the disposable BE-3F-5 MySQL database. It
was skipped identically before this checkpoint.

No backend file was modified. Manual GUI smoke was not run.

## Manual smoke checklist (NOT RUN — documented for an operator)

1. Start from the current development state with zero rows in `stock_allocations`.
2. Connect Laravel; sign in as the correctly assigned cashier on the bound device.
3. Open or confirm the authoritative open shift.
4. Add Cola Can and complete payment once.
5. Confirm exactly one `POST /api/v1/desktop/stock-allocations/top-up`.
6. Confirm the response is successful and contains a valid grant.
7. Confirm `stock_allocations` becomes one row and `allocation_reserved_quantity` rises by exactly
   the granted amount.
8. Confirm Electron persists the grant and the local sale commits once.
9. Confirm the local receipt is displayed and "Completing sale…" clears.
10. Confirm a second click creates neither another allocation nor another invoice.
11. Disconnect Laravel, ring a different tracked product with no grant, and confirm the fail-closed
    rejection naming the affected product.
12. Confirm Service Item remains sellable with no allocation call.

Neither MySQL nor SQLite may be edited to make this checklist pass.

## Final state

```text
Desktop top-up production caller: PASS
Exact-deficit calculation: PASS
Strict Laravel contract parity: PASS
Replay-stable idempotency: PASS
Lost-response recovery: PASS
Crash-before-persistence recovery: PASS
Atomic local grant persistence: PASS
Post-persistence authoritative revalidation: PASS
Existing-grant offline behavior: PASS
No-grant offline zero-write behavior: PASS
D2-B preserved: PASS
Existing completion fixes preserved: PASS
Renderer security boundary preserved: PASS
Backend production code modified: NO
Manual GUI smoke: NOT RUN
Phase 3G implementation: NOT STARTED
Production activation: NOT AUTHORIZED
Backend staged/committed/pushed: NO
Desktop staged/committed/pushed: NO
```
