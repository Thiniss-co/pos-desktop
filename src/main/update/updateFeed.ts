import { z } from 'zod'

const updateFeedSourceSchema = z
  .object({
    MAIN_VITE_POS_UPDATE_FEED_URL: z.string().trim().optional(),
    MAIN_VITE_POS_ALLOW_LOOPBACK_ORIGIN: z.string().trim().optional()
  })
  .passthrough()

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

/**
 * The update feed (electron-updater `generic` provider) is baked in at build time, like the API
 * origin. No URL → automatic updates are not configured (no default feed, never an invented one).
 * HTTPS only; a loopback HTTP feed is accepted solely in a test package built with the same opt-in
 * as the API origin (MAIN_VITE_POS_ALLOW_LOOPBACK_ORIGIN=true), for the isolated upgrade test.
 */
export function resolveUpdateFeed(environment: unknown = import.meta.env): URL | null {
  const source = updateFeedSourceSchema.parse(environment ?? {})
  const configured = source.MAIN_VITE_POS_UPDATE_FEED_URL

  if (!configured) {
    return null
  }

  let url: URL
  try {
    url = new URL(configured)
  } catch {
    return null
  }

  if (url.username || url.password || url.search || url.hash) {
    return null
  }

  if (url.protocol === 'https:') {
    return url
  }

  return url.protocol === 'http:' &&
    isLoopbackHost(url.hostname) &&
    source.MAIN_VITE_POS_ALLOW_LOOPBACK_ORIGIN === 'true'
    ? url
    : null
}
