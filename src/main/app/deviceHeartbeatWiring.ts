import { createHash } from 'node:crypto'
import { powerMonitor } from 'electron'
import type { DesktopApiRoute } from '@shared/constants/apiRoutes'
import type { ConnectivitySnapshot } from '@shared/contracts/connectivity.contract'
import type {
  CommercialAccessAction,
  CommercialAccessDecision
} from '@shared/contracts/license.contract'
import type { DesktopApiResponse } from '../http/desktopApiClient'
import {
  DeviceHeartbeatService,
  type DeviceHeartbeatDependencies,
  type DeviceHeartbeatSessionContext
} from '../services/deviceHeartbeat.service'
import { DESKTOP_ACCESS_TOKEN_KEY } from '../services/session.service'

/**
 * Production wiring for the device heartbeat. Electron is imported here and only here, so the
 * service itself stays a plain, unit-testable class.
 */

export interface HeartbeatSessionBinding {
  readonly isAuthenticated: boolean
  readonly userUuid: string | null
  readonly userIsActive: boolean
  readonly companyUuid: string | null
  readonly deviceUuid: string | null
  readonly serverDeviceId: string | null
}

/**
 * Everything the access fingerprint is computed from. Each reader is injectable so the digest can
 * be exercised without a database.
 */
export interface AccessFingerprintSources {
  readonly sessionEpoch: () => number
  readonly sessionBinding: () => HeartbeatSessionBinding | null
  readonly deviceStatus: () => string | null
  readonly permissions: () => readonly string[]
  readonly decision: (
    action: CommercialAccessAction
  ) => Pick<CommercialAccessDecision, 'allowed' | 'reason' | 'restrictionLevel'>
}

function fingerprintDecision(
  decision: Pick<CommercialAccessDecision, 'allowed' | 'reason' | 'restrictionLevel'>
): { allowed: boolean; reason: string | null; restrictionLevel: string | null } {
  // Connectivity is the last check `CommercialAccessService.evaluate()` makes, so this reason means
  // every access check passed. A connectivity flip is not an access change and must not look like
  // one; `evaluatedAt`, warnings and countdowns are excluded for the same reason.
  if (decision.reason === 'connectivity-unavailable') {
    return { allowed: true, reason: null, restrictionLevel: decision.restrictionLevel ?? null }
  }

  return {
    allowed: decision.allowed,
    reason: decision.reason ?? null,
    restrictionLevel: decision.restrictionLevel ?? null
  }
}

/**
 * A SHA-256 digest of the inputs that decide whether this device/user may act: the session epoch,
 * the user/company/device binding, the registered device status, the bootstrap permission list and
 * the current sell/sync access decisions. It is compared for equality only — it is never sent,
 * logged or persisted.
 */
export function buildAccessFingerprint(sources: AccessFingerprintSources): string {
  const binding = sources.sessionBinding()
  const material = JSON.stringify({
    v: 1,
    epoch: sources.sessionEpoch(),
    binding: binding
      ? {
          authenticated: binding.isAuthenticated,
          user: binding.userUuid,
          userActive: binding.userIsActive,
          company: binding.companyUuid,
          device: binding.deviceUuid,
          serverDevice: binding.serverDeviceId
        }
      : null,
    deviceStatus: sources.deviceStatus(),
    permissions: [...new Set(sources.permissions())].sort(),
    sell: fingerprintDecision(sources.decision('sell')),
    sync: fingerprintDecision(sources.decision('sync'))
  })

  return createHash('sha256').update(material).digest('hex')
}

export interface PowerMonitorLike {
  on(event: 'suspend' | 'resume', listener: () => void): unknown
  off(event: 'suspend' | 'resume', listener: () => void): unknown
}

