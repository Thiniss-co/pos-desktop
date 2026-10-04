import type {
  AutoPrintNotice,
  AutoPrintSetup,
  AutoPrintStatus,
  PrinterSettings
} from '@shared/contracts/printing.contract'
import { MAX_PRINTABLE_WIDTH_MM } from '@shared/contracts/printing.contract'
import { canonicalJson, sha256Hex } from '../services/localSale.fingerprint'
import type {
  AutoPrintIntentRow,
  AutoPrintOutcome,
  AutoPrintRepository
} from '../repositories/autoPrint.repository'
import type { LocalSaleRepository } from '../repositories/localSale.repository'
import type {
  PrintJobRow,
  ReceiptPrintJobRepository
} from '../repositories/receiptPrintJob.repository'
import type { UserPreferencesService } from '../services/userPreferences.service'
import type { PrinterSettingsService } from './printerSettings.service'
import type { ReceiptAccessService, ReceiptOwner } from './receiptAccess.service'
import {
  toView,
  type PreparedAutoJob,
  type ReceiptPrintingService
} from './receiptPrinting.service'

/** D5: an interrupted automatic print is still admitted for this long after the sale committed. */
export const AUTO_PRINT_ADMISSION_WINDOW_MS = 10 * 60 * 1000

/**
 * The printer settings an automatic print uses, frozen at commit. The manual dispatch mode and the
 * retired workstation auto-print flag are not part of it: automatic printing is always silent, and
 * the per-user preference alone decides whether an intent exists.
 */
export interface PrinterSnapshot {
  readonly printerName: string | null
  readonly paperWidthMm: 58 | 80
  readonly printableWidthMm: number
  readonly marginTopMm: number
  readonly marginBottomMm: number
  readonly pageLengthProfile: PrinterSettings['pageLengthProfile']
  readonly maxContinuousLengthMm: number
  readonly fixedPageHeightMm: number
  readonly defaultCopies: number
}

export function printerSnapshotOf(settings: PrinterSettings): {
  readonly snapshot: PrinterSnapshot
  readonly json: string
  readonly sha256: string
} {
  const snapshot: PrinterSnapshot = {
    printerName: settings.printerName,
    paperWidthMm: settings.paperWidthMm,
    printableWidthMm: Math.min(
      settings.printableWidthMm,
      MAX_PRINTABLE_WIDTH_MM[settings.paperWidthMm]
    ),
    marginTopMm: settings.marginTopMm,
    marginBottomMm: settings.marginBottomMm,
    pageLengthProfile: settings.pageLengthProfile,
    maxContinuousLengthMm: settings.maxContinuousLengthMm,
    fixedPageHeightMm: settings.fixedPageHeightMm,
    defaultCopies: settings.defaultCopies
  }
  const json = canonicalJson(snapshot)
  return { snapshot, json, sha256: sha256Hex(json) }
}

function settingsFromSnapshot(json: string): PrinterSettings {
  const snapshot = JSON.parse(json) as PrinterSnapshot
  return {
    ...snapshot,
    dispatchMode: 'direct',
    autoPrintAfterSale: false
  }
}

// ---------------------------------------------------------------------------------------------
// Intent capture (inside the sale-commit transaction)
// ---------------------------------------------------------------------------------------------

export interface AutoPrintIntentDependencies {
  readonly repository: Pick<AutoPrintRepository, 'available' | 'insertIntent'>
  readonly preferences: Pick<UserPreferencesService, 'autoPrintFor'>
  readonly printerSettings: Pick<PrinterSettingsService, 'get'>
  /** The register's UI language (`ui.locale`), used for the automatic receipt. */
  readonly locale: () => 'en' | 'ar'
}

/** POS improvements, Stage 7: records the immutable automatic-print intent of a committing sale. */
export class AutoPrintIntentService {
  constructor(private readonly dependencies: AutoPrintIntentDependencies) {}

