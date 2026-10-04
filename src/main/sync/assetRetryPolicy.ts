/**
 * When a failed downloaded asset (a product image or the company logo) may be fetched again.
 *
 * - Bounded: at most `ASSET_RETRY_MAX_ATTEMPTS` failures; after that the asset is skipped until a newer
 *   reference names it again (the repositories reset `attempts` then).
 * - Spaced: after the n-th failure the next try waits `ASSET_RETRY_DELAYS_MS[n - 1]`, measured from the
 *   stored `last_attempt_at`, so the delay survives a restart.
 * - No timer: the policy is only consulted when a bootstrap (foreground or background) starts a sweep;
 *   an asset that is not due yet is simply left for a later bootstrap.
 * - Clock changes: a moved-forward clock can only make a try due earlier, and the attempt bound still
 *   caps the total. A stamp in the future (the clock moved back) is respected — the asset waits for the
 *   full delay after it — unless it is more than `ASSET_RETRY_UNTRUSTED_FUTURE_MS` ahead, or unreadable:
 *   such a stamp proves nothing, and honouring it could hide images until the clock caught up.
 */

/** Delay before the next try, indexed by failures so far minus one. */
export const ASSET_RETRY_DELAYS_MS: readonly number[] = [60_000, 5 * 60_000]

export const ASSET_RETRY_MAX_ATTEMPTS = ASSET_RETRY_DELAYS_MS.length + 1

export const ASSET_RETRY_UNTRUSTED_FUTURE_MS = 24 * 60 * 60 * 1000

export function isAssetRetryDue(
  attempts: number,
  lastAttemptAt: string | null,
  now: Date
): boolean {
  if (attempts <= 0) {
    return true
  }
  if (attempts >= ASSET_RETRY_MAX_ATTEMPTS) {
    return false
  }
  const last = lastAttemptAt === null ? Number.NaN : Date.parse(lastAttemptAt)
  const current = now.getTime()
  if (!Number.isFinite(last) || !Number.isFinite(current)) {
    return true
  }
  if (last - current > ASSET_RETRY_UNTRUSTED_FUTURE_MS) {
    return true
  }

  return current - last >= ASSET_RETRY_DELAYS_MS[attempts - 1]
}
