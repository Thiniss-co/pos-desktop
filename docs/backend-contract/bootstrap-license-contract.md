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
                  seals, or releases). Absent on a backend predating the allocation contract.
stock_allocation_revision int — the device's latest allocation lifecycle-audit id
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
