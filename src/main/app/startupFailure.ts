/**
 * When the till cannot start (most often: the local database cannot be upgraded because a stored row
 * is damaged), the cashier must see why, and must not "fix" it by deleting the data folder, which
 * would lose every sale and refund not yet uploaded. Main has no translations before the renderer
 * runs, so the message is bilingual (English, Arabic).
 *
 * Recovery procedure: docs/support/blocked-migration-recovery.md.
 */
export interface StartupFailureMessage {
  readonly title: string
  readonly body: string
}

const MAX_REASON_LENGTH = 300

export function startupFailureMessage(error: unknown, userDataPath: string): StartupFailureMessage {
  const reason = (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_REASON_LENGTH)

  return {
    title: 'Thinis POS could not start / تعذّر تشغيل Thinis POS',
    body: [
      'The till could not open its local data. Your sales and refunds are kept in the data folder below.',
      'Do NOT delete or move this folder. Close the till and contact support with this message.',
      '',
      'تعذّر على نقطة البيع فتح بياناتها المحلية. مبيعاتك ومرتجعاتك محفوظة في مجلد البيانات أدناه.',
      'لا تحذف هذا المجلد ولا تنقله. أغلق نقطة البيع وتواصل مع الدعم مع هذه الرسالة.',
      '',
      `Data folder / مجلد البيانات: ${userDataPath}`,
      `Reason / السبب: ${reason || 'unknown'}`
    ].join('\n')
  }
}
