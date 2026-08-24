// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { RouteLocationNormalized } from 'vue-router'
import { getStartupRouteName, startupGuard } from './guards'
import { useStartupStore } from '../startup/startup.store'

describe('startup route decisions', () => {
  it('maps every foundation startup state to a deterministic route', () => {
    expect(getStartupRouteName('needs_activation')).toBe('activation')
    expect(getStartupRouteName('needs_login')).toBe('login')
    expect(getStartupRouteName('needs_bootstrap')).toBe('bootstrap')
    expect(getStartupRouteName('ready')).toBe('pos')
    expect(getStartupRouteName('access_blocked')).toBe('access-blocked')
    expect(getStartupRouteName('fatal_error')).toBe('fatal-error')
  })
})

describe('startupGuard dev-only bypass', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  function devOnlyRoute(): RouteLocationNormalized {
    return { name: 'dev-gallery', meta: { devOnly: true } } as unknown as RouteLocationNormalized
  }

  it('allows a devOnly route without initializing startup, regardless of state', async () => {
    const startup = useStartupStore()
    expect(startup.isInitialized).toBe(false)

    const result = await startupGuard(devOnlyRoute())

    expect(result).toBe(true)
    // The whole point of the bypass is that a dev-only screen never depends on real startup
    // state — confirm the guard didn't even try to resolve it.
    expect(startup.isInitialized).toBe(false)
  })

  it('does not bypass a route that merely happens to lack devOnly', async () => {
    const route = {
      name: 'pos',
      meta: {}
    } as unknown as RouteLocationNormalized

    const result = await startupGuard(route)

    // With no startup state resolved yet this redirects to the deterministic starting route,
    // proving the normal guard path still runs when devOnly is absent.
    expect(result).not.toBe(true)
  })
})
