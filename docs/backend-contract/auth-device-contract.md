# Auth / Device Contract

Summarized from the backend's device-bound authentication implementation. Exact request/response
field names are `TODO` until the OpenAPI spec is imported — this doc covers the confirmed flow and
headers.

## Device-Bound Authentication Model

Each installation of this desktop app is bound to a specific device identity (`device_uuid`).
Authentication is a two-step process:

1. **Device registration** (`POST /api/v1/desktop/device/register`, public) — registers this
   installation with the backend, establishing (or confirming) its `device_uuid`.
2. **Login** (`POST /api/v1/desktop/auth/login`, public) — authenticates a user/cashier on an
   already-registered device, returning a `desktop_token` bound to that device.

## Required Headers on Every Protected Request

```http
Authorization: Bearer <desktop_token>
X-Device-UUID: <device_uuid>
```

Both headers are required together — a valid token presented with the wrong (or missing) device
UUID is rejected (`DESKTOP_TOKEN_DEVICE_MISMATCH` / `DESKTOP_TOKEN_NOT_BOUND`).

## Session Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/desktop/auth/me` | Fetch current authenticated user/session details |
| `POST /api/v1/desktop/auth/logout` | Invalidate current session/token |

## Relevant Error Codes

See [error-codes.md](error-codes.md) for full descriptions.

| Code | Meaning for auth flow |
|---|---|
| `UNAUTHENTICATED` | No valid session — route to login |
| `DESKTOP_LOGIN_FORBIDDEN` | Login itself is blocked (e.g. account/device not allowed to log in here) |
| `DESKTOP_TOKEN_NOT_BOUND` | Token isn't bound to any device — re-register/re-login |
| `DESKTOP_TOKEN_DEVICE_MISMATCH` | Token bound to a *different* device than the one presenting `X-Device-UUID` |
| `DESKTOP_CONTEXT_REQUIRED` | Request missing required desktop context (likely a missing header) |
| `DESKTOP_ACCESS_FORBIDDEN` | Authenticated, but not permitted for desktop access generally |
| `FORBIDDEN` / `PERMISSION_DENIED` / `FEATURE_PERMISSION_DENIED` | Authenticated but lacking permission for the specific action/feature |

## Token Storage Rule (frontend)

`desktop_token` is never stored in renderer-accessible storage (`localStorage`, `sessionStorage`,
cookies). It is held in the main process (in memory and/or an OS-secured store), attached to
outbound requests by the central API client, and never returned to the renderer in raw form — see
[.ai/guidelines/electron-security.md](../../.ai/guidelines/electron-security.md) and
[.ai/guidelines/backend-api-contract.md](../../.ai/guidelines/backend-api-contract.md).

## Unknowns (`TODO`)

- Exact `login`/`device/register` request and response field names/shapes.
- Token expiry/refresh behavior (is there a refresh token, or re-login on expiry?).
- What triggers re-registration of a device (e.g. reinstall, factory reset) vs. reuse of an
  existing `device_uuid`.

Confirm against the OpenAPI import before implementing Phase 2 auth flows.
