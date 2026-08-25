import type { PublicAppError } from '@shared/contracts/api.contract'

export type Translate = (key: string, params?: Record<string, string>) => string
export type TranslateExists = (key: string) => boolean

export function localizeAppError(error: PublicAppError, t: Translate, te: TranslateExists): string {
  let message: string

  if (error.backendCode) {
    const backendKey = 'errors.' + error.backendCode
    message = te(backendKey) ? t(backendKey) : error.message.trim() || t('errors.generic')
  } else if (error.category === 'transport') {
    message = t('errors.transport')
  } else if (error.category === 'configuration') {
    message = t('errors.configuration')
  } else {
    message = error.message.trim() || t('errors.generic')
  }

  return error.traceId
    ? `${message} ${t('startup.reference', { traceId: error.traceId })}`
    : message
}
