import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { PublicAppError } from '@shared/contracts/api.contract'
import { i18n } from '@renderer/i18n'
import { localizeAppError } from '@renderer/shared/utils/localizeAppError'
import type { AccessDisplayState } from './types'

export const useAccessStore = defineStore('access', () => {
  // Holds only the raw backend error (or none). The displayed state below is a computed so the
  // message re-localizes if the user switches language after being blocked — it must never be
  // baked into a plain string at the moment the error occurs, and it must never be evaluated at
  // module scope, where the locale has not been resolved from app_settings yet.
  const detail = ref<PublicAppError | null>(null)

  const state = computed<AccessDisplayState>(() =>
    detail.value
      ? {
          category: detail.value.category,
          message: localizeAppError(detail.value, i18n.global.t, i18n.global.te),
          traceId: detail.value.traceId ?? null
        }
      : {
          category: 'authorization',
          message: String(i18n.global.t('access.defaultMessage')),
          traceId: null
        }
  )

  function setFromError(error?: PublicAppError): void {
    detail.value = error ?? null
  }

  return { state, setFromError }
})
