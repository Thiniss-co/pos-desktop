import type { AutoPrintStatus } from '@shared/contracts/printing.contract'

export type AutoPrintChipTone = 'muted' | 'ok' | 'warn' | 'err'

export interface AutoPrintChip {
  readonly tone: AutoPrintChipTone
  readonly icon: 'print' | 'check_circle' | 'warning' | 'error' | 'help' | 'print_disabled'
  /** An i18n key under `printing.auto.chip`. */
  readonly key: string
  /** Whether the cashier should print this receipt manually. */
  readonly printManually: boolean
}

/**
 * POS improvements, Stage 7: what the sale-complete panel says about the automatic print. "Sent to
 * the printer" means the spooler accepted the job; it never claims that paper came out.
 */
export function autoPrintChip(status: AutoPrintStatus): AutoPrintChip {
  switch (status.state) {
    case 'off':
      return { tone: 'muted', icon: 'print_disabled', key: 'off', printManually: false }
    case 'pending':
      return { tone: 'muted', icon: 'print', key: 'preparing', printManually: false }
    case 'skipped_no_printer':
      return { tone: 'warn', icon: 'warning', key: 'noPrinter', printManually: true }
    case 'printer_missing':
      return { tone: 'warn', icon: 'warning', key: 'printerMissing', printManually: true }
    case 'settings_changed':
      return { tone: 'warn', icon: 'warning', key: 'settingsChanged', printManually: true }
    case 'expired_unprinted':
      return { tone: 'warn', icon: 'warning', key: 'expired', printManually: true }
    case 'admitted': {
      const job = status.job
      if (job === null || job.status === 'in_progress') {
        return { tone: 'muted', icon: 'print', key: 'printing', printManually: false }
      }
      if (job.status === 'submitted') {
        return { tone: 'ok', icon: 'check_circle', key: 'submitted', printManually: false }
      }
      if (job.status === 'outcome_unknown') {
        return { tone: 'warn', icon: 'help', key: 'unknown', printManually: false }
      }
      return { tone: 'err', icon: 'error', key: 'failed', printManually: true }
    }
  }
}

/** Whether polling can stop: the decision is made and any admitted job has finished. */
export function autoPrintSettled(status: AutoPrintStatus): boolean {
  if (status.state === 'pending') {
    return false
  }
  if (status.state === 'admitted') {
    return status.job !== null && status.job.status !== 'in_progress'
  }
  return true
}
