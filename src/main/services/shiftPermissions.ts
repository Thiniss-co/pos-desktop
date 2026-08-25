import { publicAppErrorSchema } from '@shared/contracts/api.contract'

export const SHIFT_PERMISSIONS = ['shifts.view', 'shifts.manage'] as const

export type ShiftPermission = (typeof SHIFT_PERMISSIONS)[number]

export interface ShiftPermissionReader {
  hasPermission(permission: ShiftPermission): boolean
}

/**
 * Main-process enforcement for shift lifecycle permissions. The reader is the persisted bootstrap
 * snapshot, so this adds no cache and cannot be influenced by renderer state or IPC payloads.
 */
export class ShiftPermissions {
  constructor(private readonly permissions: ShiftPermissionReader) {}

  assertShiftPermission(permission: ShiftPermission): void {
    if (!this.permissions.hasPermission(permission)) {
      throw publicAppErrorSchema.parse({
        category: 'authorization',
        message: `Your account does not have the ${permission} permission.`,
        backendCode: 'PERMISSION_DENIED',
        retryable: false
      })
    }
  }
}
