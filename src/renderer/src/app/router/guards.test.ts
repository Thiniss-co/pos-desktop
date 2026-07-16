import { describe, expect, it } from 'vitest'
import { getStartupRouteName } from './guards'

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
