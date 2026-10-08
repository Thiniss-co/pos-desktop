import { describe, expect, it } from 'vitest'
import { startupFailureMessage } from './startupFailure'

describe('startup failure message', () => {
  it('names the data folder, keeps the data, and gives a bounded reason in English and Arabic', () => {
    const message = startupFailureMessage(
      new Error('FOREIGN KEY constraint failed\n  at migration 0034'),
      'C:\\Users\\cashier\\AppData\\Roaming\\pos-desktop'
    )

    expect(message.title).toContain('Thinis POS could not start')
    expect(message.body).toContain('Do NOT delete or move this folder')
    expect(message.body).toContain('لا تحذف هذا المجلد')
    expect(message.body).toContain('C:\\Users\\cashier\\AppData\\Roaming\\pos-desktop')
    expect(message.body).toContain(
      'Reason / السبب: FOREIGN KEY constraint failed at migration 0034'
    )
  })

  it('never carries an unbounded reason', () => {
    const message = startupFailureMessage(new Error('x'.repeat(5000)), '/data')
    const reason = message.body.split('Reason / السبب: ')[1]

    expect(reason.length).toBe(300)
  })
})
