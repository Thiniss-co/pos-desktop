# Bootstrap / License Contract

Confirmed against the actual Laravel backend source (`pos-backend`) during Phase 2
implementation — request/response shapes below are transcribed from the real Form Requests and
API Resources, not the (still-blocked) OpenAPI draft.

## `POST /api/v1/desktop/license/validate`

Protected (`desktop.context:context`). Empty request body.

Response (`LicenseResource`):

```
token       string   (signed HS256 JWT, server secret — this app does NOT locally verify the
                       signature or trust decoded claims; it stores the JWT encrypted at rest
                       in secure_secrets under key desktop_license_jwt and never returns it to
                       the renderer)
expires_at  ISO8601 string
access      { is_active, is_trial, is_in_grace, is_expired, is_suspended, can_login, can_sell,
              can_sync, can_activate_device, restriction_level, warning_message? }
```

This app's `LicenseService.validate()` (`src/main/services/license.service.ts`) builds a sanitized
`LicenseStatus` (`src/shared/contracts/license.contract.ts`) from the `access` object plus
`expires_at`, and persists it to `license_state_metadata` (main-owned, non-secret). Phase 2 is a
**one-shot manual validate only** — no 12-hour/72-hour timers are started here (see
[../phases/02-activation-login-bootstrap.md](../phases/02-activation-login-bootstrap.md)).

## `GET /api/v1/desktop/bootstrap`

Protected (`desktop.context:sync`, i.e. requires `can_sync`). Phase 2 always requests a full
snapshot (no `since` cursor — incremental sync is deferred to a later phase).

### Allocation payload-format negotiation (BH-04B-3)

This app always requests `?allocation_payload_version=2` (see
`DESKTOP_API_ROUTES.bootstrap` in `src/shared/constants/apiRoutes.ts`, and
`allocation_payload_version: 2` on the top-up body in
`src/main/services/allocationDeficit.ts`). This is **payload-format negotiation only** — it is
never authorization, never proof this client is safe, and never permission to release stock. A
backend that does not recognize the field ignores it and answers in the legacy shape below, which
this app still parses correctly; only then does spendability stay in the conservative
`server_consumed_quantity_milli = 0` mode instead of the exact §3.1 boundary, because an absent
boundary must never be read as a verified zero one.

Response (`DesktopBootstrapResource`) top-level shape:

```
server_time    ISO8601 string
company        { id, name, is_active }
device         { id, device_uuid, device_name, platform, status?, last_seen_at?,
                  last_license_validated_at? }
license        { is_active, is_trial, is_in_grace, is_expired, is_suspended, can_login,
                  can_sell, can_sync, can_activate_device, restriction_level, warning_message? }
subscription   { plan_code, plan_name, status, billing_cycle, starts_at, renews_at, expires_at,
                  grace_ends_at } | null
features       { <PlanFeatureCode>: bool }
limits         { <limitKey>: int | null }
permissions    string[]
role           { name }
loyalty        { enabled, earn_enabled, redeem_enabled, points_per_amount, amount_per_point,
                  minimum_redeem_points, maximum_redeem_percent, points_expire_after_days,
                  points_activate_after_days, allow_partial_redemption } | null
branch         { id, name, is_active } | null
warehouse      { id, name, is_active } | null
sync           { snapshot_version, full_sync_required, entities: { <name>: { count,
                  last_changed_at } } }
stock_allocations         StockAllocationResource[] — device-bound allocation envelopes the
                  server currently holds for this device (read-only here; bootstrap never grants,
                  seals, or releases). Absent on a backend predating the allocation contract. Under
                  the opted-in representation (see above), each envelope carries three additional
                  keys: accepted_consumption_sequence, accepted_consumed_quantity_milli,
                  accepted_chain_hash — the BH-04A §3.1 coverage boundary this device has proven for
                  that allocation. 21 keys under the legacy representation, 24 under the opted-in one.
stock_allocation_revision int — the device's latest allocation lifecycle-audit id
stock_allocation_terminal_markers  { id, status, lifecycle_generation, terminal_revision }[] —
                  present ONLY under the opted-in representation. `id` is the allocation uuid, the
                  same value a live envelope publishes as its own `id`. Its absence (legacy
                  representation) means "this response says nothing about terminal allocations",
                  never "there are none" — the two are handled differently by
                  `bootstrapSnapshot.repository.ts`.
categories, products, product_barcodes, product_prices, stock_items, taxes,
payment_methods, customers   — arrays, present when requested (Phase 2 requests all)
```

`stock_items` rows also carry `allocation_reserved_quantity` (the slice of `reserved_quantity`
held by allocation envelopes). It is parsed but not persisted locally yet — `available_quantity`
remains the sellable figure the local snapshot stores.

Full field-level entity shapes are transcribed in
`src/main/http/desktopResources.contract.ts` (main-process-only — this file is intentionally not
shared with the renderer since it carries backend-internal id conventions).

### Id conventions (load-bearing)

- Most public ids are the model's `uuid` column. **Exceptions:** `AuthUserResource.id` is an
  integer PK (+ separate `uuid`); `products` use `uuid` (not `id`) plus integer `server_id`,
  `company_id`, `category_id`; foreign keys inside collection resources (`product_id`,
  `warehouse_id`, `category_id`) are **integer server PKs**, not UUIDs.
- Money (`product_prices.amount`) is an **integer minor unit**. Quantities (`stock_items.*`) are
  JSON floats from the backend; this app persists them as fixed 3-decimal TEXT locally.

### Sync semantics

- Full bootstrap (no `since`) returns only `is_active = true` rows by default.
- There is no hard-delete tombstone table — deactivation is represented by `is_active = false`
  rows appearing in a future incremental (`since`-based) sync. Phase 2 does not implement
  incremental sync; the local schema keeps `is_active` columns so that behavior can be added later
  without a schema change.
- `sync.snapshot_version` is a derived display string (`YmdHis`), not an opaque cursor — future
  incremental sync should drive off a `since` timestamp, not this field.

### Local persistence

`src/main/repositories/bootstrapSnapshot.repository.ts` persists the entire response as one
atomic `database.transaction(...)` (full delete-and-replace per table — Phase 2 does not need
incremental upsert). `bootstrap_state.is_complete` is set only after that transaction commits; a
failure anywhere in the transaction rolls back automatically and leaves the previous snapshot (and
`is_complete` flag) untouched. See migration `0002_activation_auth_bootstrap`.

### Allocation coverage and terminal markers (BH-04B-3)

Applied inside the same bootstrap transaction, via `AllocationReconciliationService`
(`src/main/services/allocationReconciliation.service.ts`): every envelope's coverage triple is
validated against this device's own immutable local journal evidence before being accepted (never
trusted as-is), and every terminal marker is written durably and permanently — an older active
envelope, omission from a later list, or a process restart can never undo one. See
[local-database-architecture.md](../architecture/local-database-architecture.md) for the schema
this reconciliation reads and writes (`stock_allocation_coverage_boundaries`,
`stock_allocation_terminal_markers`, `stock_allocation_holds`) and migration `0009`.
