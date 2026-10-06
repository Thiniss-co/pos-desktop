import { z } from 'zod'
import { DESKTOP_API_ROUTES, type DesktopApiRoute } from '@shared/constants/apiRoutes'
import type { QuickCreateEntity } from '@shared/contracts/quickCreate.contract'
import { isPublicAppError } from '../http/apiError'

/**
 * POS improvements, Stage 2 — sends ONE frozen quick-create request and classifies the answer.
 *
 * The classification is by the server's stable codes, never by guesswork:
 *  - `DESKTOP_ENTITY_CREATED` whose echo names this request key and this entity id → accepted;
 *  - the durable refusals the server STORED for this key (and an envelope validation failure of the
 *    frozen bytes, which can never succeed either) → refused;
 *  - `IDEMPOTENCY_CONFLICT` → conflict (the key belongs to a different request);
 *  - 403 of any kind (permission, feature, access) → blocked_permission: preserved, retried after a
 *    fresh access check;
 *  - everything else — transport, timeout, 5xx, 401, an unrecognized or unverifiable answer — is
 *    UNKNOWN: the request may have committed, so it is replayed later with the same key and bytes.
 */

export const QUICK_CREATE_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'VALIDATION_ERROR',
  'DESKTOP_ENTITY_UUID_CONFLICT',
  'DESKTOP_PRODUCT_IDENTIFIER_TAKEN',
  'DESKTOP_SUPPLIER_NAME_TAKEN',
  'DESKTOP_ENTITY_REFERENCE_INVALID'
])

export interface QuickCreateApiClient {
  requestWithMeta<T>(
    route: DesktopApiRoute,
    body?: unknown
  ): Promise<{ readonly data: T; readonly code: string }>
}

export type QuickCreateDispatchResult =
  | { readonly kind: 'accepted'; readonly serverEntityUuid: string }
  | {
      readonly kind: 'refused' | 'conflict' | 'blocked_permission' | 'unknown'
      readonly code: string | null
      readonly message: string | null
      readonly fields: Record<string, readonly string[]> | null
      readonly traceId: string | null
      /** 401: the session ended; the worker pauses rather than spinning. */
      readonly sessionEnded?: boolean
    }

const echoSchema = z
  .object({
    request_key: z.string(),
    client_entity_uuid: z.string(),
    entity_type: z.string(),
    entity: z.object({ uuid: z.string() }).passthrough()
  })
  .passthrough()

const ROUTES: Record<QuickCreateEntity, DesktopApiRoute> = {
  customer: DESKTOP_API_ROUTES.quickCreateCustomers,
  supplier: DESKTOP_API_ROUTES.quickCreateSuppliers,
  product: DESKTOP_API_ROUTES.quickCreateProducts
}

export async function dispatchQuickCreate(
  api: QuickCreateApiClient,
  request: {
    readonly requestKey: string
    readonly entityType: QuickCreateEntity
    readonly clientEntityUuid: string
    readonly canonicalPayloadJson: string
  }
): Promise<QuickCreateDispatchResult> {
  const body = {
    request_key: request.requestKey,
    client_entity_uuid: request.clientEntityUuid,
    payload: JSON.parse(request.canonicalPayloadJson) as unknown
  }

  try {
    const response = await api.requestWithMeta<unknown>(ROUTES[request.entityType], body)
    const echo = echoSchema.safeParse(response.data)
    if (
      response.code === 'DESKTOP_ENTITY_CREATED' &&
      echo.success &&
      echo.data.request_key === request.requestKey &&
      echo.data.client_entity_uuid === request.clientEntityUuid &&
      echo.data.entity_type === request.entityType &&
      echo.data.entity.uuid === request.clientEntityUuid
    ) {
      return { kind: 'accepted', serverEntityUuid: echo.data.entity.uuid }
    }
    // A 2xx that does not verify: the server may well have created it. Never treated as refused.
    return {
      kind: 'unknown',
      code: 'UNVERIFIED_RESPONSE',
      message: 'The server answer could not be verified.',
      fields: null,
      traceId: null
    }
  } catch (error) {
    if (!isPublicAppError(error)) {
      return { kind: 'unknown', code: 'UNEXPECTED', message: null, fields: null, traceId: null }
    }
    const base = {
      code: error.backendCode ?? null,
      message: error.message,
      fields: error.fieldErrors ?? null,
      traceId: error.traceId ?? null
    }
    if (error.backendCode === 'IDEMPOTENCY_CONFLICT') {
      return { kind: 'conflict', ...base }
    }
    if (error.backendCode !== undefined && QUICK_CREATE_REFUSAL_CODES.has(error.backendCode)) {
      return { kind: 'refused', ...base }
    }
    // Phase 3: a platform suspension is not a missing permission; retry later like any unknown outcome.
    if (error.backendCode === 'COMPANY_SUSPENDED') {
      return { kind: 'unknown', ...base }
    }
    if (error.category === 'authorization' || error.httpStatus === 403) {
      return { kind: 'blocked_permission', ...base }
    }
    if (error.category === 'authentication' || error.httpStatus === 401) {
      return { kind: 'unknown', ...base, sessionEnded: true }
    }
    return { kind: 'unknown', ...base }
  }
}
