# Desktop API Summary

Summarized from the backend's frozen desktop MVP contract as communicated to this repository.
This is a summary, not the source of truth — the backend's own OpenAPI publication is authoritative
once imported here. Anything not explicitly given below is marked `TODO`.

## Confirmed Backend State

- Laravel API backend, P0 desktop contract freeze complete.
- 531 backend tests passing, 174 API routes total.
- Architecture scans warning-free.
- Desktop API contract documented; OpenAPI foundation published (not yet imported into this repo —
  `TODO`).
- Offline sync contract documented (see [sync-contract-summary.md](sync-contract-summary.md)).
- Device-bound authentication implemented.
- Bootstrap implemented.
- Invoice/refund upload implemented.
- Shift/cash-drawer APIs implemented.
- License validation implemented.

## Route Namespaces

| Namespace | Audience | Allowed for this app? |
|---|---|---|
| `/api/v1/desktop/*` | Desktop/company app | Yes — only namespace this app may call |
| `/api/v1/admin/*` | Platform super-admin | **Never** |

## Endpoints Known By Name

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /api/v1/desktop/device/register` | Public | Device registration |
| `POST /api/v1/desktop/auth/login` | Public | Login |
| `GET /api/v1/desktop/auth/me` | Protected | Current session/user |
| `POST /api/v1/desktop/auth/logout` | Protected | End session |
| `GET /api/v1/desktop/bootstrap` | Protected | Initial/refresh data snapshot (catalog, tax, permissions, etc. — exact shape `TODO`) |
| `POST /api/v1/desktop/heartbeat` | Protected | Liveness/connectivity check (exact payload/response `TODO`) |
| `POST /api/v1/desktop/license/validate` | Protected | License/subscription check |
| `POST /api/v1/desktop/invoices/upload` | Protected | Upload a completed local sale/invoice |
| `POST /api/v1/desktop/refunds/upload` | Protected | Upload a refund (must follow its invoice — see sync contract) |
| Shift endpoints | Protected | Open/pause/resume/close shift — exact route names `TODO` |
| Cash drawer endpoints | Protected | Cash movements/counts — exact route names `TODO` |
| Catalog / customer / payment / tax / inventory / accounting / report endpoints | Protected | Exist per backend status; exact routes/shapes `TODO` until OpenAPI import |

Total route count (174) and full route list are backend-side facts not enumerated here — import
the OpenAPI spec rather than hand-transcribing routes as they're needed.

## Protected Request Headers

```http
Authorization: Bearer <desktop_token>
X-Device-UUID: <device_uuid>
```

Required on every endpoint except the two public ones listed above.

## Next Step to Remove `TODO`s

Import the published OpenAPI foundation into this repository (location/process not yet decided —
likely `docs/backend-contract/openapi/` plus a generated-types step) and replace the `TODO`
markers above with confirmed shapes. Do not hand-guess a request/response shape in application
code before that happens — use the `TODO` marker convention from
[.ai/guidelines/backend-api-contract.md](../../.ai/guidelines/backend-api-contract.md).
