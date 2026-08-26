import { LICENSE_TRUSTED_TIME_ANCHOR_KEY } from '../repositories/licenseMetadata.repository'

const CLOCK_ROLLBACK_TOLERANCE_MS = 60_000
const CATALOG_TRUSTED_TIME_HIGH_WATER_KEY = 'catalog.trusted_time_high_water'

export interface CatalogClockSettings {
  get(key: string): string | null
  set(key: string, value: string): void
}

export interface CatalogTrustedTime {
  readonly now: Date
  readonly rollbackDetected: boolean
}

export interface CatalogTrustedClock {
  now(): CatalogTrustedTime | null
}

function timestamp(value: string | null): number | null {
  if (!value) {
    return null
  }

  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Extends the Phase 3A license anchor with a persisted catalog high-water mark. A wall-clock
 * rollback therefore cannot make an already stale catalog appear valid after a restart.
 */
export class CatalogTrustedClockService {
  constructor(
    private readonly settings: CatalogClockSettings,
    private readonly wallClock: () => Date = () => new Date()
  ) {}

  now(): CatalogTrustedTime | null {
    const wallTime = this.wallClock().getTime()
    const licenseAnchor = timestamp(this.settings.get(LICENSE_TRUSTED_TIME_ANCHOR_KEY))
    const catalogHighWater = timestamp(this.settings.get(CATALOG_TRUSTED_TIME_HIGH_WATER_KEY))

    if (!Number.isFinite(wallTime) || licenseAnchor === null) {
      return null
    }

    const floor = Math.max(licenseAnchor, catalogHighWater ?? Number.NEGATIVE_INFINITY)
    const rollbackDetected = wallTime < floor - CLOCK_ROLLBACK_TOLERANCE_MS
    const trustedTime = Math.max(wallTime, floor)

    if (catalogHighWater === null || trustedTime > catalogHighWater) {
      this.settings.set(CATALOG_TRUSTED_TIME_HIGH_WATER_KEY, new Date(trustedTime).toISOString())
    }

    return { now: new Date(trustedTime), rollbackDetected }
  }
}
