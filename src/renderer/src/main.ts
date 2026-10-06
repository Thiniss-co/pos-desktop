import './assets/main.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './app/router'
import { configureSessionTransition } from './app/session/sessionTransition'
import { configureDeviceTransition } from './app/session/deviceTransition'
import { useStartupStore } from './app/startup/startup.store'
import { useAuthStore } from './modules/auth/store'
import { useDeviceStore } from './modules/activation/store'
import { useCartStore } from './modules/pos/cart.store'
import { usePaymentStore } from './modules/pos/payment.store'
import { useCatalogStore } from './modules/pos/catalog.store'
import { i18n } from './i18n'
import { applyLocaleToDocument, useLocaleStore } from './modules/preferences/locale.store'
import { applyThemeToDocument, useThemeStore } from './modules/preferences/theme.store'
import { startCatalogInstallClient } from './modules/catalogInstall/installHold'
import { startBrandingClient } from './modules/branding/store'
import { startQuickCreateClient } from './modules/quickCreate/store'
import { startUserPreferencesClient } from './modules/preferences/userPreferences.store'
import { startWorkspaceLayoutClient } from './modules/preferences/posWorkspace.store'

const pinia = createPinia()

configureSessionTransition({
  refreshStartup: () => useStartupStore(pinia).refresh(),
  replaceLogin: () => router.replace({ name: 'login' }),
  setAuthMessage: (message) => {
    useCartStore(pinia).resetDraft('session-ended')
    usePaymentStore(pinia).resetPayment()
    useCatalogStore(pinia).resetCatalog()
    useAuthStore(pinia).setSessionEndedMessage(message)
  }
})

configureDeviceTransition({
  refreshStartup: () => useStartupStore(pinia).refresh(),
  replaceActivation: () => router.replace({ name: 'activation' }),
  setDeviceRecoveryMessage: () => {
    useCartStore(pinia).resetDraft('device-recovery')
    usePaymentStore(pinia).resetPayment()
    useCatalogStore(pinia).resetCatalog()
    useDeviceStore(pinia).setDeviceRecoveryMessage()
  }
})

async function bootstrapRenderer(): Promise<void> {
  try {
    await useLocaleStore(pinia).initialize()
  } catch {
    applyLocaleToDocument('en')
  }

  try {
    await useThemeStore(pinia).initialize()
  } catch {
    applyThemeToDocument('system')
  }

  createApp(App).use(pinia).use(i18n).use(router).mount('#app')
  // Rev 4 §8: the catalog-install hold client (draft reports, hold arming, apply-before-release).
  startCatalogInstallClient(pinia)
  // Owner UX plan P9: the company logo, name and brand colour (default brand when none).
  startBrandingClient(pinia)
  startQuickCreateClient(pinia)
  // POS improvements, Stage 5: per-user touch layout (and auto-print, Stage 7).
  startUserPreferencesClient(pinia)
  // POS workspace: the signed-in user's selling-screen layout on this workstation.
  startWorkspaceLayoutClient(pinia)
}

void bootstrapRenderer()
