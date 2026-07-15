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
| `DESKTOP_TOKEN_DEVICE_MISMATCH` | Auth | Token bound to a different device than `X-Device-UUID` — force logout on this device |
| `DESKTOP_CONTEXT_REQUIRED` | Auth/request shape | Required desktop context (likely a header) missing from the request — client bug if seen, since the central client should always attach it |
| `DESKTOP_ACCESS_FORBIDDEN` | Authorization | Authenticated, but desktop access itself is forbidden for this account |
| `IDEMPOTENCY_CONFLICT` | Sync | Idempotency key reused with a different payload — quarantine (`conflict` state), do not auto-retry |
| `SHIFT_ALREADY_OPEN` | Shift state | Attempted to open a shift while one is already open — reconcile local shift state with backend |
| `SHIFT_NOT_OPEN` | Shift state | Attempted an action requiring an open shift when none is open |
| `SHIFT_CLOSED` | Shift state | Attempted an action on a shift that's already closed |
| `SHIFT_PAUSED` | Shift state | Attempted an action blocked while the shift is paused |
| `SHIFT_NOT_PAUSED` | Shift state | Attempted to resume/act-as-paused on a shift that isn't paused |
| `VALIDATION_FAILED` | Request shape | Check `errors` for field-level detail; surface next to the relevant form field |
| `ROUTE_NOT_FOUND` | Request shape | Client called a route that doesn't exist — treat as a client bug (wrong URL/method), not a user-facing recoverable state |

## Handling Principle

Branch on `code`, never on `message` (message text may change/be localized). Codes not in this
table should be handled by a generic fallback (show `message`, log `code` + `trace_id`) rather than
silently swallowed — and this table should be extended as new codes are confirmed, not guessed at.