  /** Runs inside the sale-commit transaction. Writes nothing when the selling user turned it off. */
  captureForSale(input: {
    readonly invoiceLocalUuid: string
    readonly companyUuid: string
    readonly deviceUuid: string
    readonly userUuid: string
    readonly committedAt: string
  }): void {
    if (!this.dependencies.repository.available()) {
      return
    }
    const owner = { companyUuid: input.companyUuid, userUuid: input.userUuid }
    if (!this.dependencies.preferences.autoPrintFor(owner)) {
      return
    }
    const printer = printerSnapshotOf(this.dependencies.printerSettings.get())
    this.dependencies.repository.insertIntent({
      invoiceLocalUuid: input.invoiceLocalUuid,
      companyUuid: input.companyUuid,
      deviceUuid: input.deviceUuid,
      userUuid: input.userUuid,
      committedAt: input.committedAt,
      locale: this.dependencies.locale(),
      printerSnapshotJson: printer.json,
      printerSnapshotSha256: printer.sha256,
      setupStateAtCommit: printer.snapshot.printerName === null ? 'no_printer' : 'configured'
    })
  }
}

// ---------------------------------------------------------------------------------------------
// Admission (after commit, at sign-in and at startup)
// ---------------------------------------------------------------------------------------------

export type AutoPrintTrigger = 'commit' | 'session' | 'startup'

export interface AutoPrintDecision {
  readonly invoiceLocalUuid: string
  readonly outcome: AutoPrintOutcome
  readonly jobUuid: string | null
}

export interface AutoPrintAdmissionDependencies {
  readonly repository: Pick<
    AutoPrintRepository,
    'available' | 'pendingFor' | 'admission' | 'intent' | 'insertAdmission' | 'immediate'
  >
  readonly access: Pick<ReceiptAccessService, 'resolveCaller' | 'assertSaleDocument'>
  readonly printing: Pick<
    ReceiptPrintingService,
    'listPrinters' | 'prepareAutoJob' | 'claimAutoJob' | 'runAdmittedAutoJob'
  >
  readonly printerSettings: Pick<PrinterSettingsService, 'get'>
  readonly preferences: Pick<UserPreferencesService, 'current'>
  readonly localSale: Pick<LocalSaleRepository, 'findInvoiceByLocalUuid'>
  readonly jobs: Pick<ReceiptPrintJobRepository, 'findByJobUuid'>
  readonly now?: () => Date
  readonly windowMs?: number
  /** Test builds only (virtual print boundary): while true, admission does not run at all. */
  readonly admissionHeld?: () => boolean
  /** Unit and SQLite tests only: a fault between the job insert and the admission insert. */
  readonly afterJobInsert?: () => void
}

class AdmissionRolledBack extends Error {}

/**
 * POS improvements, Stage 7: decides each pending intent of the signed-in owner exactly once.
 *
 * Rules, in order: another owner (or no `pos.view`) writes nothing and leaves the intent pending;
 * no printer at commit → `skipped_no_printer`; older than the window (D5) → `expired_unprinted`;
 * current settings differ from the snapshot → `settings_changed`; the snapshot's printer is not
 * installed → `printer_missing`; otherwise the AUTO job and the `admitted` row are inserted in one
 * `BEGIN IMMEDIATE` transaction. Only then does preparation start, then the fence and dispatch.
 */
export class AutoPrintAdmissionService {
  private readonly now: () => Date
  private readonly windowMs: number
  private running: Promise<AutoPrintDecision[]> | null = null
  private runAgain: AutoPrintTrigger | null = null
  private notices: { ownerKey: string; items: AutoPrintNotice[] } = { ownerKey: '', items: [] }

  constructor(private readonly dependencies: AutoPrintAdmissionDependencies) {
    this.now = dependencies.now ?? (() => new Date())
    this.windowMs = dependencies.windowMs ?? AUTO_PRINT_ADMISSION_WINDOW_MS
  }

