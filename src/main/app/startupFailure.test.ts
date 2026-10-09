import { describe, expect, it } from 'vitest'
import { startupFailureMessage } from './startupFailure'

describe('startup failure message', () => {
  it('names the data folder, keeps the data, and gives a bounded reason in English and Arabic', () => {
    const message = startupFailureMessage(
      new Error('FOREIGN KEY constraint failed\n  at migration 0034'),
      'C:\\Users\\cashier\\AppData\\Roaming\\pos-desktop',
      '1.0.1'
    )

    expect(message.title).toContain('Thinis POS could not start')
    expect(message.body).toContain('Do NOT delete or move this folder')
    expect(message.body).toContain('لا تحذف هذا المجلد')
    expect(message.body).toContain('C:\\Users\\cashier\\AppData\\Roaming\\pos-desktop')
    expect(message.body).toContain('Version / الإصدار: 1.0.1')
    expect(message.body).toContain(
      'Reason / السبب: FOREIGN KEY constraint failed at migration 0034'
    )
  })

  it("gives the cashier's recovery steps from the support procedure, in both languages", () => {
    const { body } = startupFailureMessage(new Error('x'), '/data', '1.0.0')

    expect(body).toContain('do not reinstall or uninstall the till')
    expect(body).toContain('1. Close the till.')
    expect(body).toContain('2. Copy the whole data folder (every file in it)')
    expect(body).toContain('3. Send support the copy and this message')
    expect(body).toContain('١. أغلق نقطة البيع.')
    expect(body).toContain('٢. انسخ مجلد البيانات كاملًا')
    expect(body).toContain('٣. أرسل النسخة وهذه الرسالة إلى الدعم')
  })

  it('never carries an unbounded reason', () => {
    const message = startupFailureMessage(new Error('x'.repeat(5000)), '/data', '1.0.0')
    const reason = message.body.split('Reason / السبب: ')[1]

    expect(reason.length).toBe(300)
  })
})
