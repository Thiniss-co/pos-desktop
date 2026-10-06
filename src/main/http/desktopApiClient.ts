import type { DesktopApiRoute } from '@shared/constants/apiRoutes'
import type { ApiErrorEnvelope, PublicAppError } from '@shared/contracts/api.contract'
import type { ConnectivityRequestOutcome } from '@shared/contracts/connectivity.contract'
import {
  backendNotConfiguredError,
  classifyTransportError,
  createPublicError,
  isPublicAppError,
  normalizeHttpError,
  normalizeTransportError,
  parseRetryAfter,
  responseBodyNotJsonError,
  RETRY_AFTER_STATUSES,
  withRetryAfterDetails
} from './apiError'
import { parseApiEnvelope, unwrapApiEnvelope } from './apiEnvelope'
import { createApiTracer, type ApiTracer } from './apiTrace'

const DESKTOP_API_PREFIX = '/api/v1/desktop'

export interface DesktopApiClientDependencies {
  readonly apiOrigin: URL | null
  readonly getAccessToken: () => string | null
  readonly getDeviceUuid: () => string | null
  readonly fetchImplementation?: typeof fetch
  readonly timeoutMs?: number
  readonly tracer?: ApiTracer
  readonly onAuthenticatedFailure?: (error: PublicAppError) => void
  readonly onRequestOutcome?: (outcome: ConnectivityRequestOutcome) => void
  /**
   * Phase 3: `meta.company_access` of any parsed response, success or error (sign-in, heartbeat, uploads,
   * refusals), offered before error normalization drops `meta`. The receiver validates and orders it.
   */
  readonly onCompanyAccessObserved?: (access: unknown) => void
}

/**
 * Per-request options. `reportOutcome: false` skips ONLY the connectivity feedback (`onRequestOutcome`)
 * for a background request whose failure says nothing about the till being online (product image
 * downloads, owner UX plan P8). Authentication and revocation handling (`onAuthenticatedFailure`) and
 * normal error handling still run.
 */
export interface DesktopApiRequestOptions {
  readonly reportOutcome?: boolean
}

export interface DesktopApiResponse<T> {
  readonly data: T
  readonly meta: Record<string, unknown>
  /**
   * The success envelope's `code`. Two endpoints answer one request with two different success
   * codes and the same body — invoice upload returns `DESKTOP_INVOICE_UPLOADED` (201) or
   * `DESKTOP_INVOICE_ALREADY_UPLOADED` (200) — so the code is the only thing that distinguishes a
   * fresh commit from an idempotent replay. Without it a caller cannot tell them apart.
   */
  readonly code: string
  /** The success envelope's `message`. Display/diagnostic text only; never branch on it. */
  readonly message: string
}

export function resolveDesktopApiUrl(apiOrigin: URL, path: string): URL {
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.includes('..') ||
    path.includes('\\') ||
    path.includes('://') ||
    path.startsWith('/api/v1/admin') ||
    path.startsWith('/api/v1/auth')
  ) {
    throw new Error('Only relative desktop API paths are allowed')
  }

  const url = new URL(`${DESKTOP_API_PREFIX}${path}`, apiOrigin)

  if (url.origin !== apiOrigin.origin || !url.pathname.startsWith(`${DESKTOP_API_PREFIX}/`)) {
    throw new Error('The API path escapes the desktop API namespace')
  }

  return url
}

export class DesktopApiClient {
  private readonly abortControllers = new Set<AbortController>()
  private readonly fetchImplementation: typeof fetch
  private readonly timeoutMs: number
  private readonly tracer: ApiTracer

  constructor(private readonly dependencies: DesktopApiClientDependencies) {
    this.fetchImplementation = dependencies.fetchImplementation ?? fetch
    this.timeoutMs = dependencies.timeoutMs ?? 10_000
    this.tracer = dependencies.tracer ?? createApiTracer()
  }

  async request<T>(
    route: DesktopApiRoute,
    body?: unknown,
    options: DesktopApiRequestOptions = {}
  ): Promise<T> {
    return (await this.requestWithMeta<T>(route, body, options)).data
  }

