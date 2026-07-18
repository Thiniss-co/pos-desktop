# Auth / Device Contract

Confirmed against the actual Laravel backend source (`pos-backend`: routes, Form Requests, API
Resources, `ResolveDesktopDeviceContext` middleware) during Phase 2 implementation. Field names
below are load-bearing — they match the backend exactly, not a guess from the OpenAPI draft.

## Device-Bound Authentication Model

Each installation of this desktop app is bound to a specific device identity (`device_uuid`, a
client-generated UUID persisted in `device_identity` from Phase 1 and never regenerated).
Authentication is a two-step process:

1. **Device registration** (`POST /api/v1/desktop/device/register`, public, rate-limited via
   `throttle:desktop-activation`) — registers this installation with the backend. Re-registering
   the same `device_uuid` is idempotent (updates details rather than erroring), so device
   reinstall/factory-reset is not a distinct backend flow — the same `device_uuid` is simply
   re-submitted.
2. **Login** (`POST /api/v1/desktop/auth/login`, public, rate-limited via `throttle:desktop-auth`)
   — authenticates a user/cashier on an already-registered device, returning a Sanctum
   `token` (ability `desktop`) bound to that device.

### Device fingerprint

The backend requires an opaque `fingerprint_hash` string (`max:255`) on registration but never
verifies or matches on it server-side — it is stored as-is on the device row. True device identity
everywhere else is `device_uuid`. This app computes `fingerprint_hash = sha256(device_uuid)` in the
main process (see `src/main/services/activation.service.ts`) — deterministic, no hardware/MAC
identifiers.

### `POST /device/register` request (`RegisterDeviceRequest`)

```
company_code     required string
activation_code  required string   (never persisted or logged)
device_uuid      required uuid     (main-owned, never renderer-provided)
device_name      required string
fingerprint_hash required string   (main-owned, see above)
platform         required string
os_version       optional string
app_version      optional string
```

### `POST /device/register` response (`DeviceResource`)

```
id, device_uuid, device_name, platform, os_version?, app_version?, status,
last_seen_at?, last_license_validated_at?, blocked_at?, blocked_reason?, revoked_at?,
created_at, updated_at
```

`company`/`branch`/`warehouse` are **not** included on this response (not eager-loaded on
registration).

### `POST /auth/login` request (`DesktopLoginRequest`)

```
email        required email
password     required string   (never persisted or logged)
device_uuid  required uuid     (main-owned; sent as X-Device-UUID header or body field)
device_name  optional string   (Sanctum token name; defaults to "desktop-client")
```

### `POST /auth/login` response (`DesktopSessionResource`)

```
token          string   (Sanctop plainTextToken, ability "desktop" — encrypted at rest, never
                          returned to the renderer)
token_type     "Bearer"
abilities      string[]
user           { id, uuid, name, email, company_id?, is_active, roles[], permissions[] }
device         { id, device_uuid, device_name, platform, status?, last_seen_at?,
                  last_license_validated_at? }
company        { id, name, is_active } | null
branch         { id, name, is_active } | null
warehouse      { id, name, is_active } | null
access         { allowed, is_active, is_trial, is_in_grace, is_expired, is_suspended,
                  can_login, can_sell, can_sync, can_activate_device, restriction_level,
                  warning_message? }
```

## Required Headers on Every Protected Request

```http
Authorization: Bearer <desktop token>
X-Device-UUID: <device_uuid>
```

Both headers are required together — a valid token presented with the wrong (or missing) device
UUID is rejected (`DESKTOP_TOKEN_DEVICE_MISMATCH` / `DESKTOP_TOKEN_NOT_BOUND`).

## Session Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/desktop/auth/me` | Fetch current authenticated user/session details (`DesktopUserContextResource` — same as login minus `token`/`token_type`/`abilities`, `company` non-nullable) |
| `POST /api/v1/desktop/auth/logout` | Invalidate current session/token (revokes the binding and deletes the Sanctum token server-side) |

## Relevant Error Codes

See [error-codes.md](error-codes.md) for full descriptions. The full backend `ApiErrorCode` enum
(from `app/Shared/Http/Responses/ApiErrorCode.php`) is now reflected exactly in
`src/shared/constants/apiErrorCodes.ts`.

| Code | Meaning for auth flow |
|---|---|
| `UNAUTHENTICATED` | No valid session — route to login |
| `INVALID_CREDENTIALS` | Bad email/password on login, or bad company/activation code on register |
| `USER_INACTIVE` | User account is deactivated |
| `DESKTOP_LOGIN_FORBIDDEN` | Login itself is blocked (account/device not allowed to log in here) |
| `DESKTOP_TOKEN_NOT_BOUND` | Token isn't bound to any device — re-register/re-login |
| `DESKTOP_TOKEN_DEVICE_MISMATCH` | Token bound to a *different* device than `X-Device-UUID` |
| `DESKTOP_CONTEXT_REQUIRED` | Request missing required desktop context |
| `DESKTOP_ACCESS_FORBIDDEN` | Authenticated, but not permitted for desktop access generally |
| `FORBIDDEN` / `PERMISSION_DENIED` / `FEATURE_PERMISSION_DENIED` | Authenticated but lacking permission for the specific action/feature |
| `VALIDATION_ERROR` | Field-level validation failure (see `errors` in the envelope) |
| `TOO_MANY_REQUESTS` | Rate-limited by `throttle:desktop-activation` / `throttle:desktop-auth` |

## Token Storage Rule (frontend)

The desktop token is never stored in renderer-accessible storage (`localStorage`, `sessionStorage`,
cookies). It is encrypted via `safeStorage` and held in the `secure_secrets` SQLite table
(key `desktop_access_token`), attached to outbound requests by `DesktopApiClient` in the main
process, and never returned to the renderer in raw form — see
[.ai/guidelines/electron-security.md](../../.ai/guidelines/electron-security.md) and
[.ai/guidelines/backend-api-contract.md](../../.ai/guidelines/backend-api-contract.md).

## Remaining Unknowns (`TODO`)

- Token expiry/refresh behavior beyond Sanctum's default (no refresh-token flow observed in the
  Devices/Identity modules as of Phase 2; re-login is the only path back if a token is revoked or
  device-mismatched).
- Any backend-side re-registration triggers beyond idempotent `device_uuid` reuse (e.g. an explicit
  factory-reset endpoint) were not found and are assumed not to exist for the desktop namespace.
