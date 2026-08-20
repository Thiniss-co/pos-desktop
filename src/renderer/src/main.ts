import './assets/main.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './app/router'
import { configureSessionTransition } from './app/session/sessionTransition'
import { useStartupStore } from './app/startup/startup.store'
import { useAuthStore } from './modules/auth/store'

const pinia = createPinia()

configureSessionTransition({
  refreshStartup: () => useStartupStore(pinia).refresh(),
  replaceLogin: () => router.replace({ name: 'login' }),
  setAuthMessage: (message) => useAuthStore(pinia).setSessionEndedMessage(message)
})

createApp(App).use(pinia).use(router).mount('#app')
