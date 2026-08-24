import type { CommercialAccessAction } from '@shared/contracts/license.contract'

type DeviceActionAccess = Readonly<Record<CommercialAccessAction, boolean>>

/**
 * The desktop mirror of the backend device-status matrix. Status values are persisted as received
 * from bootstrap; an unknown or absent value deliberately has no entry and therefore fails closed.
 */
export const DEVICE_STATUS_ACCESS = Object.freeze({
  active: { sell: true, sync: true },
  blocked_login: { sell: false, sync: false },
  blocked_selling: { sell: false, sync: true },
  blocked_sync: { sell: true, sync: false },
  revoked: { sell: false, sync: false },
  retired: { sell: false, sync: false }
} as const satisfies Record<string, DeviceActionAccess>)

export function isTerminalDeviceStatus(status: string): boolean {
  return status === 'revoked' || status === 'retired'
}

export function canDevicePerformAction(status: string, action: CommercialAccessAction): boolean {
  return DEVICE_STATUS_ACCESS[status]?.[action] ?? false
}
