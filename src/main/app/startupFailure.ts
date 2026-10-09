/**
 * When the till cannot start (most often: the local database cannot be upgraded because a stored row
 * is damaged), the cashier must see why, and must not "fix" it by deleting the data folder, which
 * would lose every sale and refund not yet uploaded. Main has no translations before the renderer
 * runs, so the message is bilingual (English, Arabic). The numbered steps are the cashier's part of
 * the recovery procedure: docs/support/blocked-migration-recovery.md.
 */
export interface StartupFailureMessage {
  readonly title: string
  readonly body: string
}

const MAX_REASON_LENGTH = 300

export function startupFailureMessage(
  error: unknown,
  userDataPath: string,
  appVersion: string
): StartupFailureMessage {
  const reason = (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_REASON_LENGTH)

  return {
    title: 'Thinis POS could not start / تعذّر تشغيل Thinis POS',
    body: [
      'The till could not open its local data. Your sales and refunds are kept in the data folder below.',
      'Do NOT delete or move this folder, and do not reinstall or uninstall the till.',
      '1. Close the till.',
      '2. Copy the whole data folder (every file in it) to a USB drive or a support share.',
      '3. Send support the copy and this message (Ctrl+C copies it on Windows).',
      '',
      'تعذّر على نقطة البيع فتح بياناتها المحلية. مبيعاتك ومرتجعاتك محفوظة في مجلد البيانات أدناه.',
      'لا تحذف هذا المجلد ولا تنقله، ولا تُعِد تثبيت نقطة البيع ولا تُلغِ تثبيتها.',
      '١. أغلق نقطة البيع.',
      '٢. انسخ مجلد البيانات كاملًا (كل ملفاته) إلى ذاكرة USB أو مجلد الدعم.',
      '٣. أرسل النسخة وهذه الرسالة إلى الدعم (Ctrl+C ينسخها على Windows).',
      '',
      `Data folder / مجلد البيانات: ${userDataPath}`,
      `Version / الإصدار: ${appVersion}`,
      `Reason / السبب: ${reason || 'unknown'}`
    ].join('\n')
  }
}
