# Backend Contract

What this desktop consumes from the Laravel backend (`/api/v1/desktop/*` only). Each file states
where its facts were confirmed. When a document and the backend source disagree, the backend source
wins and the document is corrected — see the disposition note in
[sync-contract-summary.md](sync-contract-summary.md) for an example.

| Document | Covers |
|---|---|
| [response-envelope.md](response-envelope.md) | The success/error envelope every response uses |
| [error-codes.md](error-codes.md) | Backend `code` values and the client handling each one requires |
| [auth-device-contract.md](auth-device-contract.md) | Device registration, sign-in, tokens, device headers |
| [bootstrap-license-contract.md](bootstrap-license-contract.md) | Bootstrap, licence validation, negotiated capabilities |
| [desktop-api-summary.md](desktop-api-summary.md) | The desktop route list and what each route is for |
| [sync-contract-summary.md](sync-contract-summary.md) | Invoice/refund upload, quarantine and operator disposition discovery |
| [company-user-management.md](company-user-management.md) | Online-only company user management |
| [openapi-import-blocker.md](openapi-import-blocker.md) | Why no OpenAPI client is generated yet |
