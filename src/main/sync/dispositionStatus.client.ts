import { z } from 'zod'
import { DESKTOP_API_ROUTES, type DesktopApiRoute } from '@shared/constants/apiRoutes'
import type { PublicAppError } from '@shared/contracts/api.contract'
import type { SyncStatusEntry } from '@shared/contracts/dispositionDiscovery.contract'
import { createPublicError } from '../http/apiError'

/** PS5b `DesktopInvoiceSyncStatusRequest`: `idempotency_keys` is `min:1|max:50`. */
export const SYNC_STATUS_MAXIMUM_KEYS = 50

/** Only the slice of DesktopApiClient this call needs, so tests need no HTTP client. */
export interface DispositionStatusApiClient {
  request<T>(route: DesktopApiRoute, body?: unknown): Promise<T>
}

/**
 * The envelope is read loosely on purpose: each entry's `disposition` is left as received so the
 * discovery service can parse it strictly and record a durable `malformed-result` conflict for that
 * one invoice. Parsing it strictly here would turn one malformed decision into a failed request for
 * every key in the batch, and record nothing.
 */
const statusEntrySchema = z
  .object({
    idempotency_key: z.string(),
    status: z.string(),
    local_invoice_uuid: z.string().optional(),
    invoice: z
      .object({ invoice_uuid: z.string(), server_number: z.string() })
      .passthrough()
      .nullable()
      .optional(),
    disposition: z.unknown().optional()
  })
  .passthrough()

const statusResponseSchema = z.object({ statuses: z.array(statusEntrySchema) }).passthrough()

export function syncStatusRoute(idempotencyKeys: readonly string[]): DesktopApiRoute {
  const query = new URLSearchParams()

  for (const key of idempotencyKeys) {
    query.append('idempotency_keys[]', key)
  }

  const route = DESKTOP_API_ROUTES.invoicesSyncStatus

  return { ...route, path: `${route.path}?${query.toString()}` }
}

/**
 * `GET /api/v1/desktop/invoices/sync-status` for this device's own idempotency keys.
 *
 * Returns the entries keyed by idempotency key. The server answers exactly the requested keys,
 * de-duplicated, with `not_found` for a key it does not hold for this device; a key it did not
 * answer, or answered twice, makes the whole answer untrustworthy and is refused rather than
 * partially used.
 */
export async function fetchDispositionStatuses(
  apiClient: DispositionStatusApiClient,
  idempotencyKeys: readonly string[]
): Promise<ReadonlyMap<string, SyncStatusEntry>> {
  const keys = [...new Set(idempotencyKeys)]

  if (keys.length === 0 || keys.length > SYNC_STATUS_MAXIMUM_KEYS) {
    throw new Error(`A sync-status read takes 1-${SYNC_STATUS_MAXIMUM_KEYS} idempotency keys`)
  }

  const data = await apiClient.request<unknown>(syncStatusRoute(keys))
  const parsed = statusResponseSchema.safeParse(data)

  if (!parsed.success) {
    throw invalidAnswer('The sync-status answer did not match the expected shape.')
  }

  const entries = new Map<string, SyncStatusEntry>()

  for (const entry of parsed.data.statuses) {
    if (entries.has(entry.idempotency_key) || !keys.includes(entry.idempotency_key)) {
      throw invalidAnswer('The sync-status answer named a key twice or one that was not asked.')
    }

    entries.set(entry.idempotency_key, entry as SyncStatusEntry)
  }

  if (entries.size !== keys.length) {
    throw invalidAnswer('The sync-status answer omitted a requested key.')
  }

  return entries
}

function invalidAnswer(message: string): PublicAppError {
  return createPublicError('unexpected', message, true, {
    backendCode: 'DESKTOP_SYNC_STATUS_ANSWER_INVALID'
  })
}
