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
import { i18n } from './i18n'
import { applyLocaleToDocument, useLocaleStore } from './modules/preferences/locale.store'
import { applyThemeToDocument, useThemeStore } from './modules/preferences/theme.store'

const pinia = createPinia()

configureSessionTransition({
  refreshStartup: () => useStartupStore(pinia).refresh(),
  replaceLogin: () => router.replace({ name: 'login' }),
  setAuthMessage: (message) => useAuthStore(pinia).setSessionEndedMessage(message)
})

configureDeviceTransition({
  refreshStartup: () => useStartupStore(pinia).refresh(),
  replaceActivation: () => router.replace({ name: 'activation' }),
  setDeviceRecoveryMessage: () => useDeviceStore(pinia).setDeviceRecoveryMessage()
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
}

void bootstrapRenderer()
