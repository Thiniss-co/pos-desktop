import type { DesktopApiRoute } from '@shared/constants/apiRoutes'
import type { ApiErrorEnvelope } from '@shared/contracts/api.contract'
import { isPublicAppError, normalizeHttpError, normalizeTransportError } from './apiError'
import { parseApiEnvelope, unwrapApiEnvelope } from './apiEnvelope'

const DESKTOP_API_PREFIX = '/api/v1/desktop'

export interface DesktopApiClientDependencies {
  readonly apiOrigin: URL | null
  readonly getAccessToken: () => string | null
  readonly getDeviceUuid: () => string | null
  readonly fetchImplementation?: typeof fetch
  readonly timeoutMs?: number
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

  constructor(private readonly dependencies: DesktopApiClientDependencies) {
    this.fetchImplementation = dependencies.fetchImplementation ?? fetch
    this.timeoutMs = dependencies.timeoutMs ?? 10_000
  }

  async request<T>(route: DesktopApiRoute, body?: unknown): Promise<T> {
    if (!this.dependencies.apiOrigin) {
      throw new Error('The desktop API origin is not configured')
    }

    const url = resolveDesktopApiUrl(this.dependencies.apiOrigin, route.path)
    const headers = new Headers({ Accept: 'application/json' })

    if (body !== undefined) {
      headers.set('Content-Type', 'application/json')
    }

    if (route.requiresAuth) {
      const token = this.dependencies.getAccessToken()
      const deviceUuid = this.dependencies.getDeviceUuid()

      if (!token || !deviceUuid) {
        throw new Error('Protected desktop API requests require a session and device identity')
      }

      headers.set('Authorization', `Bearer ${token}`)
      headers.set('X-Device-UUID', deviceUuid)
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    this.abortControllers.add(controller)

    try {
      const response = await this.fetchImplementation(url, {
        method: route.method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      })
      const payload: unknown = await response.json()
      const envelope = parseApiEnvelope(payload)

      if (!response.ok) {
        throw normalizeHttpError(
          response.status,
          envelope.success ? undefined : (envelope as ApiErrorEnvelope)
        )
      }

      return unwrapApiEnvelope<T>(payload)
    } catch (error) {
      if (isPublicAppError(error)) {
        throw error
      }

      throw normalizeTransportError(error)
    } finally {
      clearTimeout(timeout)
      this.abortControllers.delete(controller)
    }
  }

  shutdown(): void {
    for (const controller of this.abortControllers) {
      controller.abort()
    }

    this.abortControllers.clear()
  }
}
