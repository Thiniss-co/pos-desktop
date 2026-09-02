# CP-5c — Bootstrap allocation ingestion and workstation-assignment diagnosis

Date: 2026-08-30

Scope: Phase 3F only. This checkpoint makes bootstrap allocation envelopes durable in the Electron
main-process database and replaces the misleading generic closed-shift checkout result with the
actual main-owned denial reason. It does not add an allocation release path, upload worker, Phase
3G work, backend business behaviour, deployment, staging, commits, or pushes.

## Proven live cause

The inspected workstation database had a session-owned `shift_observation` with `status = open`
and matching active company, device, user, and session epoch. Its persisted bootstrap context had
no `bootstrap_branch` and no `bootstrap_warehouse` row. Completion therefore correctly had no
safe attribution tuple, but previously surfaced the generic shift wording.

The precise completion result is now `workstation-unassigned`; it means the backend desktop-device
assignment must contain both a branch and warehouse, followed by **Refresh workstation data**. It
does not mean the confirmed shift is closed. The check remains fail-closed and creates neither a
sale attempt nor an invoice.

## Contract and persistence

- The strict bootstrap schema enumerates all fields emitted by Laravel's
  `StockAllocationResource`, rejects unknown allocation fields, and requires
  `stock_allocations` and `stock_allocation_revision` as an all-or-nothing capability pair.
- Migration `0008_bootstrap_stock_allocations` is forward-only. It retains the original local
  status evidence, adds exact server lifecycle/projection columns, and adds the singleton
  allocation capability/revision table. No prior migration was changed.
- Bootstrap persists the catalog, allocation capability/revision, and grants in the same SQLite
  transaction. Foreign/unknown owner, product, or stock-item relationships; duplicate IDs;
  lifecycle/revision rollback; and an equal revision with conflicting content all reject.
- `active`, `revocation_pending`, `seal_acknowledged`, `released`, and `consumed` are retained
  verbatim. Only a current-snapshot, server-`active`, unconsumed grant can authorize tracked
  stock. A later full snapshot omitting a grant retains its evidence but makes it unusable.
- Remaining allocation is server remaining quantity minus only local **pending** consumption. The
  stock-item allocation-reserved projection is not sale authority, so there is no double
  subtraction against shared stock.
- An older backend that omits both allocation keys is recorded as capability unavailable. It may
  retain historic evidence but cannot authorize a tracked sale; the precise result is
  `allocation-data-unavailable`.

## Shift authority and refresh

`CatalogRefreshService` now performs its main-owned sequence in this order:

```text
validate license → restore session/device/company context → strict bootstrap + atomic persistence
→ shifts/current reconciliation → publish access → re-read catalog readiness
```

The final `shifts/current` reconciliation is after bootstrap, preventing a valid open observation
from being evaluated against stale pre-refresh context. `LocalSaleService` maps each non-open
authority arm to a distinct failure code and independently reports `workstation-unassigned` when
the shift is open but bootstrap has no device branch/warehouse assignment.

## Provenance and fixture checks

| Item | Result |
| --- | --- |
| Approved plan SHA-256 | `6f661d0a381878d0b05787266934128049ab866051ef28450f012e22a33983b8` |
| Claude-plan / approved-plan comparison | byte-identical |
| CP-5a raw fixture SHA-256, desktop and backend | `f7456f37f9bf08af7d579df756cf92520f09cfff46a54b6d3912d3e6de328406` |
| `npm run verify:fixture` | all four artifacts byte-identical and independently verified |

The backend CP-5a artifact exists at its approved fixture path; the earlier missing-fixture claim
was stale/wrong-path evidence. No fixture was copied or edited.

## Targeted files

- `src/main/http/desktopResources.contract.ts` and test: exact bootstrap allocation contract.
- `src/main/database/migrations/0008_bootstrap_stock_allocations.ts`: additive durable storage.
- `src/main/repositories/{bootstrapSnapshot,stockAllocation}.repository.ts`: atomic ingestion,
  capability handling, revision and identity enforcement.
- `src/main/services/{stockAllocation,localSale,catalogRefresh}.service.ts`: no-fallback tracked
  allocation enforcement, precise denial mapping, and final shift reconciliation.
- `src/shared/contracts/{sale,checkout}.contract.ts` and locale files: exact typed result surface
  and cashier-visible messages.
- Electron SQLite and service tests: strict parsing, lifecycle retention, restart, omission,
  rollback, absent capability, refresh order, and the open-shift/unassigned-workstation regression.

## Verification run in this checkpoint

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run test` | PASS — 87 files, 661 tests |
| `npm run test:sqlite:electron` | PASS — 133 tests |
| `npm run verify:fixture` | PASS — 4 artifacts |
| `npm run smoke:database` | PASS |
| `npm run build` | PASS |
| `git diff --check` | PASS |
| `npm run lint` | exit 0; one existing Prettier warning in `PosPage.vue:425` (not changed for this checkpoint) |

No backend files were modified. The backend-required generator/integrity gate for a permanent
Laravel-generated bootstrap fixture was not run: no such on-disk bootstrap fixture/generator is
present in the inspected backend worktree, and this desktop-only checkpoint did not alter that
repository. Manual GUI smoke was not run.

## Final state

```text
Strict bootstrap allocation contract: PASS
Permanent Laravel→Electron bootstrap fixture: BLOCKED
CP-5a/BE-3F-2B fixture parity reconciled: PASS
Atomic allocation ingestion: PASS
Server status preservation: PASS
Tracked-stock no-fallback enforcement: PASS
Open-shift authority after refresh: PASS
Session epoch stability: PASS
Shift failure reason mapping: PASS
Desktop full gate: PASS (lint exits 0 with one unrelated warning)
Backend required gate: BLOCKED
Manual GUI smoke: NOT RUN
Allocation release remains disabled: YES
Phase 3F CP-5b: PASS
Phase 3G: NOT STARTED
Production activation: NOT AUTHORIZED
Backend staged/committed/pushed: NO
Desktop staged/committed/pushed: NO
```
