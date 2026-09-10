export interface DispositionDiscoveryTriggerDependencies {
  readonly run: () => Promise<void>
  /**
   * The floor between two runs. §7.3a.5 bounds discovery to startup, a debounced reconnect, and an
   * explicit request for at most the visible failure page.
   */
  readonly minimumIntervalMs: number
  readonly now?: () => number
  /**
   * Re-checked before EVERY run: sync access, the upload permission and a resolved owner. A run that
   * cannot legitimately reach the endpoint must not start at all (§7.3a.5).
   */
  readonly canRun?: () => boolean
}

export type DispositionDiscoveryTriggerSource = 'startup' | 'reconnect' | 'manual'

/**
 * PS6b §7.3a.5 — bounds how often disposition discovery may run.
 *
 * Two independent bounds, because they stop different things:
 *
 *  - an **in-flight lock**, so overlapping triggers coalesce into one run. A reconnect storm would
 *    otherwise turn a convergence step into a request loop;
 *  - a **minimum interval**, so a repeatedly-flapping connection cannot poll the endpoint.
 *
 * A refused request is dropped, not queued. Queuing would defer the same storm rather than absorb
 * it, and discovery is idempotent — the next legitimate trigger converges just as well.
 */
export class DispositionDiscoveryTrigger {
  private inFlight = false
  private lastRunAt: number | null = null

  constructor(private readonly dependencies: DispositionDiscoveryTriggerDependencies) {}

  async request(source: DispositionDiscoveryTriggerSource): Promise<void> {
    void source

    if (this.inFlight) {
      return
    }

    if (this.dependencies.canRun?.() === false) {
      return
    }

    const now = (this.dependencies.now ?? Date.now)()

    if (this.lastRunAt !== null && now - this.lastRunAt < this.dependencies.minimumIntervalMs) {
      return
    }

    this.inFlight = true
    this.lastRunAt = now

    try {
      await this.dependencies.run()
    } catch {
      // Swallowed deliberately: discovery is best-effort convergence, and a failed run must never
      // wedge the trigger or surface as an unhandled rejection. The lock is released in `finally`,
      // so the next legitimate trigger retries.
    } finally {
      this.inFlight = false
    }
  }
}
