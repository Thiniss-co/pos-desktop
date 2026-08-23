import type { PublicAppError } from '@shared/contracts/api.contract'
import type { SessionSummary } from '@shared/contracts/auth.contract'
import type { BootstrapStatus } from '@shared/contracts/bootstrap.contract'
import type { DeviceIdentitySummary } from '@shared/contracts/device.contract'
import type { SyncStatus } from '@shared/contracts/sync.contract'
import type { RuntimeInfo } from '@shared/contracts/system.contract'

export const STARTUP_STATES = [
  'starting',
  'needs_activation',
  'needs_login',
  'needs_bootstrap',
  'ready',
  'access_blocked',
  'fatal_error'
] as const

export type StartupState = (typeof STARTUP_STATES)[number]

export interface StartupSnapshot {
  readonly runtime: RuntimeInfo
  readonly device: DeviceIdentitySummary
  readonly session: SessionSummary
  readonly bootstrap: BootstrapStatus
  readonly sync: SyncStatus
}

export interface StartupError {
  readonly message?: string
  readonly detail?: PublicAppError
}
