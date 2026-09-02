import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { PublicAppError } from '@shared/contracts/api.contract'
import { i18n } from '@renderer/i18n'
import { CatalogRendererService } from '@renderer/modules/pos/catalog.service'
import { localizeAppError } from '@renderer/shared/utils/localizeAppError'
import { parsePublicAppError } from '@renderer/shared/utils/parsePublicAppError'
import type { AccessDisplayState } from './types'

export const useAccessStore = defineStore('access', () => {
  // Holds only the raw backend error (or none). The displayed state below is a computed so the
  // message re-localizes if the user switches language after being blocked — it must never be
  // baked into a plain string at the moment the error occurs, and it must never be evaluated at
  // module scope, where the locale has not been resolved from app_settings yet.
  const detail = ref<PublicAppError | null>(null)
  const isRefreshing = ref(false)
  const lastValidatedAt = ref<string | null>(null)

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

  /**
   * The "refresh workstation data" recovery offered beside a blocking access message — most
   * importantly an overdue license, which is recoverable precisely by re-validating.
   *
   * Main owns the whole chain: it calls the license-validation endpoint, persists the returned
   * state and the *server-derived* validation timestamp, republishes the commercial-access
   * decision, and continues through session, bootstrap, catalog, and stock refresh. This action
   * sends nothing: it cannot supply `lastValidatedAt`, an entitlement, or any other authority.
   *
   * On success the returned access snapshot is applied immediately, so the warning disappears
   * without waiting for a pushed event or a second round trip. On failure the block is *retained*
   * and the real transport/business error replaces the message — a failed refresh never unblocks.
   */
  async function refreshWorkstation(service = new CatalogRendererService()): Promise<boolean> {
    if (isRefreshing.value) {
      return false
    }

    isRefreshing.value = true

    try {
      const result = await service.refresh()
      lastValidatedAt.value = result.licenseValidatedAt

      if (result.access.sell.allowed || result.access.sync.allowed) {
        detail.value = null
        return true
      }

      // Still denied: report the current reason honestly rather than clearing the block.
      return false
    } catch (cause) {
      const publicError = parsePublicAppError(cause)
      detail.value = publicError ?? detail.value
      return false
    } finally {
      isRefreshing.value = false
    }
  }

  return { state, isRefreshing, lastValidatedAt, setFromError, refreshWorkstation }
})