  /**
   * Single-flight: a call while a run is in progress schedules exactly one more run, so a sale that
   * commits during a sign-in recovery is still decided. Never throws.
   */
  admitPending(trigger: AutoPrintTrigger): Promise<AutoPrintDecision[]> {
    if (this.running) {
      this.runAgain = trigger
      return this.running
    }
    const run = (async (): Promise<AutoPrintDecision[]> => {
      const decisions: AutoPrintDecision[] = []
      let current: AutoPrintTrigger | null = trigger
      while (current !== null) {
        this.runAgain = null
        decisions.push(...(await this.runOnce(current).catch(() => [])))
        current = this.runAgain
      }
      return decisions
    })()
    this.running = run
    void run.finally(() => {
      this.running = null
    })
    return run
  }

  private async runOnce(trigger: AutoPrintTrigger): Promise<AutoPrintDecision[]> {
    if (!this.dependencies.repository.available() || this.dependencies.admissionHeld?.()) {
      return []
    }
    let owner: ReceiptOwner
    try {
      owner = this.dependencies.access.resolveCaller()
    } catch {
      return [] // signed out, or no pos.view: nothing is decided
    }
    const pending = this.dependencies.repository.pendingFor(owner)
    if (pending.length === 0) {
      return []
    }

    // Asynchronous pre-check first; the decision itself is synchronous, inside the transaction.
    // Only an intent that had a printer at commit can need the installed list.
    let installed: readonly string[] | null = []
    if (pending.some((intent) => intent.setupStateAtCommit === 'configured')) {
      try {
        installed = (await this.dependencies.printing.listPrinters()).map((p) => p.name)
      } catch {
        installed = null
      }
    }

    const decisions: AutoPrintDecision[] = []
    for (const intent of pending) {
      try {
        const decided = this.decide(intent, installed)
        if (decided === null) {
          continue
        }
        decisions.push(decided.decision)
        if (decided.admitted) {
          void this.dependencies.printing
            .runAdmittedAutoJob(
              decided.admitted.job,
              decided.admitted.owner,
              decided.admitted.prepared
            )
            .catch(() => undefined)
        } else if (trigger !== 'commit') {
          this.recordNotice(owner, intent, decided.decision.outcome)
        }
      } catch {
        // Rolled back: no job and no admission row. The intent stays pending and is decided by a
        // later trigger (at the latest it expires).
      }
    }
    return decisions
  }

  private decide(
    intent: AutoPrintIntentRow,
    installed: readonly string[] | null
  ): {
    decision: AutoPrintDecision
    admitted: { job: PrintJobRow; owner: ReceiptOwner; prepared: PreparedAutoJob } | null
  } | null {
    const { repository } = this.dependencies
    return repository.immediate(() => {
      if (repository.admission(intent.invoiceLocalUuid) !== null) {
        return null // another run decided it first
      }
      let fresh: ReceiptOwner
      try {
        fresh = this.dependencies.access.resolveCaller()
      } catch {
        return null
      }
      if (
        fresh.companyUuid !== intent.companyUuid ||
        fresh.deviceUuid !== intent.deviceUuid ||
        fresh.userUuid !== intent.userUuid
      ) {
        return null // never decided for, or shown to, another owner
      }

      const now = this.now()
      const decidedAt = now.toISOString()
      const snapshot = settingsFromSnapshot(intent.printerSnapshotJson)
      let outcome: AutoPrintOutcome
      if (intent.setupStateAtCommit === 'no_printer') {
        outcome = 'skipped_no_printer'
      } else if (now.getTime() - Date.parse(intent.committedAt) > this.windowMs) {
        outcome = 'expired_unprinted'
      } else if (
        printerSnapshotOf(this.dependencies.printerSettings.get()).sha256 !==
        intent.printerSnapshotSha256
      ) {
        outcome = 'settings_changed'
      } else if (installed === null) {
        return null // the printer list is unavailable right now: decide later
      } else if (snapshot.printerName === null || !installed.includes(snapshot.printerName)) {
        outcome = 'printer_missing'
      } else {
        outcome = 'admitted'
      }

      if (outcome !== 'admitted') {
        repository.insertAdmission({
          invoiceLocalUuid: intent.invoiceLocalUuid,
          jobUuid: null,
          outcome,
          admittedSessionEpoch: null,
          decidedAt
        })
        return {
          decision: { invoiceLocalUuid: intent.invoiceLocalUuid, outcome, jobUuid: null },
          admitted: null
        }
      }

      const prepared = this.dependencies.printing.prepareAutoJob(fresh, {
        invoiceLocalUuid: intent.invoiceLocalUuid,
        locale: intent.locale,
        settings: snapshot
      })
      const job = this.dependencies.printing.claimAutoJob(prepared)
      if (job === null) {
        throw new AdmissionRolledBack('an AUTO job already exists for this sale')
      }
      this.dependencies.afterJobInsert?.()
      repository.insertAdmission({
        invoiceLocalUuid: intent.invoiceLocalUuid,
        jobUuid: job.jobUuid,
        outcome: 'admitted',
        admittedSessionEpoch: fresh.sessionEpoch,
        decidedAt
      })
      return {
        decision: {
          invoiceLocalUuid: intent.invoiceLocalUuid,
          outcome: 'admitted',
          jobUuid: job.jobUuid
        },
        admitted: { job, owner: fresh, prepared }
      }
    })
  }

