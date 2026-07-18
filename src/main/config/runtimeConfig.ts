import { z } from 'zod'

const runtimeConfigSourceSchema = z
  .object({
    MAIN_VITE_POS_API_ORIGIN: z.string().trim().optional()
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

export function loadRuntimeConfig(environment: unknown = import.meta.env): RuntimeConfig {
  const source = runtimeConfigSourceSchema.parse(environment)
  const configuredOrigin = source.MAIN_VITE_POS_API_ORIGIN

  if (!configuredOrigin) {
    return {
      apiConfiguration: 'not_configured',
      apiOrigin: null
    }
  }

  return {
    apiConfiguration: 'configured',
    apiOrigin: normalizeApiOrigin(configuredOrigin)
  }
}
