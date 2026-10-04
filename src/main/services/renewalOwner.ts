/**
 * Rev 4 §7.1 — the owner a renewal result belongs to.
 *
 * A license or catalog leg captures this tuple before its network request and re-checks it as the
 * FIRST statement of the single synchronous SQLite transaction that performs every write of that leg
 * (token, license metadata, trusted anchor, authority observation, catalog snapshot). Session
 * transitions are synchronous and main is single-threaded, so no transition can interleave between
 * that check and the writes.
 *
 * The epoch alone is not enough: `refreshSession` can change the binding (user, company, device,
 * server device id) without incrementing it, so every field is compared. The assignment (branch and
 * warehouse) is included because a catalog install can move the device between warehouses while a
 * license leg is in flight.
 */
export interface RenewalOwner {
  readonly sessionEpoch: number
  readonly userUuid: string
  readonly userIsActive: boolean
  readonly companyUuid: string
  readonly deviceUuid: string
  readonly serverDeviceId: string
  readonly branchUuid: string | null
  readonly warehouseUuid: string | null
}

export interface RenewalOwnerSources {
  readonly session: {
    getContext(): {
      readonly isAuthenticated: boolean
      readonly userUuid: string | null
      readonly userIsActive: boolean
      readonly companyUuid: string | null
      readonly deviceUuid: string | null
      readonly serverDeviceId: string | null
    }
  }
  readonly epoch: { current(): number }
  readonly assignment: {
    getBranch(): { readonly branchUuid: string } | null
    getWarehouse(): { readonly warehouseUuid: string } | null
  }
}

export class OwnerChangedError extends Error {
  readonly code = 'owner-changed'

  constructor() {
    super('The workstation owner changed while a renewal was in flight; its result was discarded.')
    this.name = 'OwnerChangedError'
  }
}

export function captureRenewalOwner(sources: RenewalOwnerSources): RenewalOwner | null {
  const context = sources.session.getContext()

  if (
    !context.isAuthenticated ||
    context.userUuid === null ||
    context.companyUuid === null ||
    context.deviceUuid === null ||
    context.serverDeviceId === null
  ) {
    return null
  }

  return {
    sessionEpoch: sources.epoch.current(),
    userUuid: context.userUuid,
    userIsActive: context.userIsActive,
    companyUuid: context.companyUuid,
    deviceUuid: context.deviceUuid,
    serverDeviceId: context.serverDeviceId,
    branchUuid: sources.assignment.getBranch()?.branchUuid ?? null,
    warehouseUuid: sources.assignment.getWarehouse()?.warehouseUuid ?? null
  }
}

export function sameRenewalOwner(a: RenewalOwner | null, b: RenewalOwner | null): boolean {
  if (a === null || b === null) {
    return false
  }

  return (
    a.sessionEpoch === b.sessionEpoch &&
    a.userUuid === b.userUuid &&
    a.userIsActive === b.userIsActive &&
    a.companyUuid === b.companyUuid &&
    a.deviceUuid === b.deviceUuid &&
    a.serverDeviceId === b.serverDeviceId &&
    a.branchUuid === b.branchUuid &&
    a.warehouseUuid === b.warehouseUuid
  )
}

/** A stable key for single-flight: two callers share a flight only for the same owner. */
export function renewalOwnerKey(owner: RenewalOwner | null): string {
  return owner === null
    ? 'anonymous'
    : [
        owner.sessionEpoch,
        owner.userUuid,
        owner.companyUuid,
        owner.deviceUuid,
        owner.serverDeviceId,
        owner.branchUuid ?? '-',
        owner.warehouseUuid ?? '-'
      ].join('|')
}