  async requestWithMeta<T>(
    route: DesktopApiRoute,
    body?: unknown,
    options: DesktopApiRequestOptions = {}
  ): Promise<DesktopApiResponse<T>> {
    const reportOutcome = options.reportOutcome !== false
    this.assertRequestPreconditions(route)

    const apiOrigin = this.dependencies.apiOrigin

    if (!apiOrigin) {
      throw backendNotConfiguredError()
    }

    const url = resolveDesktopApiUrl(apiOrigin, route.path)
    const startedAt = performance.now()
    this.tracer.start({ method: route.method, url })
    const headers = new Headers({ Accept: 'application/json' })

    if (body !== undefined) {
      headers.set('Content-Type', 'application/json')
    }

    if (route.requiresAuth) {
      headers.set('Authorization', `Bearer ${this.dependencies.getAccessToken()}`)
      headers.set('X-Device-UUID', this.dependencies.getDeviceUuid() as string)
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    this.abortControllers.add(controller)
    let responseTraced = false
    let receivedHttpResponse = false
    // Set only for a 429/503: the status plus the server's parsed `Retry-After` (if usable), so the
    // thrown error carries the server's own wait instead of leaving callers to guess.
    let retryAfterContext: {
      readonly status: number
      readonly seconds: number | undefined
    } | null = null

    try {
      const response = await this.fetchImplementation(url, {
        method: route.method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      })
      receivedHttpResponse = true
      if (reportOutcome) {
        this.reportRequestOutcome({ kind: 'http_response', status: response.status })
      }

      if (RETRY_AFTER_STATUSES.has(response.status)) {
        retryAfterContext = {
          status: response.status,
          seconds: parseRetryAfter(
            response.headers?.get('retry-after') ?? null,
            response.headers?.get('date') ?? null,
            Date.now()
          )
        }
      }

      let payload: unknown

      try {
        payload = await response.json()
      } catch {
        throw responseBodyNotJsonError(
          response.status,
          response.headers?.get('content-type') ?? null
        )
      }

      const envelope = parseApiEnvelope(payload)
      const errorEnvelope = envelope.success ? undefined : (envelope as ApiErrorEnvelope)
      this.observeCompanyAccess(envelope.meta)

      this.tracer.finish({
        method: route.method,
        url,
        elapsedMs: Math.round(performance.now() - startedAt),
        status: response.status,
        contentType: response.headers?.get('content-type') ?? undefined,
        backendCode: envelope.code,
        traceId: errorEnvelope?.meta.trace_id,
        validationFields: errorEnvelope ? Object.keys(errorEnvelope.errors) : undefined
      })
      responseTraced = true

      if (!response.ok) {
        throw normalizeHttpError(response.status, errorEnvelope)
      }

      return {
        data: unwrapApiEnvelope<T>(payload),
        meta: envelope.meta,
        code: envelope.code,
        message: envelope.message
      }
    } catch (error) {
      if (!receivedHttpResponse && reportOutcome) {
        this.reportRequestOutcome({ kind: 'transport_failure' })
      }

      const normalizedError = isPublicAppError(error) ? error : normalizeTransportError(error)
      const publicError = retryAfterContext
        ? withRetryAfterDetails(
            normalizedError,
            retryAfterContext.status,
            retryAfterContext.seconds
          )
        : normalizedError

      if (route.requiresAuth) {
        this.dependencies.onAuthenticatedFailure?.(publicError)
      }

      if (!responseTraced) {
        this.tracer.failure({
          method: route.method,
          url,
          elapsedMs: Math.round(performance.now() - startedAt),
          classification: isPublicAppError(error) ? error.category : classifyTransportError(error),
          backendCode: publicError.backendCode,
          traceId: publicError.traceId,
          validationFields: publicError.fieldErrors
            ? Object.keys(publicError.fieldErrors)
            : undefined
        })
      }

      throw publicError
    } finally {
      clearTimeout(timeout)
      this.abortControllers.delete(controller)
    }
  }

  /**
   * Lets mutation services complete every local rejection before they write fail-closed recovery
   * state. requestWithMeta calls the same check immediately before dispatch.
   */
  assertRequestPreconditions(route: DesktopApiRoute): void {
    if (!this.dependencies.apiOrigin) {
      throw backendNotConfiguredError()
    }

    resolveDesktopApiUrl(this.dependencies.apiOrigin, route.path)

    if (route.requiresAuth) {
      const token = this.dependencies.getAccessToken()
      const deviceUuid = this.dependencies.getDeviceUuid()

      if (!token || !deviceUuid) {
        throw createPublicError(
          'authentication',
          'A protected desktop request requires a session and device identity.',
          false,
          { backendCode: 'DESKTOP_LOCAL_IDENTITY_MISSING' }
        )
      }
    }
  }

  shutdown(): void {
    for (const controller of this.abortControllers) {
      controller.abort()
    }

    this.abortControllers.clear()
  }

  private observeCompanyAccess(meta: Record<string, unknown> | undefined): void {
    if (!meta || meta.company_access === undefined) {
      return
    }

    try {
      this.dependencies.onCompanyAccessObserved?.(meta.company_access)
    } catch {
      // Observing the company state must never affect the business request.
    }
  }

  private reportRequestOutcome(outcome: ConnectivityRequestOutcome): void {
    try {
      this.dependencies.onRequestOutcome?.(outcome)
    } catch {
      // Connectivity feedback must never affect the business request.
    }
  }
}
