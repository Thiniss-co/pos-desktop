import type { UpdateVerification } from '@shared/contracts/update.contract'

/**
 * How a Windows update is trusted. electron-updater checks every download against the SHA-512 in
 * the feed's metadata, and on Windows ALSO compares the installer's Authenticode signature with the
 * publisher recorded at build time (`publisherName` in resources/app-update.yml) — but only when that
 * name is present: an unsigned build records none, and electron-updater then skips the signature check
 * silently. The checksum comes from the same feed as the installer, so it proves integrity, not origin.
 *
 * Policy: a Windows till accepts automatic updates only when its own build records a publisher, so the
 * signature check always runs. The single exception is an internal test build pointed at an explicitly
 * opted-in loopback test feed (MAIN_VITE_POS_ALLOW_LOOPBACK_ORIGIN=true, see updateFeed.ts): its
 * updates are checksum-only and reported as such. Other platforms are not V1 targets; their updater
 * (AppImage) has no publisher check, so they are checksum-only and reported as such.
 */

/** `publisherName` from electron-builder's app-update.yml: a scalar or a block list of names. */
export function readUpdaterPublisherNames(appUpdateYml: string | null): string[] {
  if (!appUpdateYml) return []
  const lines = appUpdateYml.split(/\r?\n/)
  const index = lines.findIndex((line) => /^publisherName:/.test(line))
  if (index === -1) return []
  const unquote = (value: string): string =>
    value
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2')
      .trim()
  const inline = unquote(lines[index].slice('publisherName:'.length))
  if (inline.startsWith('[') && inline.endsWith(']')) {
    return inline
      .slice(1, -1)
      .split(',')
      .map(unquote)
      .filter((name) => name.length > 0)
  }
  if (inline.length > 0) return [inline]
  const names: string[] = []
  for (const line of lines.slice(index + 1)) {
    const item = /^\s+-\s+(.*)$/.exec(line)
    if (!item) break
    const name = unquote(item[1])
    if (name.length > 0) names.push(name)
  }
  return names
}

export type UpdateSigningDecision =
  | { readonly allowed: true; readonly verification: UpdateVerification }
  | { readonly allowed: false; readonly reason: 'UNSIGNED_BUILD' }

export function decideUpdateSigning(input: {
  readonly platform: NodeJS.Platform
  readonly feed: URL
  readonly publisherNames: readonly string[]
}): UpdateSigningDecision {
  if (input.platform !== 'win32') {
    return { allowed: true, verification: 'checksum_only' }
  }
  if (input.publisherNames.length > 0) {
    return { allowed: true, verification: 'publisher_signature' }
  }
  // updateFeed.ts accepts an http feed only on loopback and only in a test build that opted in.
  if (input.feed.protocol === 'http:') {
    return { allowed: true, verification: 'checksum_only_test_build' }
  }
  return { allowed: false, reason: 'UNSIGNED_BUILD' }
}
