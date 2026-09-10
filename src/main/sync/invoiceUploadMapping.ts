import type { PublicAppError } from '@shared/contracts/api.contract'
import { calculateRetryDelayMs } from './syncPolicy'
import type { SyncQueueErrorDetails } from '../repositories/syncQueue.repository'
import type { InvoiceUploadOutcome } from './invoiceUploadOutcome'

/**
 * Why the worker as a whole has stopped. This is in-memory only: there is no seventh queue state
 * and no per-item pause. Items keep the states they already had, local selling is unaffected, and
 * the reason exists so a person can be told *why* nothing is uploading.
 */
export type SyncPauseReason =
  | 'not-configured'
  | 'offline'
  | 'session-invalid'
  | 'device-blocked'
  | 'license-denied'
  | 'permission-denied'
  | 'feature-not-enabled'
  | 'company-inactive'
  | 'unknown'

/**
 * What to do with one dispatched upload that did not succeed.
 *
 * `pause` means the failure was about *this device's authority*, not about this invoice: every
 * other queued invoice would fail identically, so the worker stops instead of marching the whole
 * queue into a wall. The item itself is released for a later attempt, never marked terminal.
 */
export type UploadFailureDisposition =
  | { readonly kind: 'outcome'; readonly outcome: InvoiceUploadOutcome }
  | {
      readonly kind: 'pause'
      readonly reason: SyncPauseReason
      readonly outcome: InvoiceUploadOutcome
    }

/** Terminal business rejections of *this payload*. Re-sending it can only be refused again. */
const TERMINAL_REJECTION_CODES = new Set([
  'VALIDATION_ERROR',
  'DESKTOP_CATALOG_REVISION_INVALID',
  'DESKTOP_ALLOCATION_PROOF_REQUIRED',
  'DESKTOP_LEGACY_CONTRACT_UNSUPPORTED',
  // The shift is unknown to this company or belongs to another device. The backend answers both
  // causes identically on purpose, so the desktop must not guess which one it was — but either way
  // this device can never make this upload succeed.
  'DESKTOP_HISTORICAL_ATTRIBUTION_FORBIDDEN',
  // PS4 §7.3a.4: an attached allocation proof the server refused. Re-sending the same frozen bytes
  // can only be refused again, so it is terminal — and it must be, because PS6b's disposition
  // discovery selects on exactly this terminal classification plus one allowlisted reason.
  'DESKTOP_INVOICE_QUARANTINED',
  // PS2 §15.1: the referenced authority does not exist, does not match this device, or does not
  // cover `sold_at`. Permanently invalid, and explicitly never disposition-eligible — accepting it
  // would manufacture authority.
  'DESKTOP_OFFLINE_SALE_AUTHORITY_INVALID'
])

/**
 * PS4 §7.3a.2 / §7.3a.5: the exact quarantine reasons a disposition may later act on.
 *
 * Persisted verbatim so PS6b can select on it. Anything outside this set — including
 * `catalog_window_violation` — is recorded as a contract failure rather than silently accepted,
 * because an unknown reason is precisely the case where guessing would be most damaging.
 */
const ALLOWLISTED_QUARANTINE_REASONS = new Set([
  'allocation_not_owned',
  'allocation_generation_mismatch',
  'allocation_sequence_gap',
  'allocation_insufficient_rights',
  'allocation_expired_at_sale_time'
])

/**
 * Extract the single exact quarantine reason from a backend error envelope.
 *
 * The backend sends `errors.quarantine_reason` as a ONE-element string array. Anything else —
 * missing, empty, multiple, non-string, or a reason outside the allowlist — returns
 * `'contract-error'` rather than a guess. Message text is never parsed: §7.3a.4 is explicit that an
 * ambiguous row must stay ambiguous until an exact replay obtains the backend's own classification.
 */
export function extractQuarantineReason(
  fieldErrors: Readonly<Record<string, readonly string[]>> | undefined
):
  | { readonly ok: true; readonly reason: string }
  | { readonly ok: false; readonly code: 'contract-error' } {
  const values = fieldErrors?.quarantine_reason

  if (!Array.isArray(values) || values.length !== 1 || typeof values[0] !== 'string') {
    return { ok: false, code: 'contract-error' }
  }

  const reason = values[0]

  return ALLOWLISTED_QUARANTINE_REASONS.has(reason)
    ? { ok: true, reason }
    : { ok: false, code: 'contract-error' }
}

/** Genuine disagreements that need a human to compare two versions. */
const CONFLICT_CODES = new Set(['IDEMPOTENCY_CONFLICT', 'CONFLICT'])

