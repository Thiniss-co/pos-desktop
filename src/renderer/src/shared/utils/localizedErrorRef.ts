import { computed, ref, type ComputedRef } from 'vue'
import type { PublicAppError } from '@shared/contracts/api.contract'
import { i18n } from '@renderer/i18n'
import { localizeAppError } from './localizeAppError'

/**
 * A store's displayed error text, kept reactive to the active locale.
 *
 * `localizeAppError` must be re-evaluated whenever `i18n.global.locale` changes, so a store must
 * never bake its result into a plain string ref at the moment an error occurs — that string
 * would stay in whatever language was active at that instant, even after the user switches
 * language. This holds the raw inputs (a backend error detail, a translation key, or a literal
 * already-localized message) and derives the displayed string with a computed ref instead.
 */
export interface LocalizedErrorRef {
  readonly error: ComputedRef<string | null>
  /** A backend error to localize via its stable `backendCode`/category. */
  setDetail(detail: PublicAppError): void
  /** A catalog key to translate for a case with no `PublicAppError` (e.g. a thrown non-API error). */
  setFallbackKey(key: string): void
  /** A message that is already final display text (e.g. handed in from elsewhere, pre-localized). */
  setMessage(message: string): void
  clear(): void
}

export function createLocalizedErrorRef(): LocalizedErrorRef {
  const detail = ref<PublicAppError | null>(null)
  const fallbackKey = ref<string | null>(null)
  const rawMessage = ref<string | null>(null)

  const error = computed<string | null>(() => {
    if (detail.value) {
      return localizeAppError(detail.value, i18n.global.t, i18n.global.te)
    }

    if (fallbackKey.value) {
      return String(i18n.global.t(fallbackKey.value))
    }

    return rawMessage.value
  })

  function setDetail(next: PublicAppError): void {
    detail.value = next
    fallbackKey.value = null
    rawMessage.value = null
  }

  function setFallbackKey(key: string): void {
    detail.value = null
    fallbackKey.value = key
    rawMessage.value = null
  }

  function setMessage(message: string): void {
    detail.value = null
    fallbackKey.value = null
    rawMessage.value = message
  }

  function clear(): void {
    detail.value = null
    fallbackKey.value = null
    rawMessage.value = null
  }

  return { error, setDetail, setFallbackKey, setMessage, clear }
}
