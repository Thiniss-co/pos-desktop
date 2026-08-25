# Error Codes

Codes confirmed as important by the backend team, with their expected client-side handling. This
list is not exhaustive of all 174 routes' possible codes — extend it as new codes are encountered,
rather than guessing meaning for an unfamiliar code.

| Code | Category | Expected client handling |
|---|---|---|
| `UNAUTHENTICATED` | Auth | Clear local session, route to login |
| `FORBIDDEN` | Authorization | Generic "not allowed" — show message, do not retry |
| `FEATURE_NOT_ENABLED` | Licensing/tenant config | Feature is off for this tenant/license — hide/disable the feature rather than erroring repeatedly |
| `PERMISSION_DENIED` | Authorization | User lacks permission for this action |
| `FEATURE_PERMISSION_DENIED` | Authorization | User lacks permission for this specific feature (distinct from general `PERMISSION_DENIED`) |
| `DESKTOP_LOGIN_FORBIDDEN` | Auth | Login itself is blocked for this account/device combination |
| `DESKTOP_TOKEN_NOT_BOUND` | Auth | Token not bound to any device — re-register/re-login |
| `DESKTOP_TOKEN_DEVICE_MISMATCH` | Device recovery | Token bound to a different device than `X-Device-UUID` — route to activation while preserving the local device UUID and durable data |
| `DESKTOP_CONTEXT_REQUIRED` | Auth/request shape | Required desktop context (likely a header) missing from the request — client bug if seen, since the central client should always attach it |
| `DESKTOP_ACCESS_FORBIDDEN` | Authorization | Authenticated, but desktop access itself is forbidden for this account |
| `IDEMPOTENCY_CONFLICT` | Sync | Idempotency key reused with a different payload — preserve both payloads for `conflict` review, do not auto-retry |
| `DESKTOP_SHIFT_ALREADY_OPEN` | Shift state | Attempted to open a shift while one is already open — reconcile local shift state with backend |
| `DESKTOP_SHIFT_NOT_OPEN` | Shift state | Attempted an action requiring an open shift when none is open |
| `DESKTOP_SHIFT_ALREADY_PAUSED` | Shift state | Attempted to pause a shift that is already paused |
| `DESKTOP_SHIFT_NOT_PAUSED` | Shift state | Attempted to resume a shift that is not paused |
| `DESKTOP_SHIFT_ACTIVE_PAUSE_NOT_FOUND` | Shift state | The active pause record needed to resume a shift was unavailable |
| `DESKTOP_SHIFT_ACCESS_DENIED` | Authorization | The requested shift is outside the authenticated desktop context |
| `VALIDATION_FAILED` | Request shape | Check `errors` for field-level detail; stale price or stock 422s are terminal `rejected` records with staff recovery guidance |
| `ROUTE_NOT_FOUND` | Request shape | Client called a route that doesn't exist — treat as a client bug (wrong URL/method), not a user-facing recoverable state |

## Handling Principle

Branch on `code`, never on `message` (message text may change/be localized). Codes not in this
table should be handled by a generic fallback (show `message`, log `code` + `trace_id`) rather than
silently swallowed — and this table should be extended as new codes are confirmed, not guessed at.
