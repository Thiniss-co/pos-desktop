/** Tone of a top-bar status pill (network, sync queue, shift). */
export type PillTone = 'ok' | 'warn' | 'err' | 'info' | 'neutral'

export const PILL_TONE_CLASS: Record<PillTone, string> = {
  ok: 'bg-ok-bg text-ok',
  warn: 'bg-warn-bg text-warn',
  err: 'bg-err-bg text-err',
  info: 'bg-info-bg text-info',
  neutral: 'border border-line bg-subtle text-muted'
}

export const PILL_TONE_TEXT: Record<PillTone, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  err: 'text-err',
  info: 'text-info',
  neutral: 'text-muted'
}
