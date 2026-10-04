import { ref, watch } from 'vue'
import { defineStore, type Pinia } from 'pinia'
import type { CompanyBrandingView } from '@shared/contracts/branding.contract'
import { useAuthStore } from '../auth/store'
import { brandDeclarations, isHexColor } from './brandTokens'

/**
 * Owner UX plan P9 — the company identity on the register: the name and verified logo for the top bar,
 * and the brand tokens (derived here with the shared algorithm) on the document root. Everything comes
 * from main through `branding:get`; nothing is kept in browser storage. Signing out, another company, or
 * no delivered brand restores the default palette and the "Thinis POS" brand.
 */
const BRAND_PROPERTIES = Object.keys(brandDeclarations('#000000'))
const EMPTY: CompanyBrandingView = { companyName: null, primaryColor: null, logoDataUrl: null }

export function applyBrandTokens(
  primaryColor: string | null,
  root: HTMLElement = document.documentElement
): void {
  for (const property of BRAND_PROPERTIES) {
    root.style.removeProperty(property)
  }
  if (primaryColor !== null && isHexColor(primaryColor)) {
    for (const [property, value] of Object.entries(brandDeclarations(primaryColor))) {
      root.style.setProperty(property, value)
    }
  }
}

export const useBrandingStore = defineStore('branding', () => {
  const view = ref<CompanyBrandingView>(EMPTY)
  let request = 0

  async function load(): Promise<void> {
    const current = ++request
    let next: CompanyBrandingView = EMPTY
    try {
      const result = await window.posApi?.branding?.get()
      next = result?.ok ? result.data : EMPTY
    } catch {
      next = EMPTY
    }
    if (current !== request) {
      return // a later load answered first; never let an older answer win
    }
    view.value = next
    applyBrandTokens(next.primaryColor)
  }

  function clear(): void {
    request += 1
    view.value = EMPTY
    applyBrandTokens(null)
  }

  return { view, load, clear }
})

/** Loads the identity at start, on every sign-in/sign-out, and whenever main says it changed. */
export function startBrandingClient(pinia: Pinia): void {
  if (typeof window === 'undefined' || !window.posApi?.branding) {
    return
  }
  const store = useBrandingStore(pinia)
  const auth = useAuthStore(pinia)
  watch(
    () => auth.session?.isAuthenticated ?? false,
    (signedIn) => {
      if (signedIn) {
        void store.load()
      } else {
        store.clear()
      }
    },
    { immediate: true }
  )
  window.posApi.branding.onChanged(() => {
    void store.load()
  })
}
