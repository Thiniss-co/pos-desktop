import { equal, ok } from 'node:assert/strict'

/** One observed outbound request, recorded at the transport boundary. */
export interface RecordedRequest {
  readonly method: string
  readonly origin: string
  readonly pathname: string
  readonly bodyText: string
  readonly hasAuthorization: boolean
  readonly hasDeviceHeader: boolean
}

/**
 * What the spy should do with an attempt, decided per request index.
 *
 * `pass` forwards to the real server and returns its real answer. Every other mode still forwards
 * to the real server first — the server genuinely commits — and only then corrupts what the caller
 * observes. That is the whole point of `lose-acknowledgment`: server truth and worker observation
 * must be allowed to disagree.
 */
export type TransportBehaviour =
  | { readonly kind: 'pass' }
  | { readonly kind: 'lose-acknowledgment' }
  | { readonly kind: 'transport-failure'; readonly message?: string }
  | { readonly kind: 'replace-body'; readonly status: number; readonly body: unknown }

export interface UploadTransportSpy {
  readonly fetchImplementation: typeof fetch
  /** Every request that actually left the process, in order. */
  readonly requests: readonly RecordedRequest[]
  count(): number
  /** Requests whose path is the invoice-upload route. */
  uploadRequests(): readonly RecordedRequest[]
  reset(): void
  /** Queue one behaviour per upcoming request; anything beyond the queue passes through. */
  program(...behaviours: readonly TransportBehaviour[]): void
  assertEveryRequestInDesktopNamespace(): void
}

const DESKTOP_PREFIX = '/api/v1/desktop/'
const UPLOAD_PATH = '/api/v1/desktop/invoices/upload'

/**
 * Wraps the process `fetch` that the production `DesktopApiClient` is constructed with.
 *
 * The client is the real one; this only counts and, where a scenario demands it, decides what the
 * caller gets to see **after** the server has already answered.
 */
export function createUploadTransportSpy(underlying: typeof fetch = fetch): UploadTransportSpy {
  const requests: RecordedRequest[] = []
  let programmed: TransportBehaviour[] = []

  const fetchImplementation = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input))
    const headers = new Headers(init?.headers ?? {})
    const bodyText = typeof init?.body === 'string' ? init.body : ''

    requests.push({
      method: init?.method ?? 'GET',
      origin: url.origin,
      pathname: url.pathname,
      bodyText,
      hasAuthorization: headers.has('Authorization'),
      hasDeviceHeader: headers.has('X-Device-UUID')
    })

    const behaviour = programmed.shift() ?? { kind: 'pass' as const }

    // Always let the request reach the server first. A lost acknowledgment is a lost *answer*,
    // never an unsent request — the server must really have committed.
    const response = await underlying(input as RequestInfo, init)

    if (behaviour.kind === 'pass') {
      return response
    }

    // Drain the real body so the connection is not left half-read.
    await response.text()

    if (behaviour.kind === 'lose-acknowledgment') {
      throw new TypeError('fetch failed')
    }

    if (behaviour.kind === 'transport-failure') {
      throw new TypeError(behaviour.message ?? 'fetch failed')
    }

    return new Response(JSON.stringify(behaviour.body), {
      status: behaviour.status,
      headers: { 'content-type': 'application/json' }
    })
  }) as typeof fetch

  return {
    fetchImplementation,
    requests,
    count: () => requests.length,
    uploadRequests: () => requests.filter((request) => request.pathname === UPLOAD_PATH),
    reset: () => {
      requests.length = 0
      programmed = []
    },
    program: (...behaviours) => {
      programmed = [...behaviours]
    },
    assertEveryRequestInDesktopNamespace: () => {
      for (const request of requests) {
        ok(
          request.pathname.startsWith(DESKTOP_PREFIX),
          `Outbound request escaped the desktop namespace: ${request.pathname}`
        )
        ok(!request.pathname.startsWith('/api/v1/admin'), 'admin namespace was contacted')
        ok(!request.pathname.startsWith('/api/v1/auth'), 'auth namespace was contacted')
        ok(!request.pathname.includes('..'), 'a traversal path was contacted')
        ok(!request.pathname.includes('batch'), 'a batch endpoint was contacted')
      }

      for (const request of requests.filter((r) => r.pathname.includes('invoice'))) {
        equal(request.pathname, UPLOAD_PATH)
        equal(request.method, 'POST')
      }
    }
  }
}
