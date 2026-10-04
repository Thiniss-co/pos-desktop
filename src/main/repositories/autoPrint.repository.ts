import type { SqliteDatabase } from '../database/connection'

export type AutoPrintSetupState = 'configured' | 'no_printer'
export type AutoPrintOutcome =
  'admitted' | 'skipped_no_printer' | 'printer_missing' | 'settings_changed' | 'expired_unprinted'

export interface AutoPrintIntentRow {
  readonly invoiceLocalUuid: string
  readonly companyUuid: string
  readonly deviceUuid: string
  readonly userUuid: string
  readonly committedAt: string
  readonly locale: 'en' | 'ar'
  readonly printerSnapshotJson: string
  readonly printerSnapshotSha256: string
  readonly setupStateAtCommit: AutoPrintSetupState
}

export interface AutoPrintAdmissionRow {
  readonly invoiceLocalUuid: string
  readonly jobUuid: string | null
  readonly outcome: AutoPrintOutcome
  readonly admittedSessionEpoch: number | null
  readonly decidedAt: string
}

export interface AutoPrintOwner {
  readonly companyUuid: string
  readonly deviceUuid: string
  readonly userUuid: string
}

interface IntentDbRow {
  invoice_local_uuid: string
  company_uuid: string
  device_uuid: string
  user_uuid: string
  committed_at: string
  locale: 'en' | 'ar'
  printer_snapshot_json: string
  printer_snapshot_sha256: string
  setup_state_at_commit: AutoPrintSetupState
}

interface AdmissionDbRow {
  invoice_local_uuid: string
  job_uuid: string | null
  outcome: AutoPrintOutcome
  admitted_session_epoch: number | null
  decided_at: string
}

function toIntent(row: IntentDbRow): AutoPrintIntentRow {
  return {
    invoiceLocalUuid: row.invoice_local_uuid,
    companyUuid: row.company_uuid,
    deviceUuid: row.device_uuid,
    userUuid: row.user_uuid,
    committedAt: row.committed_at,
    locale: row.locale,
    printerSnapshotJson: row.printer_snapshot_json,
    printerSnapshotSha256: row.printer_snapshot_sha256,
    setupStateAtCommit: row.setup_state_at_commit
  }
}

function toAdmission(row: AdmissionDbRow): AutoPrintAdmissionRow {
  return {
    invoiceLocalUuid: row.invoice_local_uuid,
    jobUuid: row.job_uuid,
    outcome: row.outcome,
    admittedSessionEpoch: row.admitted_session_epoch,
    decidedAt: row.decided_at
  }
}

/** POS improvements, Stage 7: automatic-print intents and their one admission each (0025). */
export class AutoPrintRepository {
  private tables: boolean | null = null

  constructor(private readonly database: SqliteDatabase) {}

  /** False on a pre-0025 schema (migration suites read through older schemas). */
  available(): boolean {
    if (this.tables === null) {
      this.tables =
        this.database
          .prepare(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('auto_print_intents', 'auto_print_admissions')"
          )
          .pluck()
          .get() === 2
    }
    return this.tables
  }

  /** Caller owns the transaction (the sale commit). */
  insertIntent(intent: AutoPrintIntentRow): void {
    this.database
      .prepare(
        `INSERT INTO auto_print_intents
           (invoice_local_uuid, company_uuid, device_uuid, user_uuid, committed_at, locale,
            printer_snapshot_json, printer_snapshot_sha256, setup_state_at_commit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        intent.invoiceLocalUuid,
        intent.companyUuid,
        intent.deviceUuid,
        intent.userUuid,
        intent.committedAt,
        intent.locale,
        intent.printerSnapshotJson,
        intent.printerSnapshotSha256,
        intent.setupStateAtCommit
      )
  }

  intent(invoiceLocalUuid: string): AutoPrintIntentRow | null {
    if (!this.available()) {
      return null
    }
    const row = this.database
      .prepare('SELECT * FROM auto_print_intents WHERE invoice_local_uuid = ?')
      .get(invoiceLocalUuid) as IntentDbRow | undefined
    return row ? toIntent(row) : null
  }

  admission(invoiceLocalUuid: string): AutoPrintAdmissionRow | null {
    if (!this.available()) {
      return null
    }
    const row = this.database
      .prepare('SELECT * FROM auto_print_admissions WHERE invoice_local_uuid = ?')
      .get(invoiceLocalUuid) as AdmissionDbRow | undefined
    return row ? toAdmission(row) : null
  }

  /** The owner's intents without an admission row, oldest first. Other owners' intents stay invisible. */
  pendingFor(owner: AutoPrintOwner): AutoPrintIntentRow[] {
    if (!this.available()) {
      return []
    }
    const rows = this.database
      .prepare(
        `SELECT i.* FROM auto_print_intents i
          WHERE i.company_uuid = ? AND i.device_uuid = ? AND i.user_uuid = ?
            AND NOT EXISTS (SELECT 1 FROM auto_print_admissions a
                             WHERE a.invoice_local_uuid = i.invoice_local_uuid)
          ORDER BY i.committed_at, i.invoice_local_uuid`
      )
      .all(owner.companyUuid, owner.deviceUuid, owner.userUuid) as IntentDbRow[]
    return rows.map(toIntent)
  }

  /** Insert-once; the primary key makes a second decision for the same intent fail. Caller owns the transaction. */
  insertAdmission(admission: AutoPrintAdmissionRow): void {
    this.database
      .prepare(
        `INSERT INTO auto_print_admissions
           (invoice_local_uuid, job_uuid, outcome, admitted_session_epoch, decided_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        admission.invoiceLocalUuid,
        admission.jobUuid,
        admission.outcome,
        admission.admittedSessionEpoch,
        admission.decidedAt
      )
  }

  /** Runs `work` in one `BEGIN IMMEDIATE` transaction: it all commits, or none of it does. */
  immediate<T>(work: () => T): T {
    return this.database.transaction(work).immediate()
  }
}
