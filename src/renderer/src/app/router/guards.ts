import type { RouteLocationNormalized, RouteLocationRaw } from 'vue-router'
import type { StartupState } from '../startup/types'
import { useStartupStore } from '../startup/startup.store'

const startupRoutes: Record<StartupState, string> = {
  starting: 'root',
  needs_activation: 'activation',
  needs_login: 'login',
  needs_bootstrap: 'bootstrap',
  ready: 'pos',
  access_blocked: 'access-blocked',
  fatal_error: 'fatal-error'
}

export function getStartupRouteName(state: StartupState): string {
  return startupRoutes[state]
}

function canAccessRoute(state: StartupState, routeName: string | null | undefined): boolean {
  if (routeName === 'not-found') {
    return true
  }

  if (state === 'ready') {
    return routeName === 'pos' || routeName === 'sync' || routeName === 'settings'
  }

  return routeName === getStartupRouteName(state)
}

export async function startupGuard(to: RouteLocationNormalized): Promise<true | RouteLocationRaw> {
  const startup = useStartupStore()

  if (!startup.isInitialized) {
    await startup.initialize()
  }

  if (canAccessRoute(startup.state, typeof to.name === 'string' ? to.name : undefined)) {
    return true
  }

  return { name: getStartupRouteName(startup.state) }
}