const PAUSE_REASON_BY_CODE: Readonly<Record<string, SyncPauseReason>> = {
  UNAUTHENTICATED: 'session-invalid',
  SESSION_REVOKED: 'session-invalid',
  USER_INACTIVE: 'session-invalid',
  INVALID_CREDENTIALS: 'session-invalid',
  DESKTOP_TOKEN_NOT_BOUND: 'device-blocked',
  DESKTOP_TOKEN_DEVICE_MISMATCH: 'device-blocked',
  DESKTOP_ACCESS_FORBIDDEN: 'device-blocked',
  DESKTOP_LOCAL_IDENTITY_MISSING: 'device-blocked',
  DESKTOP_CONTEXT_REQUIRED: 'device-blocked',
  FORBIDDEN: 'license-denied',
  PERMISSION_DENIED: 'permission-denied',
  FEATURE_PERMISSION_DENIED: 'permission-denied',
  FEATURE_NOT_ENABLED: 'feature-not-enabled',
  COMPANY_INACTIVE: 'company-inactive'
}

function details(error: PublicAppError): SyncQueueErrorDetails {
  // PS4 §7.3a.4 (review finding T3): the quarantine reason is carried on `fieldErrors`, and queue
  // details previously dropped it — so even when normalization HAD parsed it, the exact reason was
  // lost the moment the row was persisted, and PS6b would have had nothing to select on.
  const quarantineReason =
    error.backendCode === 'DESKTOP_INVOICE_QUARANTINED'
      ? extractQuarantineReason(error.fieldErrors)
      : undefined

  return {
    ...(error.backendCode === undefined ? {} : { backendCode: error.backendCode }),
    ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
    ...(error.traceId === undefined ? {} : { traceId: error.traceId }),
    ...(quarantineReason === undefined
      ? {}
      : quarantineReason.ok
        ? { quarantineReason: quarantineReason.reason }
        : // Fails CLOSED and visibly: a malformed, missing, multiple or unknown reason is recorded
          // as a contract error, never inferred. PS6b will not treat such a row as a candidate.
          { quarantineReasonContractError: true }),
    message: error.message
  }
}

/**
 * Maps a failed dispatch onto exactly one disposition. There is no default "everything else is
 * rejected" arm, and that is deliberate:
 *
 * **An unrecognized failure is retried, never terminally rejected.** A wrongly-retried upload is
 * visible in the queue counts and costs one more request; a wrongly-rejected one silently strands a
 * real sale that the server would have accepted. When the desktop does not understand an answer, the
 * safe direction is to keep asking.
 */
export function mapUploadFailure(
  error: PublicAppError,
  attemptCount: number,
  random: () => number = Math.random
): UploadFailureDisposition {
  const code = error.backendCode
  const errorCode = code ?? error.category
  const retryable = {
    kind: 'retryable' as const,
    errorCode,
    retryDelayMs: calculateRetryDelayMs(attemptCount, random),
    details: details(error)
  }

  if (error.category === 'configuration') {
    // No backend origin is configured. Nothing can ever be uploaded until that changes, so
    // hammering the queue would be pointless.
    return { kind: 'pause', reason: 'not-configured', outcome: { ...retryable, retryDelayMs: 0 } }
  }

  if (code !== undefined && TERMINAL_REJECTION_CODES.has(code)) {
    return {
      kind: 'outcome',
      outcome: { kind: 'rejected', errorCode: code, details: details(error) }
    }
  }

  if (code !== undefined && CONFLICT_CODES.has(code)) {
    return {
      kind: 'outcome',
      outcome: {
        kind: 'conflict',
        errorCode: code,
        details: details(error),
        reportedDetails: error.message
      }
    }
  }

  const pauseReason = code === undefined ? undefined : PAUSE_REASON_BY_CODE[code]

  if (pauseReason !== undefined) {
    // Released immediately rather than after a backoff: the moment authority is restored this item
    // should be eligible again. The pause, not the delay, is what stops the loop.
    return { kind: 'pause', reason: pauseReason, outcome: { ...retryable, retryDelayMs: 0 } }
  }

  if (error.category === 'authentication' || error.category === 'authorization') {
    // A denial we have no specific reason for. Still device-wide, so still a pause.
    return { kind: 'pause', reason: 'unknown', outcome: { ...retryable, retryDelayMs: 0 } }
  }

  // Transport, 429, 5xx, timeouts, and every contract failure (`unexpected`): all retryable.
  // A contract failure in particular may mean the server *did* commit the invoice and we simply
  // could not read the answer — re-sending the same idempotency key resolves that, whereas
  // rejecting it would strand a sale the server already holds.
  return { kind: 'outcome', outcome: retryable }
}
