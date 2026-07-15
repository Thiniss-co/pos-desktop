# API Integration Architecture

Rules: [.ai/guidelines/backend-api-contract.md](../../.ai/guidelines/backend-api-contract.md).
Not implemented yet — target design for Phase 2+.

## Where the API Client Lives

The central API client runs in the **main process** (not the renderer) — it needs to attach the
securely-stored desktop token and device UUID without ever handing them to the renderer, and it
needs to keep working (queuing/retrying) independent of any window being open.

```mermaid
flowchart LR
    subgraph Renderer
        Svc["module service.ts"]
    end
    subgraph Main
        PosApiHandler["IPC handler"]
        Client["shared/api/client.ts\n(central API client)"]
        Token["Secure token store"]
    end
    Backend[("Laravel Backend")]

    Svc -->|"posApi.auth.login(payload)"| PosApiHandler
    PosApiHandler --> Client
    Client --> Token
    Client -->|"Authorization + X-Device-UUID"| Backend
```

Renderer-side "services" (per `.ai/guidelines/vue-structure.md`) call `window.posApi`, which
already resolves to parsed, envelope-checked, error-normalized data — they are thin wrappers, not
where HTTP happens.

## Client Responsibilities

1. Attach `Authorization: Bearer <desktop_token>` + `X-Device-UUID: <device_uuid>` to every
   protected request; skip for the two public endpoints
   (`device/register`, `auth/login`).
2. Parse every response against the success/error envelope
   (`docs/backend-contract/response-envelope.md`).
3. Normalize errors to `{ code, message, errors?, traceId? }` for IPC handlers to return.
4. Restrict all calls to `/api/v1/desktop/*` — never `/api/v1/admin/*`.

## Request Flow (example: bootstrap fetch)

```mermaid
sequenceDiagram
    participant R as Renderer service
    participant H as IPC handler
    participant C as API Client
    participant B as Backend

    R->>H: posApi.bootstrap.refresh()
    H->>C: client.get('/api/v1/desktop/bootstrap')
    C->>B: GET + auth headers
    B-->>C: 200 { success: true, data: {...}, meta: {...} }
    C->>C: parse envelope, validate shape
    C-->>H: { ok: true, data }
    H-->>R: BootstrapSnapshot
```

On error:

```mermaid
sequenceDiagram
    participant R as Renderer service
    participant H as IPC handler
    participant C as API Client
    participant B as Backend

    R->>H: posApi.auth.login(payload)
    H->>C: client.post('/api/v1/desktop/auth/login', payload)
    B-->>C: 401 { success: false, code: 'UNAUTHENTICATED', message, meta: { trace_id } }
    C-->>H: { ok: false, code: 'UNAUTHENTICATED', message, traceId }
    H-->>R: rejected promise with normalized error
    R->>R: auth store shows login error, keeps trace_id for support
```

## OpenAPI Adoption Path

Once the desktop OpenAPI spec is imported into this repo (location TBD — likely
`docs/backend-contract/openapi/` or a generated-types package), request/response TypeScript types
should be generated from it rather than hand-maintained, to avoid drift from the backend's actual
contract. Until then, hand-written types in this repo are marked `TODO: confirm against OpenAPI`
wherever the exact shape isn't given directly in
[docs/backend-contract/](../backend-contract/desktop-api-summary.md).
