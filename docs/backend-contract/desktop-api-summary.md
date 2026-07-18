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
- Device-bound authentication implemented; consumed end-to-end by this app in Phase 2 (see
  [auth-device-contract.md](auth-device-contract.md)).
- Bootstrap implemented; consumed end-to-end by this app in Phase 2 (full shape confirmed, see
  [bootstrap-license-contract.md](bootstrap-license-contract.md)).
- Invoice/refund upload implemented (not yet consumed — Phase 4+).
- Shift/cash-drawer APIs implemented (not yet consumed — Phase 3+).
- License validation implemented; consumed end-to-end by this app in Phase 2 (one-shot manual
  validate only — no timers yet, see [bootstrap-license-contract.md](bootstrap-license-contract.md)).

## Route Namespaces

| Namespace | Audience | Allowed for this app? |
|---|---|---|
| `/api/v1/desktop/*` | Desktop/company app | Yes — only namespace this app may call |
| `/api/v1/admin/*` | Platform super-admin | **Never** |
| `/api/v1/auth/*` | Platform/browser authentication | **Never** |

## Endpoints Known By Name

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /api/v1/desktop/device/register` | Public | Device registration |
| `POST /api/v1/desktop/auth/login` | Public | Login |
| `GET /api/v1/desktop/auth/me` | Protected | Current session/user |
| `POST /api/v1/desktop/auth/logout` | Protected | End session |
| `GET /api/v1/desktop/bootstrap` | Protected | Initial/refresh data snapshot — full shape confirmed from Laravel source during Phase 2, see [bootstrap-license-contract.md](bootstrap-license-contract.md) |
| `POST /api/v1/desktop/device/heartbeat` | Protected | Liveness/connectivity check (exact payload/response `TODO` — not called until a later phase's heartbeat timer) |
| `POST /api/v1/desktop/license/validate` | Protected | License/subscription check — confirmed shape, see [bootstrap-license-contract.md](bootstrap-license-contract.md) |
| `POST /api/v1/desktop/invoices/upload` | Protected | Upload a completed local sale/invoice |
| `POST /api/v1/desktop/refunds/upload` | Protected | Upload a refund (must follow its invoice — see sync contract) |
| Shift endpoints | Protected | Open/pause/resume/close shift — exact route names `TODO` |
| Cash drawer endpoints | Protected | Cash movements/counts — exact route names `TODO` |
| Catalog / customer / payment / tax / inventory / accounting / report endpoints | Protected | Exist per backend status; exact routes/shapes `TODO` until OpenAPI import |

Total route count (174) and full route list are backend-side facts not enumerated here — import
the OpenAPI spec rather than hand-transcribing routes as they're needed.

## License and Entitlement Cadence

When online, license validation is required at application start, after login, and at least every
12 hours. Entitlements refresh at application start, after login, after a 403 response, and at
least every 15 minutes. After 72 hours offline without a successful license check, the backend's
license decision controls `canSell` and `canSync`; the app must surface that decision rather than
guess it locally. No foundation-phase timer is started from this documentation.

## Protected Request Headers

```http
Authorization: Bearer <desktop_token>
X-Device-UUID: <device_uuid>
```

Required on every endpoint except the two public ones listed above.

## Next Step to Remove `TODO`s

Resolve the documented [OpenAPI import blocker](openapi-import-blocker.md), validate the upstream
OpenAPI 3.1 document, then import it into this repository (location/process not yet decided —
likely `docs/backend-contract/openapi/` plus a generated-types step). Replace the `TODO` markers
above with confirmed shapes only after that step. Do not hand-guess a request/response shape in
application code before that happens — use the `TODO` marker convention from
[.ai/guidelines/backend-api-contract.md](../../.ai/guidelines/backend-api-contract.md).
