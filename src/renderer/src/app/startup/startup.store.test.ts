import { describe, expect, it } from 'vitest'
import { determineStartupState } from './startup.store'
import type { StartupSnapshot } from './types'

const baseSnapshot: StartupSnapshot = {
  runtime: {
    appVersion: '1.0.0',
    electronVersion: '30.0.0',
    chromeVersion: '124.0.0',
    nodeVersion: '20.0.0',
    platform: 'linux',
    apiConfiguration: 'configured'
  },
  device: {
    deviceUuid: '00000000-0000-4000-8000-000000000004',
    deviceName: 'Front Register',
    platform: 'linux',
    osVersion: '6.0',
    appVersion: '1.0.0',
    isRegistered: false
  },
  session: { isAuthenticated: false, userName: null, userEmail: null },
  bootstrap: { isComplete: false, updatedAt: null },
  sync: {
    state: 'idle',
    pausedReason: null,
    counts: { pending: 0, uploading: 0, retryableError: 0, conflict: 0, rejected: 0 }
  }
}

describe('determineStartupState', () => {
  it('requires activation before anything else', () => {
    expect(determineStartupState(baseSnapshot)).toBe('needs_activation')
  })

  it('requires login once the device is registered but no session exists', () => {
    expect(
      determineStartupState({
        ...baseSnapshot,
        device: { ...baseSnapshot.device, isRegistered: true }
      })
    ).toBe('needs_login')
  })

  it('requires bootstrap once authenticated but the local snapshot is incomplete', () => {
    expect(
      determineStartupState({
        ...baseSnapshot,
        device: { ...baseSnapshot.device, isRegistered: true },
        session: { isAuthenticated: true, userName: 'Cashier One', userEmail: 'c@e.test' }
      })
    ).toBe('needs_bootstrap')
  })

  it('is ready once activated, authenticated, and bootstrapped', () => {
    expect(
      determineStartupState({
        ...baseSnapshot,
        device: { ...baseSnapshot.device, isRegistered: true },
        session: { isAuthenticated: true, userName: 'Cashier One', userEmail: 'c@e.test' },
        bootstrap: { isComplete: true, updatedAt: '2026-01-01T00:00:00Z' }
      })
    ).toBe('ready')
  })
})