  /** The automatic-print state of one sale of the caller's register. */
  statusForSale(owner: ReceiptOwner, invoiceLocalUuid: string): AutoPrintStatus {
    this.dependencies.access.assertSaleDocument(
      owner,
      this.dependencies.localSale.findInvoiceByLocalUuid(invoiceLocalUuid)
    )
    const intent = this.dependencies.repository.intent(invoiceLocalUuid)
    if (intent === null || intent.userUuid !== owner.userUuid) {
      return { state: 'off', job: null }
    }
    const admission = this.dependencies.repository.admission(invoiceLocalUuid)
    if (admission === null) {
      return { state: 'pending', job: null }
    }
    if (admission.outcome !== 'admitted' || admission.jobUuid === null) {
      return { state: admission.outcome, job: null }
    }
    const job = this.dependencies.jobs.findByJobUuid(admission.jobUuid)
    return { state: 'admitted', job: job ? toView(job) : null }
  }

  /** Whether the signed-in user's automatic printing can reach a printer on this register. */
  async setup(): Promise<AutoPrintSetup> {
    const autoPrint = this.dependencies.preferences.current().autoPrint
    const printerName = this.dependencies.printerSettings.get().printerName
    if (!autoPrint) {
      return { autoPrint, printerName, needsSetup: 'none' }
    }
    if (printerName === null) {
      return { autoPrint, printerName, needsSetup: 'no_printer' }
    }
    let installed: readonly string[] = []
    try {
      installed = (await this.dependencies.printing.listPrinters()).map((printer) => printer.name)
    } catch {
      installed = []
    }
    return {
      autoPrint,
      printerName,
      needsSetup: installed.includes(printerName) ? 'none' : 'printer_missing'
    }
  }

  /** Earlier sales that recovery (sign-in or startup) decided not to print, for the signed-in owner. */
  noticesFor(owner: ReceiptOwner): AutoPrintNotice[] {
    return this.notices.ownerKey === ownerKey(owner) ? [...this.notices.items] : []
  }

  dismissNotices(owner: ReceiptOwner): void {
    if (this.notices.ownerKey === ownerKey(owner)) {
      this.notices = { ownerKey: '', items: [] }
    }
  }

  private recordNotice(
    owner: ReceiptOwner,
    intent: AutoPrintIntentRow,
    outcome: AutoPrintOutcome
  ): void {
    if (outcome === 'admitted') {
      return
    }
    const key = ownerKey(owner)
    if (this.notices.ownerKey !== key) {
      this.notices = { ownerKey: key, items: [] }
    }
    const invoice = this.dependencies.localSale.findInvoiceByLocalUuid(intent.invoiceLocalUuid)
    this.notices.items.push({
      invoiceLocalUuid: intent.invoiceLocalUuid,
      receiptNumber: invoice?.offlineNumber ?? '',
      outcome,
      decidedAt: this.now().toISOString()
    })
  }
}

function ownerKey(owner: ReceiptOwner): string {
  return `${owner.companyUuid}|${owner.deviceUuid}|${owner.userUuid}|${owner.sessionEpoch}`
}
