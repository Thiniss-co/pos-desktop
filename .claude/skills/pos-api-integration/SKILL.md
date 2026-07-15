---
name: pos-api-integration
description: Build or modify the central API client, response envelope parsing, auth headers, and error handling for the pos-desktop app's backend integration.
---

# POS API Integration

## When to Use

- Adding a new backend endpoint call.
- Modifying the central API client (`shared/api/client.ts`).
- Handling a new backend error `code`.
- Importing/wiring the OpenAPI-generated types/client once available.

## Rules

Full detail: `.ai/guidelines/backend-api-contract.md`.

- Only `/api/v1/desktop/*` may ever be called. `/api/v1/admin/*` is forbidden, full stop.
- Exactly one central API client. No `fetch`/`axios` inside components, pages, or stores directly.
- Every protected request carries `Authorization: Bearer <desktop_token>` and
  `X-Device-UUID: <device_uuid>`, attached by the client — never set manually per call.
- Every response is parsed against the success/error envelope before use; branch on `code`, never
  on `message`.
- Unknown/undocumented endpoint or field: mark `TODO: confirm against OpenAPI` rather than
  guessing the shape.

## Steps

1. Read `.ai/guidelines/backend-api-contract.md` and check `docs/backend-contract/` for the
   endpoint's documented shape (or its `TODO` marker).
2. Add the call to the central client (or a module `service.ts` that uses the client) — never a
   one-off `fetch`.
3. Handle the specific error codes relevant to this endpoint explicitly (see the code list in
   `backend-api-contract.md`); let genuinely unexpected codes fall through to a generic handler,
   not a silent no-op.
4. If this is the first call for a new endpoint, add/update its entry in
   `docs/backend-contract/desktop-api-summary.md`.

## Verification

- `npm run typecheck`, `npm run lint`.
- Confirm in DevTools Network tab that the request goes to `/api/v1/desktop/*` with both required
  headers present, and that `/api/v1/admin/*` is never hit.
- Envelope-parsing unit test once a test runner exists (`testing-and-verification.md`).

## Common Mistakes

- Calling `fetch` directly from a component "just this once."
- Branching on HTTP status or `message` text instead of the `code` field.
- Hardcoding a token or the API base URL instead of reading from configured auth/env state.
- Assuming an endpoint's response shape without checking `docs/backend-contract/` or marking it
  `TODO`.
