import { randomUUID } from 'node:crypto'
import type {
  DraftState,
  InstallHoldReply,
  InstallHoldState,
  InstallPath
} from '@shared/contracts/catalogInstall.contract'

/**
 * Rev 4 §8 — the catalog-install lifecycle, owned by main.
 *
 * Every bootstrap installs a NEW catalog revision (the server hashes `generated_at`/`valid_until`
 * into it), which supersedes an editable cart and any payment claimed under the old revision. So a
 * downloaded snapshot is persisted only through a HOLD:
 *
 *   requested → held → installing → installed | aborted        (requested | held → aborted)
 *
 *  1. `acquire()` (after the fetch, before persisting) sends `catalog:install-hold` to every app
 *     window. The renderer arms its hold SYNCHRONOUSLY — adds, scans, recalls and checkout claims
 *     wait — and replies whether it was admitted for this path, with its draft generation.
 *  2. `beforeWrite()` runs as the first statement INSIDE the persist transaction (main is
 *     single-threaded and SQLite synchronous, so nothing can interleave between it and the writes):
 *     the hold deadline, every acked generation, the gating-claim and in-flight checks. It moves the
 *     hold to `installing`.
 *  3. `settle()` records `installed`/`aborted` and pushes `catalog:install-release`. A lost push is
 *     recovered by the renderer's status polling; only main's terminal state releases a hold, and
 *     the renderer applies the new contract BEFORE releasing queued actions.
 *
 * Paths: `background` (renewal; needs an idle draft), `manual` (header refresh; human consent was
 * given BEFORE this handshake and is bound to a draft generation), `stale` (the installed catalog is
 * missing or expired, so nothing can be sold anyway: admission is unconditional and missing replies
 * do not block).
 */

export class InstallDeferredError extends Error {
  readonly code = 'install-deferred'

  constructor(readonly reason: 'busy' | 'payment-active' | 'draft-changed' | 'expired') {
    super(`Catalog install deferred: ${reason}`)
    this.name = 'InstallDeferredError'
  }
}

interface DraftEntry extends DraftState {
  readonly reportedAtMono: number
}

interface Hold {
  readonly id: string
  readonly path: InstallPath
  readonly consentGeneration: number | null
  readonly targets: readonly number[]
  readonly replies: Map<number, InstallHoldReply>
  state: InstallHoldState
  deadlineMono: number
  settledAtMono: number | null
}

export interface CatalogInstallGateDependencies {
  readonly appWindowIds: () => readonly number[]
  readonly send: (webContentsId: number, channel: 'hold' | 'release', payload: unknown) => void
  /** A claimed attempt an install would newly supersede (its revision is the installed, valid one). */
  readonly hasGatingClaim: () => boolean
  readonly completionInFlight: () => boolean
  /** The installed catalog is missing or past its own validity window. */
  readonly catalogNeedsInstall: () => boolean
  readonly monotonicNow?: () => number
  readonly createId?: () => string
  readonly replyTimeoutMs?: number
  readonly holdDeadlineMs?: number
  readonly onHoldChanged?: () => void
  readonly log?: (line: string) => void
}

const OUTCOME_RETENTION_MS = 5 * 60_000

export class CatalogInstallGate {
  private readonly registry = new Map<number, DraftEntry>()
  private readonly holds = new Map<string, Hold>()
  private readonly replyWaiters = new Map<string, () => void>()
  private active: Hold | null = null
  private context: { path: InstallPath; consentGeneration: number | null } | null = null

  constructor(private readonly dependencies: CatalogInstallGateDependencies) {}

  private mono(): number {
    return (this.dependencies.monotonicNow ?? (() => performance.now()))()
  }

  // --- draft registry --------------------------------------------------------------------------

  reportDraftState(webContentsId: number, state: DraftState): void {
    this.registry.set(webContentsId, { ...state, reportedAtMono: this.mono() })
  }

  /** A window reloaded, navigated or went away: it is busy until it reports again. */
  forgetWindow(webContentsId: number): void {
    this.registry.delete(webContentsId)
  }

  draftIdle(): boolean {
    const windows = this.dependencies.appWindowIds()
    if (windows.length === 0) {
      return false
    }
    return windows.every((id) => {
      const entry = this.registry.get(id)
      return (
        entry !== undefined &&
        !entry.hasLines &&
        !entry.hasHeldDrafts &&
        !entry.paymentActive &&
        !entry.completionPending
      )
    })
  }

  /** Background pre-fetch check: never download a snapshot that could not be installed now. */
  canStartBackgroundInstall(): boolean {
    return (
      this.draftIdle() &&
      !this.dependencies.hasGatingClaim() &&
      !this.dependencies.completionInFlight()
    )
  }

  // --- install context --------------------------------------------------------------------------

  /** Runs `fn` (which performs the bootstrap) with an explicit install path. */
  async withPath<T>(
    path: InstallPath,
    consentGeneration: number | null,
    fn: () => Promise<T>
  ): Promise<T> {
    const previous = this.context
    this.context = { path, consentGeneration }
    try {
      return await fn()
    } finally {
      this.context = previous
    }
  }

  private resolvePath(): { path: InstallPath; consentGeneration: number | null } {
    if (this.dependencies.catalogNeedsInstall()) {
      return { path: 'stale', consentGeneration: null }
    }
    return this.context ?? { path: 'background', consentGeneration: null }
  }

