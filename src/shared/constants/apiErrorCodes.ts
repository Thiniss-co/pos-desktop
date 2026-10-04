export const API_ERROR_CODES = [
  'VALIDATION_ERROR',
  'INVALID_CREDENTIALS',
  'UNAUTHENTICATED',
  'USER_INACTIVE',
  'SESSION_REVOKED',
  'COMPANY_INACTIVE',
  'FORBIDDEN',
  'FEATURE_NOT_ENABLED',
  'PERMISSION_DENIED',
  'FEATURE_PERMISSION_DENIED',
  'DESKTOP_LOGIN_FORBIDDEN',
  'DESKTOP_TOKEN_NOT_BOUND',
  'DESKTOP_TOKEN_DEVICE_MISMATCH',
  'DESKTOP_LOCAL_IDENTITY_MISSING',
  'DESKTOP_CONTEXT_REQUIRED',
  'DESKTOP_ACCESS_FORBIDDEN',
  'DESKTOP_CATALOG_UNAVAILABLE',
  'DESKTOP_CATALOG_REVISION_INVALID',
  // Invoice upload (BE-3F-3). These must be listed here, not merely categorized: an unlisted code
  // is stripped from PublicAppError.backendCode by normalizeApiEnvelopeError, which would leave the
  // upload worker unable to tell a terminal rejection from any other failure.
  'DESKTOP_HISTORICAL_ATTRIBUTION_FORBIDDEN',
  'DESKTOP_ALLOCATION_PROOF_REQUIRED',
  // PS4 (plan §7.3a.4, review finding T3). This code was MISSING, and its absence was a real
  // production defect rather than a cosmetic gap: an unlisted code is stripped from
  // `PublicAppError.backendCode` by `normalizeApiEnvelopeError`, so an attached-proof quarantine
  // — a permanently invalid claim — fell through as an ambiguous retryable failure that the worker
  // would re-send forever, with its exact reason lost.
  'DESKTOP_INVOICE_QUARANTINED',
  // PS2 §15.1. Deliberately NOT terminal: it means the server is currently below the v3 parsing
  // floor and cannot honour a claim that may well be valid. Classifying it terminal would let a
  // routine backend rollback permanently reject legitimate committed sales.
  'DESKTOP_CONTRACT_VERSION_UNSUPPORTED',
  'DESKTOP_OFFLINE_SALE_AUTHORITY_INVALID',
  'DESKTOP_LEGACY_CONTRACT_UNSUPPORTED',
  // PS9. Listing it is what makes it work at all: an unlisted code is stripped from
  // `PublicAppError.backendCode` by `normalizeApiEnvelopeError`, so the terminal mapping in
  // `invoiceUploadMapping.ts` would never fire and the worker would retry a permanently
  // unverifiable invoice forever, with its actual reason lost.
  //
  // A tenant still waiting for its tracking baseline is NOT this code — the backend answers a
  // retryable `SERVICE_UNAVAILABLE` for that, so a deployment window never looks terminal here.
  'DESKTOP_HISTORICAL_STOCK_TRACKING_UNVERIFIABLE',
  'DESKTOP_SHIFT_ALREADY_OPEN',
  'DESKTOP_SHIFT_NOT_OPEN',
  'DESKTOP_SHIFT_ACCESS_DENIED',
  'DESKTOP_SHIFT_ALREADY_PAUSED',
  'DESKTOP_SHIFT_NOT_PAUSED',
  'DESKTOP_SHIFT_ACTIVE_PAUSE_NOT_FOUND',
  'NOT_FOUND',
  'ROUTE_NOT_FOUND',
  'MODEL_NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'TOO_MANY_REQUESTS',
  'CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  // POS improvements, Stage 1/2: durable register quick-create refusals.
  'DESKTOP_ENTITY_UUID_CONFLICT',
  'DESKTOP_PRODUCT_IDENTIFIER_TAKEN',
  'DESKTOP_SUPPLIER_NAME_TAKEN',
  'DESKTOP_ENTITY_REFERENCE_INVALID',
  'LOYALTY_FEATURE_NOT_ENABLED',
  'ACCOUNTING_FEATURE_NOT_ENABLED',
  'COMPANY_LIMIT_REACHED',
  'COMPANY_LAST_ADMIN',
  'ROLE_ASSIGNMENT_FORBIDDEN',
  'SERVER_ERROR',
  'SERVICE_UNAVAILABLE',
  // Receipt-printing plan §D-10/§D-11. Listing these is what makes them work at all: an unlisted
  // code is stripped from `PublicAppError.backendCode` by `normalizeApiEnvelopeError`, so the
  // admin editor's 409-conflict reload and its field-error mapping would never fire.
  'RECEIPT_PROFILE_ADMINISTRATION_FORBIDDEN',
  'RECEIPT_PROFILE_REVISION_CONFLICT',
  'RECEIPT_PROFILE_ASSET_INVALID',
  'RECEIPT_PROFILE_ASSET_NOT_FOUND',
  // CP4 offline stock preparation. Both are definitive answers `PreparationService` classifies on;
  // unlisted, they were stripped from `backendCode` and every such answer degraded to "ambiguous".
  'POLICY_REVISION_STALE',
  'DESKTOP_PREPARATION_UNAVAILABLE',
  // Owner receipt copies: the receipt snapshot upload's definitive answers.
  'RECEIPT_SNAPSHOT_INVALID',
  'RECEIPT_SNAPSHOT_CONFLICT',
  'INVOICE_NOT_UPLOADED'
] as const

export const UNKNOWN_API_ERROR_CODE = 'UNKNOWN' as const

export type KnownApiErrorCode = (typeof API_ERROR_CODES)[number]
export type ApiErrorCode = KnownApiErrorCode | typeof UNKNOWN_API_ERROR_CODE

export function isKnownApiErrorCode(code: string): code is KnownApiErrorCode {
  return (API_ERROR_CODES as readonly string[]).includes(code)
}

export function toApiErrorCode(code: string): ApiErrorCode {
  return isKnownApiErrorCode(code) ? code : UNKNOWN_API_ERROR_CODE
}
