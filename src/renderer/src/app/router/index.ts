import { createRouter, createWebHashHistory } from 'vue-router'
import { startupGuard } from './guards'
import { routes } from './routes'

export const router = createRouter({
  history: createWebHashHistory(),
  routes
})

router.beforeEach(startupGuard)