  /** A claimed attempt the install would supersede, or a completion in flight (manual refusal). */
  paymentActive(): boolean {
    return this.dependencies.hasGatingClaim() || this.dependencies.completionInFlight()
  }

  isHoldActive(): boolean {
    return (
      this.active !== null && (this.active.state === 'held' || this.active.state === 'installing')
    )
  }

  // --- the handshake ----------------------------------------------------------------------------

  /** Step 1 — after the fetch and parse, before any write. Throws `InstallDeferredError`. */
  async acquire(): Promise<void> {
    const { path, consentGeneration } = this.resolvePath()

    if (path !== 'stale') {
      if (this.dependencies.hasGatingClaim() || this.dependencies.completionInFlight()) {
        throw new InstallDeferredError('payment-active')
      }
    }

    const targets = this.dependencies.appWindowIds()
    if (path === 'background' && !this.draftIdle()) {
      throw new InstallDeferredError('busy')
    }
    if (path !== 'stale' && targets.some((id) => !this.registry.has(id))) {
      throw new InstallDeferredError('busy')
    }

    const hold: Hold = {
      id: (this.dependencies.createId ?? randomUUID)(),
      path,
      consentGeneration,
      targets,
      replies: new Map(),
      state: 'requested',
      deadlineMono: Number.POSITIVE_INFINITY,
      settledAtMono: null
    }
    this.holds.set(hold.id, hold)
    this.active = hold
    this.pruneOutcomes()

    const allReplied = new Promise<void>((resolve) => {
      this.replyWaiters.set(hold.id, resolve)
    })
    for (const id of targets) {
      this.dependencies.send(id, 'hold', { holdId: hold.id, path, consentGeneration })
    }
    if (targets.length > 0) {
      await Promise.race([
        allReplied,
        new Promise((resolve) => setTimeout(resolve, this.dependencies.replyTimeoutMs ?? 1000))
      ])
    }
    this.replyWaiters.delete(hold.id)

    if (hold.state !== 'requested') {
      // Aborted while waiting (a window went away).
      throw new InstallDeferredError('busy')
    }

    if (path !== 'stale') {
      for (const id of targets) {
        const reply = hold.replies.get(id)
        if (!reply) {
          this.settle(false)
          throw new InstallDeferredError('busy')
        }
        if (!reply.admitted) {
          this.settle(false)
          throw new InstallDeferredError(path === 'manual' ? 'draft-changed' : 'busy')
        }
      }
    }

    hold.state = 'held'
    hold.deadlineMono = this.mono() + (this.dependencies.holdDeadlineMs ?? 2500)
    this.dependencies.onHoldChanged?.()
  }

  reply(webContentsId: number, reply: InstallHoldReply): void {
    const hold = this.holds.get(reply.holdId)
    if (!hold || hold.state !== 'requested' || !hold.targets.includes(webContentsId)) {
      return
    }
    hold.replies.set(webContentsId, reply)
    if (hold.targets.every((id) => hold.replies.has(id))) {
      this.replyWaiters.get(hold.id)?.()
    }
  }

  /**
   * Step 2 — the FIRST statement inside the persist transaction. Synchronous: the hold cannot
   * expire, and no claim or draft report can be processed, between this check and the writes.
   */
  beforeWrite(): void {
    const hold = this.active
    if (!hold || hold.state !== 'held') {
      // A persist with no hold at all is only legitimate when nothing can be sold anyway.
      if (this.dependencies.catalogNeedsInstall()) {
        return
      }
      throw new InstallDeferredError('busy')
    }

    if (this.mono() > hold.deadlineMono) {
      throw new InstallDeferredError('expired')
    }

    if (hold.path !== 'stale') {
      if (this.dependencies.hasGatingClaim() || this.dependencies.completionInFlight()) {
        throw new InstallDeferredError('payment-active')
      }
      for (const id of hold.targets) {
        const acked = hold.replies.get(id)?.generation
        const current = this.registry.get(id)?.generation
        if (acked === undefined || current === undefined || acked !== current) {
          throw new InstallDeferredError(hold.path === 'manual' ? 'draft-changed' : 'busy')
        }
      }
      if (
        hold.path === 'manual' &&
        hold.consentGeneration !== null &&
        hold.targets.some((id) => {
          const entry = this.registry.get(id)
          return (
            entry !== undefined && entry.hasLines && entry.generation !== hold.consentGeneration
          )
        })
      ) {
        throw new InstallDeferredError('draft-changed')
      }
    }

    hold.state = 'installing'
  }

  /** Step 3 — record the terminal state and push the release (polling recovers a lost push). */
  settle(installed: boolean, reason?: string): void {
    const hold = this.active
    if (!hold) {
      return
    }
    hold.state = installed ? 'installed' : 'aborted'
    hold.settledAtMono = this.mono()
    this.active = null
    for (const id of hold.targets) {
      this.dependencies.send(id, 'release', { holdId: hold.id, installed })
    }
    this.dependencies.onHoldChanged?.()
    this.dependencies.log?.(
      `[pos-install] hold ${hold.path} ${hold.state}${reason ? ` reason=${reason}` : ''}`
    )
  }

  status(holdId: string): InstallHoldState {
    return this.holds.get(holdId)?.state ?? 'unknown'
  }

  private pruneOutcomes(): void {
    const now = this.mono()
    for (const [id, hold] of this.holds) {
      if (hold.settledAtMono !== null && now - hold.settledAtMono > OUTCOME_RETENTION_MS) {
        this.holds.delete(id)
      }
    }
  }
}
