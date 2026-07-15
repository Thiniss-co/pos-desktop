# Response Envelope

Every backend response (success or error) follows this fixed shape. Full handling rules:
[.ai/guidelines/backend-api-contract.md](../../.ai/guidelines/backend-api-contract.md).

## Success

```json
{
  "success": true,
  "message": "string",
  "code": "STRING_CODE",
  "data": {},
  "meta": {}
}
```

| Field | Type | Use |
|---|---|---|
| `success` | `true` | Discriminant |
| `message` | string | Human-readable, display-only — never parsed/matched in code |
| `code` | string | Machine-readable success code — branch on this, not `message` |
| `data` | object | The actual payload; shape is endpoint-specific (`TODO` per endpoint until OpenAPI import) |
| `meta` | object | Pagination/context metadata; shape is endpoint-specific |

## Error

```json
{
  "success": false,
  "message": "string",
  "code": "ERROR_CODE",
  "errors": {},
  "meta": {
    "trace_id": "..."
  }
}
```

| Field | Type | Use |
|---|---|---|
| `success` | `false` | Discriminant |
| `message` | string | Human-readable, display-only |
| `code` | string | Machine-readable error code — see [error-codes.md](error-codes.md); branch on this |
| `errors` | object | Field-level validation errors (present notably on `VALIDATION_FAILED`) |
| `meta.trace_id` | string | Correlates this error with backend logs — surface in diagnostics/support UI |

## Client-Side Handling Rule

The central API client (`shared/api/client.ts`, target — see
[../architecture/api-integration-architecture.md](../architecture/api-integration-architecture.md))
parses every HTTP response against this shape before returning anything to a caller. A response
that is valid JSON but doesn't match either shape (missing `success`, wrong types) is treated as a
transport/integration error, not silently passed through as if it were envelope data.
