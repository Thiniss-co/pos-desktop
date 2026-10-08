import { z } from 'zod'

const runtimeConfigSourceSchema = z
  .object({
    MAIN_VITE_POS_API_ORIGIN: z.string().trim().optional(),
    MAIN_VITE_POS_ALLOW_LOOPBACK_ORIGIN: z.string().trim().optional()
  })
  .passthrough()

export interface RuntimeConfig {
  readonly apiConfiguration: 'configured' | 'not_configured'
  readonly apiOrigin: URL | null
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

function normalizeApiOrigin(value: string): URL {
  let url: URL

  try {
    url = new URL(value)
  } catch {
    throw new Error('MAIN_VITE_POS_API_ORIGIN must be an absolute URL')
  }

  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('MAIN_VITE_POS_API_ORIGIN must contain only an origin')
  }

  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new Error('MAIN_VITE_POS_API_ORIGIN must use HTTPS unless it targets a loopback host')
  }

  return new URL(url.origin)
}

export interface RuntimeConfigOptions {
  /** `app.isPackaged`: a packaged till only talks to an HTTPS origin unless the build opted in. */
  readonly packaged?: boolean
}

const NOT_CONFIGURED: RuntimeConfig = { apiConfiguration: 'not_configured', apiOrigin: null }

export function loadRuntimeConfig(
  environment: unknown = import.meta.env,
  options: RuntimeConfigOptions = {}
): RuntimeConfig {
  const source = runtimeConfigSourceSchema.parse(environment)
  const configuredOrigin = source.MAIN_VITE_POS_API_ORIGIN

  if (!configuredOrigin) {
    return NOT_CONFIGURED
  }

  const apiOrigin = normalizeApiOrigin(configuredOrigin)

  // The loopback HTTP origin is a development convenience (the tracked `.env`). A packaged till
  // built without an HTTPS origin must not send credentials in cleartext to whatever holds that
  // local port: it reports the honest not-configured state instead. Only a test package, built with
  // MAIN_VITE_POS_ALLOW_LOOPBACK_ORIGIN=true against a disposable local backend, may use it.
  if (
    options.packaged === true &&
    apiOrigin.protocol === 'http:' &&
    source.MAIN_VITE_POS_ALLOW_LOOPBACK_ORIGIN !== 'true'
  ) {
    return NOT_CONFIGURED
  }

  return { apiConfiguration: 'configured', apiOrigin }
}
