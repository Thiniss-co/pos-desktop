import { DESKTOP_API_ROUTES } from '@shared/constants/apiRoutes'
import { createPublicError } from '../http/apiError'
import {
  DESKTOP_INVOICE_ALREADY_UPLOADED_CODE,
  DESKTOP_INVOICE_UPLOADED_CODE,
  desktopInvoiceUploadResourceSchema,
  type DesktopInvoiceUploadResource
} from '../http/desktopResources.contract'

/**
 * The single upload call against `POST /api/v1/desktop/invoices/upload`.
 *
 * Phase 3G scope note: this module **sends** and **classifies the accepted answer**. It does not
 * decide what happens to a queue row, does not touch SQLite, does not retry, and has no scheduler.
 * Outcome mapping and persistence are CP-3G-3's job. Nothing constructs this module yet, so no
 * invoice upload can be attempted at runtime by merely landing CP-3G-1.
 */

/** Only the slice of DesktopApiClient this call needs, so tests need no HTTP client. */
export interface InvoiceUploadApiClient {
  requestWithMeta<T>(
    route: (typeof DESKTOP_API_ROUTES)['invoicesUpload'],
    body?: unknown
  ): Promise<{
    readonly data: T
    readonly meta: Record<string, unknown>
    readonly code: string
    readonly message: string
  }>
}

/**
 * A server answer that accepted the invoice. `created` is a fresh commit (201
 * `DESKTOP_INVOICE_UPLOADED`); `duplicate` is an idempotent replay of the identical payload (200
 * `DESKTOP_INVOICE_ALREADY_UPLOADED`).
 *
 * Both mean the same thing to the desktop — **the server holds exactly one invoice for this
 * idempotency key** — and both must therefore resolve the queue row to `synced`. The distinction
 * is kept because it is the difference between "this upload did the work" and "a previous attempt
 * already did, and its acknowledgment was lost", which is worth recording and worth showing in
 * diagnostics.
 */
export interface InvoiceUploadAccepted {
  readonly kind: 'created' | 'duplicate'
  readonly invoice: DesktopInvoiceUploadResource
  readonly traceId?: string
}

function contractError(message: string, backendCode: string): never {
  // Not retryable: a contract violation is not a transport hiccup, and re-sending cannot fix it.
  throw createPublicError('unexpected', message, false, { backendCode })
}

/**
 * Reads the immutable `sync_queue.payload_json` back into the request body.
 *
 * The queued JSON is authority and is sent as-is — the body is never rebuilt from local rows at
 * upload time, because rebuilding could produce a payload that differs from the one whose hash was
 * committed, and the backend answers a differing payload under the same key with a 409.
 */
export function parseFrozenUploadPayload(payloadJson: string): Record<string, unknown> {
  let parsed: unknown

  try {
    parsed = JSON.parse(payloadJson)
  } catch {
    return contractError('The queued invoice payload is not valid JSON', 'upload_payload_not_json')
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return contractError(
      'The queued invoice payload is not a JSON object',
      'upload_payload_not_object'
    )
  }

  return parsed as Record<string, unknown>
}

export async function uploadInvoice(
  apiClient: InvoiceUploadApiClient,
  payloadJson: string
): Promise<InvoiceUploadAccepted> {
  const body = parseFrozenUploadPayload(payloadJson)
  const response = await apiClient.requestWithMeta<unknown>(DESKTOP_API_ROUTES.invoicesUpload, body)

  const kind =
    response.code === DESKTOP_INVOICE_UPLOADED_CODE
      ? 'created'
      : response.code === DESKTOP_INVOICE_ALREADY_UPLOADED_CODE
        ? 'duplicate'
        : null

  if (kind === null) {
    // A 2xx we do not recognize. The server may well have created the invoice, so this must never
    // be treated as a rejection — CP-3G-3 leaves the row retryable and diagnoses it, and the next
    // attempt replays the same idempotency key and converges on the duplicate answer.
    return contractError(
      'The invoice upload returned an unrecognized success code',
      'upload_success_code_unrecognized'
    )
  }

  const invoice = desktopInvoiceUploadResourceSchema.safeParse(response.data)

  if (!invoice.success) {
    // Same reasoning as above: the invoice is probably committed server-side. Failing loudly here
    // is right, but the failure means "we cannot read the answer", never "the sale was refused".
    return contractError(
      'The invoice upload returned a response body that does not match the contract',
      'upload_response_invalid'
    )
  }

  const traceId = response.meta.trace_id

  return {
    kind,
    invoice: invoice.data,
    ...(typeof traceId === 'string' ? { traceId } : {})
  }
}