export interface DeviceHeartbeatWiringDependencies {
  readonly apiClient: {
    requestWithMeta<T>(route: DesktopApiRoute): Promise<DesktopApiResponse<T>>
  }
  readonly session: { getContext(): HeartbeatSessionBinding }
  readonly sessionEpoch: { current(): number }
  readonly secrets: { getSecret(key: string): string | null }
  /** Read-only: must not create an identity as a side effect. */
  readonly deviceIdentity: { get(): { readonly deviceUuid: string } | null }
  readonly permissions: { getPermissions(): readonly string[] }
  readonly deviceRegistration: { get(): { readonly status: string } | null }
  readonly commercialAccess: {
    evaluate(
      action: CommercialAccessAction
    ): Pick<CommercialAccessDecision, 'allowed' | 'reason' | 'restrictionLevel'>
  }
  readonly accessPublisher: { onPublished(listener: () => void): () => void }
  /** Defaults to Electron's `powerMonitor`. */
  readonly powerMonitor?: PowerMonitorLike
  readonly log?: (line: string) => void
  /** Test seams for the service's clock, randomness and timers. */
  readonly timing?: Pick<DeviceHeartbeatDependencies, 'nowMs' | 'random' | 'scheduler'>
}

export interface DeviceHeartbeatHandle {
  readonly service: DeviceHeartbeatService
  /** Subscribes to power/access signals and reconciles with the current session. Idempotent. */
  start(): void
  /** Call from `SessionService`'s `onChanged`. */
  notifySessionChanged(): void
  /** Call from the connectivity service's `onChange`; acts only on a transition into `online`. */
  notifyConnectivity(snapshot: Pick<ConnectivitySnapshot, 'status'>): void
  /** Unsubscribes everything and stops the service (clears its timer, ignores late responses). */
  dispose(): void
}

export function createDeviceHeartbeat(
  deps: DeviceHeartbeatWiringDependencies
): DeviceHeartbeatHandle {
  const readSession = (): DeviceHeartbeatSessionContext => {
    const context = deps.session.getContext()

    return {
      authenticated: context.isAuthenticated,
      hasDeviceUuid: Boolean(deps.deviceIdentity.get()?.deviceUuid),
      hasToken: Boolean(deps.secrets.getSecret(DESKTOP_ACCESS_TOKEN_KEY)),
      sessionEpoch: deps.sessionEpoch.current()
    }
  }

  const fingerprintSources: AccessFingerprintSources = {
    sessionEpoch: () => deps.sessionEpoch.current(),
    sessionBinding: () => deps.session.getContext(),
    deviceStatus: () => deps.deviceRegistration.get()?.status ?? null,
    permissions: () => deps.permissions.getPermissions(),
    decision: (action) => deps.commercialAccess.evaluate(action)
  }

  const service = new DeviceHeartbeatService({
    request: (route) => deps.apiClient.requestWithMeta<unknown>(route),
    readSession,
    accessFingerprint: () => buildAccessFingerprint(fingerprintSources),
    log: deps.log,
    ...deps.timing
  })

  const monitor: PowerMonitorLike = deps.powerMonitor ?? powerMonitor
  const onSuspend = (): void => service.suspend()
  const onResume = (): void => service.resume()
  let unsubscribeAccess: (() => void) | null = null
  let lastConnectivityStatus: ConnectivitySnapshot['status'] | null = null
  let started = false
  let disposed = false

  return {
    service,
    start() {
      if (started || disposed) {
        return
      }

      started = true
      monitor.on('suspend', onSuspend)
      monitor.on('resume', onResume)
      unsubscribeAccess = deps.accessPublisher.onPublished(() => service.onAccessSignal())
      service.sync()
    },
    notifySessionChanged() {
      if (!started || disposed) {
        return
      }

      service.sync()
    },
    notifyConnectivity(snapshot) {
      const previous = lastConnectivityStatus
      lastConnectivityStatus = snapshot.status

      if (!started || disposed || snapshot.status !== 'online' || previous === 'online') {
        return
      }

      service.requestEarlyProbe('connectivity-online')
    },
    dispose() {
      if (disposed) {
        return
      }

      disposed = true

      if (started) {
        monitor.off('suspend', onSuspend)
        monitor.off('resume', onResume)
      }

      unsubscribeAccess?.()
      unsubscribeAccess = null
      service.stop()
    }
  }
}
