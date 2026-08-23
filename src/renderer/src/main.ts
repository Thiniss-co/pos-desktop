import './assets/main.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './app/router'
import { configureSessionTransition } from './app/session/sessionTransition'
import { useStartupStore } from './app/startup/startup.store'
import { useAuthStore } from './modules/auth/store'
import { i18n } from './i18n'
import { applyLocaleToDocument, useLocaleStore } from './modules/preferences/locale.store'

const pinia = createPinia()

configureSessionTransition({
  refreshStartup: () => useStartupStore(pinia).refresh(),
  replaceLogin: () => router.replace({ name: 'login' }),
  setAuthMessage: (message) => useAuthStore(pinia).setSessionEndedMessage(message)
})

async function bootstrapRenderer(): Promise<void> {
  try {
    await useLocaleStore(pinia).initialize()
  } catch {
    applyLocaleToDocument('en')
  }

  createApp(App).use(pinia).use(i18n).use(router).mount('#app')
}

void bootstrapRenderer()
