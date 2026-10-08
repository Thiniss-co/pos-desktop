import type {
  RestartBlocker,
  UpdatePhase,
  UpdateRestartResult,
  UpdateStatus
} from '@shared/contracts/update.contract'

/** The slice of electron-updater's AppUpdater this service drives (a fake in tests). */
export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowDowngrade: boolean
  on(event: string, listener: (...args: never[]) => void): unknown
  checkForUpdates(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export interface UpdateServiceDependencies {
  /** null when this build has no update feed (no URL was configured at build time). */
  readonly updater: UpdaterLike | null
  readonly currentVersion: string
  readonly isOnline: () => boolean
  /** What a restart would interrupt right now. */
  readonly restartBlockers: () => RestartBlocker[]
  readonly onStatus: (status: UpdateStatus) => void
  readonly now?: () => Date
  readonly schedule?: (callback: () => void, delayMs: number) => () => void
  readonly log?: (line: string) => void
  readonly startupDelayMs?: number
  readonly intervalMs?: number
}

const STARTUP_DELAY_MS = 30_000
const INTERVAL_MS = 4 * 60 * 60 * 1000
const OFFLINE_RETRY_MS = 5 * 60 * 1000
/** Bounded backoff after a failed check or download: 1, 5, 15 minutes, then hourly. */
export const UPDATE_RETRY_DELAYS_MS = [60_000, 300_000, 900_000, 3_600_000] as const

function defaultSchedule(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs)
  return () => clearTimeout(timer)
}

/** A short, stable code for the status; the full error stays in the main log. */
function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Za-z0-9_:-]{1,64}$/.test(code) ? code : 'UPDATE_FAILED'
}

/**
 * Background update checks and downloads, and the only door to installing one: an explicit restart
 * the cashier asks for, refused while a restart would interrupt work (a sale or payment on screen, a
 * checkout, refund, print or upload in flight, a catalog install). Queued offline sales, refunds and
 * quick-create requests are durable and simply continue after the upgrade, so they never block it.
 * Nothing is ever installed on quit and nothing restarts on its own.
 */
export class UpdateService {
  private phase: UpdatePhase
  private availableVersion: string | null = null
  private percent: number | null = null
  private lastCheckedAt: string | null = null
  private nextCheckAt: string | null = null
  private errorCode: string | null = null
  private failures = 0
  private cancelTimer: (() => void) | null = null
  private stopped = false
  private readonly now: () => Date
  private readonly schedule: (callback: () => void, delayMs: number) => () => void

  constructor(private readonly dependencies: UpdateServiceDependencies) {
    this.now = dependencies.now ?? ((): Date => new Date())
    this.schedule = dependencies.schedule ?? defaultSchedule
    this.phase = dependencies.updater ? 'idle' : 'not_configured'
  }

  start(): void {
    const updater = this.dependencies.updater
    if (!updater) {
      this.publish()
      return
    }
    // Download in the background; install only through restartToInstall().
    updater.autoDownload = true
    updater.autoInstallOnAppQuit = false
    updater.allowDowngrade = false
    updater.on('checking-for-update', () => this.set('checking'))
    updater.on('update-not-available', () => {
      this.availableVersion = null
      this.percent = null
      this.succeeded()
      this.set('idle')
      this.scheduleNext()
    })
    updater.on('update-available', (info: { version?: string }) => {
      this.availableVersion = info?.version ?? null
      this.percent = 0
      this.set('downloading')
    })
    updater.on('download-progress', (progress: { percent?: number }) => {
      const percent = Number(progress?.percent)
      this.percent = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : this.percent
      this.publish()
    })
    updater.on('update-downloaded', (info: { version?: string }) => {
      this.availableVersion = info?.version ?? this.availableVersion
      this.percent = 100
      this.succeeded()
      this.set('ready')
    })
    updater.on('error', (error: unknown) => this.failed(error))
    this.publish()
    this.scheduleNext(this.dependencies.startupDelayMs ?? STARTUP_DELAY_MS)
  }

  stop(): void {
    this.stopped = true
    this.cancelTimer?.()
    this.cancelTimer = null
  }

  status(): UpdateStatus {
    return {
      phase: this.phase,
      currentVersion: this.dependencies.currentVersion,
      availableVersion: this.availableVersion,
      percent: this.percent === null ? null : Math.round(this.percent),
      lastCheckedAt: this.lastCheckedAt,
      nextCheckAt: this.nextCheckAt,
      errorCode: this.errorCode,
      blockers: this.phase === 'ready' ? this.dependencies.restartBlockers() : []
    }
  }

  /** A check now (Settings); a no-op while one runs or an update is already downloaded. */
  async checkNow(): Promise<UpdateStatus> {
    if (this.dependencies.updater && !['checking', 'downloading', 'ready'].includes(this.phase)) {
      await this.check()
    }
    return this.status()
  }

  /**
   * The cashier's explicit restart. Refused (nothing happens) while any blocker is present; then the
   * application quits through its normal shutdown (workers stop, the database closes) and the
   * installer runs and starts the new version.
   */
  restartToInstall(): UpdateRestartResult {
    const updater = this.dependencies.updater
    if (!updater || this.phase !== 'ready') {
      return { restarting: false, blockers: [] }
    }
    const blockers = this.dependencies.restartBlockers()
    if (blockers.length > 0) {
      this.publish()
      return { restarting: false, blockers }
    }
    this.dependencies.log?.('update-restart-authorized')
    this.stop()
    updater.quitAndInstall(true, true)
    return { restarting: true, blockers: [] }
  }

  private async check(): Promise<void> {
    const updater = this.dependencies.updater
    if (!updater || this.stopped) return
    if (!this.dependencies.isOnline()) {
      this.scheduleNext(OFFLINE_RETRY_MS)
      return
    }
    this.lastCheckedAt = this.now().toISOString()
    try {
      await updater.checkForUpdates()
      // A download continues (or waits for a restart); an error has already scheduled its retry.
      if (!['downloading', 'ready', 'error'].includes(this.phase)) this.scheduleNext()
    } catch (error) {
      this.failed(error)
    }
  }

  private succeeded(): void {
    this.failures = 0
    this.errorCode = null
  }

  private failed(error: unknown): void {
    this.errorCode = errorCodeOf(error)
    this.dependencies.log?.(`update-error ${this.errorCode}`)
    const delay = UPDATE_RETRY_DELAYS_MS[Math.min(this.failures, UPDATE_RETRY_DELAYS_MS.length - 1)]
    this.failures += 1
    this.set('error')
    this.scheduleNext(delay)
  }

  private scheduleNext(delayMs: number = this.dependencies.intervalMs ?? INTERVAL_MS): void {
    if (this.stopped) return
    this.cancelTimer?.()
    this.nextCheckAt = new Date(this.now().getTime() + delayMs).toISOString()
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = null
      void this.check()
    }, delayMs)
    this.publish()
  }

  private set(phase: UpdatePhase): void {
    this.phase = phase
    this.publish()
  }

  private publish(): void {
    this.dependencies.onStatus(this.status())
  }
}
