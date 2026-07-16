# Backend API Contract Rules

Authoritative narrative summary lives in `docs/backend-contract/`; this file states the rules to
enforce in code.

## Desktop Routes Only

- The only backend namespace this app may call is `/api/v1/desktop/*`.
- `/api/v1/admin/*` and `/api/v1/auth/*` are different application namespaces. They must never be
  called by this app; only their desktop-scoped counterparts under `/api/v1/desktop/*` are valid.
- If a feature seems to need admin-only data, that is a signal the desktop contract is missing an
  endpoint — flag it (see `docs/backend-contract/desktop-api-summary.md` TODOs), do not reach for
  the admin route.

## Desktop Auth Headers

Every protected request carries both:

```http
Authorization: Bearer <desktop_token>
X-Device-UUID: <device_uuid>
```

Public (unauthenticated) endpoints — currently only:

- `POST /api/v1/desktop/device/register`
- `POST /api/v1/desktop/auth/login`

All other desktop endpoints are protected and require both headers above. The central API client
attaches them automatically; individual services/components never set auth headers manually.

## Response Envelope

Success:

```json
{ "success": true, "message": "string", "code": "STRING_CODE", "data": {}, "meta": {} }
```

Error:

```json
{
  "success": false,
  "message": "string",
  "code": "ERROR_CODE",
  "errors": {},
  "meta": { "trace_id": "..." }
}
```

- The central API client parses **every** response against this envelope shape before returning
  data to a service. A response that doesn't match the envelope is treated as a transport error,
  not silently passed through.
- `code` (not HTTP status alone, and not `message`) drives branching logic — `message` is for
  display only and must never be parsed/matched against in code.
- Known error codes to handle explicitly where relevant: `UNAUTHENTICATED`, `FORBIDDEN`,
  `FEATURE_NOT_ENABLED`, `PERMISSION_DENIED`, `FEATURE_PERMISSION_DENIED`,
  `DESKTOP_LOGIN_FORBIDDEN`, `DESKTOP_TOKEN_NOT_BOUND`, `DESKTOP_TOKEN_DEVICE_MISMATCH`,
  `DESKTOP_CONTEXT_REQUIRED`, `DESKTOP_ACCESS_FORBIDDEN`, `IDEMPOTENCY_CONFLICT`,
  `SHIFT_ALREADY_OPEN`, `SHIFT_NOT_OPEN`, `SHIFT_CLOSED`, `SHIFT_PAUSED`, `SHIFT_NOT_PAUSED`,
  `VALIDATION_FAILED`, `ROUTE_NOT_FOUND`. Full descriptions:
  `docs/backend-contract/error-codes.md`.

## Error Handling

- `errors` (validation field errors) surface next to the relevant form field, not as a generic
  toast, when the code is `VALIDATION_FAILED`.
- Auth-shaped errors (`UNAUTHENTICATED`, `DESKTOP_TOKEN_NOT_BOUND`,
  `DESKTOP_TOKEN_DEVICE_MISMATCH`) trigger the auth store's logout/re-auth flow, not an ad hoc
  handler in the calling component.
- `trace_id` from `meta` is retained in memory/logs for the current operation and shown in
  diagnostic/support UI (e.g. "copy error details"), never silently dropped.

## Central API Client Only

- Exactly one HTTP client module (`shared/api/client.ts`) wraps `fetch`. No component, page, store,
  or ad hoc service creates its own HTTP call.
- The client is responsible for: base URL, auth headers, envelope parsing, error normalization,
  and (later) offline-queue integration for write requests.

## No `fetch` in Components

Enforced by code review / lint intent, not just convention: a `.vue` file importing `fetch` or an
HTTP library directly is a bug.

## OpenAPI Generated Client Preferred

The backend publishes an OpenAPI foundation for the desktop contract. When available/imported,
prefer generating request/response types (and ideally the client) from it over hand-writing types,
to avoid drift. Until the OpenAPI file is imported into this repo, mark any assumed
request/response shape as `TODO: confirm against OpenAPI` rather than guessing.
