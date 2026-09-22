import { DESKTOP_API_ROUTES } from '@shared/constants/apiRoutes'
import { createPublicError, isPublicAppError } from '../http/apiError'
import {
  DESKTOP_REFUND_ALREADY_UPLOADED_CODE,
  DESKTOP_REFUND_UPLOADED_CODE,
  desktopRefundUploadResourceSchema,
  type DesktopRefundUploadResource
} from '../http/desktopResources.contract'
import type { PublicAppError } from '@shared/contracts/api.contract'

/**
 * The single dispatch call against `POST /api/v1/desktop/refunds/upload` (plan §3b), mirroring
 * `invoiceUpload.client.ts`'s `created | duplicate` classification exactly, plus the three refund-
 * specific durable outcomes the r5 confirmation contract introduces: `rejected` (durable, definitive
 * business refusal — including a stale calculation), `conflict` (outcome unknown, keeps the invoice
 * blocked), and `unresolved` (transport ambiguity, or an access failure that proves nothing about
 * commit).
 *
 * This module sends and classifies; it does not touch SQLite. `RefundService` owns persistence.
 */

export interface RefundUploadApiClient {
  requestWithMeta<T>(
    route: (typeof DESKTOP_API_ROUTES)['refundsUpload'],
    body?: unknown
  ): Promise<{
    readonly data: T
    readonly meta: Record<string, unknown>
    readonly code: string
    readonly message: string
  }>
}

export interface RefundUploadAccepted {
  readonly kind: 'created' | 'duplicate'
  readonly refund: DesktopRefundUploadResource
  readonly traceId?: string
}

export interface RefundUploadRejected {
  readonly kind: 'rejected'
  readonly errorCode: string | null
  readonly errorDetails: string | null
}

export interface RefundUploadConflict {
  readonly kind: 'conflict'
  readonly errorCode: string | null
  readonly errorDetails: string | null
}

export interface RefundUploadUnresolved {
  readonly kind: 'unresolved'
  readonly errorCode: string | null
  readonly errorDetails: string | null
}

export type RefundUploadOutcome =
  RefundUploadAccepted | RefundUploadRejected | RefundUploadConflict | RefundUploadUnresolved

function contractError(message: string, backendCode: string): never {
  throw createPublicError('unexpected', message, false, { backendCode })
}

/**
 * Reads the immutable `local_refunds.request_json` back into the request body. Never rebuilt from
 * fresher rows — the exact bytes reviewed and dispatched, every time, including on resume.
 */
export function parseFrozenRefundPayload(requestJson: string): Record<string, unknown> {
  let parsed: unknown

  try {
    parsed = JSON.parse(requestJson)
  } catch {
    return contractError('The queued refund payload is not valid JSON', 'refund_payload_not_json')
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return contractError(
      'The queued refund payload is not a JSON object',
      'refund_payload_not_object'
    )
  }

  return parsed as Record<string, unknown>
}

function firstMessage(error: PublicAppError, key: string): string | null {
  const messages = error.fieldErrors?.[key]
  return Array.isArray(messages) && messages.length > 0 ? messages[0] : null
}

export async function uploadRefund(
  apiClient: RefundUploadApiClient,
  requestJson: string
): Promise<RefundUploadOutcome> {
  const body = parseFrozenRefundPayload(requestJson)

  let response: Awaited<ReturnType<RefundUploadApiClient['requestWithMeta']>>

  try {
    response = await apiClient.requestWithMeta<unknown>(DESKTOP_API_ROUTES.refundsUpload, body)
  } catch (error) {
    if (!isPublicAppError(error)) {
      // A raw transport/parse failure the HTTP layer did not classify -- the request may or may
      // not have reached the server. Never treated as a rejection.
      throw error
    }

    // r5 §0.2: 409 IDEMPOTENCY_CONFLICT -- commit status is genuinely UNKNOWN. Stays blocking.
    if (error.category === 'conflict') {
      return {
        kind: 'conflict',
        errorCode: error.backendCode ?? null,
        errorDetails: error.message
      }
    }

    // 401/403: the middleware chain runs before any write, so this specific attempt made no
    // writes -- but it proves nothing about an EARLIER ambiguous attempt on this identity. Never a
    // definitive rejection.
    if (error.category === 'authentication' || error.category === 'authorization') {
      return {
        kind: 'unresolved',
        errorCode: error.backendCode ?? null,
        errorDetails: error.message
      }
    }

    // A definitive 422 for THIS dispatch. The backend's duplicate short-circuit returns an
    // accepted result BEFORE any business check runs (plan §0.1/§0.2), so reaching a business
    // refusal here proves this identity did not already commit. Durable and terminal.
    if (error.category === 'validation' || error.category === 'rejected') {
      const staleReason = firstMessage(error, 'expected_calculation')
      const itemsReason = firstMessage(error, 'items')

      return {
        kind: 'rejected',
        errorCode: staleReason ?? itemsReason ?? error.backendCode ?? null,
        errorDetails: error.message
      }
    }

    // Anything else (transport, unexpected, configuration) is genuinely ambiguous.
    return {
      kind: 'unresolved',
      errorCode: error.backendCode ?? null,
      errorDetails: error.message
    }
  }

  const kind =
    response.code === DESKTOP_REFUND_UPLOADED_CODE
      ? 'created'
      : response.code === DESKTOP_REFUND_ALREADY_UPLOADED_CODE
        ? 'duplicate'
        : null

  if (kind === null) {
    // A 2xx we do not recognize. The server may well have created the refund, so this must never
    // be treated as a rejection -- resume replays the same frozen bytes and converges on the
    // duplicate answer.
    return {
      kind: 'unresolved',
      errorCode: 'refund_upload_success_code_unrecognized',
      errorDetails: 'The refund upload returned an unrecognized success code'
    }
  }

  const parsed = desktopRefundUploadResourceSchema.safeParse(response.data)

  if (!parsed.success) {
    // Same reasoning: the refund is probably committed server-side. Unresolved, never rejected.
    return {
      kind: 'unresolved',
      errorCode: 'refund_upload_response_invalid',
      errorDetails: 'The refund upload returned a response body that does not match the contract'
    }
  }

  return {
    kind,
    refund: parsed.data,
    traceId: response.meta.trace_id as string | undefined
  }
}
