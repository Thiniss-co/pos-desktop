import type { PublicAppError } from '@shared/contracts/api.contract'

export type Translate = (key: string) => string
export type TranslateExists = (key: string) => boolean

export function localizeAppError(error: PublicAppError, t: Translate, te: TranslateExists): string {
  if (error.backendCode) {
    const backendKey = 'errors.' + error.backendCode

    return te(backendKey) ? t(backendKey) : t('errors.generic')
  }

  if (error.category === 'transport') {
    return t('errors.transport')
  }

  if (error.category === 'configuration') {
    return t('errors.configuration')
  }

  return error.message.trim() || t('errors.generic')
}
