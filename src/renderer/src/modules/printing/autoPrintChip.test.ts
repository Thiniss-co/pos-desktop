import { describe, expect, it } from 'vitest'
import type { AutoPrintStatus, PrintJobView } from '@shared/contracts/printing.contract'
import { autoPrintChip, autoPrintSettled } from './autoPrintChip'

function job(status: PrintJobView['status']): PrintJobView {
  return {
    jobUuid: '00000000-0000-4000-8000-000000000001',
    status,
    phase: status === 'in_progress' ? 'preparing' : null,
    failureCode: status === 'failed_before_dispatch' ? 'RECEIPT_QR_INVALID' : null,
    cancelOrigin: null,
    createdAt: '2026-10-04T12:00:00Z',
    dispatchedAt: null,
    finishedAt: null,
    isReprint: false
  }
}

describe('autoPrintChip', () => {
  it.each<[string, AutoPrintStatus, string, boolean, boolean]>([
    ['off', { state: 'off', job: null }, 'off', false, true],
    ['pending', { state: 'pending', job: null }, 'preparing', false, false],
    [
      'admitted, preparing',
      { state: 'admitted', job: job('in_progress') },
      'printing',
      false,
      false
    ],
    ['admitted, submitted', { state: 'admitted', job: job('submitted') }, 'submitted', false, true],
    [
      'admitted, the printer never confirmed',
      { state: 'admitted', job: job('outcome_unknown') },
      'unknown',
      false,
      true
    ],
    [
      'admitted, refused before dispatch',
      { state: 'admitted', job: job('failed_before_dispatch') },
      'failed',
      true,
      true
    ],
    ['no printer at the sale', { state: 'skipped_no_printer', job: null }, 'noPrinter', true, true],
    [
      'printer not connected',
      { state: 'printer_missing', job: null },
      'printerMissing',
      true,
      true
    ],
    ['settings changed', { state: 'settings_changed', job: null }, 'settingsChanged', true, true],
    ['too late', { state: 'expired_unprinted', job: null }, 'expired', true, true]
  ])('%s', (_label, status, key, printManually, settled) => {
    expect(autoPrintChip(status)).toMatchObject({ key, printManually })
    expect(autoPrintSettled(status)).toBe(settled)
  })

  it('never offers a manual print for a receipt whose outcome is unknown (no automatic resend either)', () => {
    expect(autoPrintChip({ state: 'admitted', job: job('outcome_unknown') }).printManually).toBe(
      false
    )
  })
})
