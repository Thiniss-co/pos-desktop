import { publicAppErrorSchema } from '@shared/contracts/api.contract'
import type { Shift } from '@shared/contracts/shift.contract'
import type { BootstrapCompany } from '../repositories/bootstrapSnapshot.repository'
import type { SessionContext } from '../repositories/sessionMetadata.repository'
import type {
  ShiftObservationIdentity,
  ShiftObservationRepository,
  ShiftObservationSource,
  StoredShiftObservation
} from '../repositories/shiftObservation.repository'
import type { SessionEpochRepository } from '../repositories/sessionEpoch.repository'
import type { StoredDeviceIdentity } from './deviceIdentity.service'

export type ShiftAuthority =
  | { readonly kind: 'open'; readonly shiftUuid: string; readonly observedAt: string }
  | { readonly kind: 'not-open'; readonly status: 'paused' | 'closed' | 'cancelled' }
  | { readonly kind: 'none'; readonly observedAt: string }
  | { readonly kind: 'reconciliation-required'; readonly since: string }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'foreign' }

export interface ShiftAuthorityContext extends ShiftObservationIdentity {}

export interface ShiftObservationAuthority {
  captureContext(): ShiftAuthorityContext
  recordCurrent(context: ShiftAuthorityContext, shift: Shift | null): void
  markReconciliationRequired(
    context: ShiftAuthorityContext,
    source: Exclude<ShiftObservationSource, 'current'>
  ): void
  recordMutation(
    context: ShiftAuthorityContext,
    source: Exclude<ShiftObservationSource, 'current'>,
    shift: Shift
  ): void
}

export interface ShiftAuthorityDependencies {
  readonly observations: Pick<ShiftObservationRepository, 'get' | 'write'>
  readonly session: { getContext(): SessionContext }
  readonly company: { getCompany(): BootstrapCompany | null }
  readonly device: { getOrCreate(): StoredDeviceIdentity }
  readonly epoch: Pick<SessionEpochRepository, 'current'>
  readonly now?: () => Date
}

function isCurrentContext(
  observation: StoredShiftObservation,
  context: ShiftAuthorityContext
): boolean {
  return (
    observation.companyUuid === context.companyUuid &&
    observation.deviceUuid === context.deviceUuid &&
    observation.userUuid === context.userUuid &&
    observation.sessionEpoch === context.sessionEpoch
  )
}

/**
 * Owns the local authority record used by a future checkout preview. No renderer input can
 * provide its identity, generation, or observed shift state.
 */
export class ShiftAuthorityService implements ShiftObservationAuthority {
  private readonly now: () => Date

  constructor(private readonly dependencies: ShiftAuthorityDependencies) {
    this.now = dependencies.now ?? (() => new Date())
  }

  captureContext(): ShiftAuthorityContext {
    const session = this.dependencies.session.getContext()
    const company = this.dependencies.company.getCompany()
    const device = this.dependencies.device.getOrCreate()

    if (
      !session.isAuthenticated ||
      !session.userIsActive ||
      !session.userUuid ||
      !session.companyUuid ||
      !session.deviceUuid ||
      !session.serverDeviceId ||
      !company?.isActive ||
      company.companyUuid !== session.companyUuid ||
      device.deviceUuid !== session.deviceUuid
    ) {
      throw publicAppErrorSchema.parse({
        category: 'authorization',
        message: 'The current workstation session cannot establish shift authority.',
        retryable: false
      })
    }

    return {
      companyUuid: company.companyUuid,
      deviceUuid: device.deviceUuid,
      userUuid: session.userUuid,
      sessionEpoch: this.dependencies.epoch.current()
    }
  }

  recordCurrent(context: ShiftAuthorityContext, shift: Shift | null): void {
    if (shift) {
      this.writeShift(context, 'current', shift)
      return
    }

    this.dependencies.observations.write({
      kind: 'none',
      ...context,
      observedAt: this.timestamp(),
      source: 'current'
    })
  }

  markReconciliationRequired(
    context: ShiftAuthorityContext,
    source: Exclude<ShiftObservationSource, 'current'>
  ): void {
    this.dependencies.observations.write({
      kind: 'reconciliation_required',
      ...context,
      observedAt: this.timestamp(),
      source
    })
  }

  recordMutation(
    context: ShiftAuthorityContext,
    source: Exclude<ShiftObservationSource, 'current'>,
    shift: Shift
  ): void {
    this.writeShift(context, source, shift)
  }

  resolveForSell(): ShiftAuthority {
    const observation = this.dependencies.observations.get()

    if (!observation) {
      return { kind: 'unknown' }
    }

    let context: ShiftAuthorityContext
    try {
      context = this.captureContext()
    } catch {
      return { kind: 'foreign' }
    }

    if (!isCurrentContext(observation, context)) {
      return { kind: 'foreign' }
    }

    if (observation.kind === 'none') {
      return { kind: 'none', observedAt: observation.observedAt }
    }

    if (observation.kind === 'reconciliation_required') {
      return { kind: 'reconciliation-required', since: observation.observedAt }
    }

    if (observation.status === 'open') {
      return {
        kind: 'open',
        shiftUuid: observation.shiftUuid,
        observedAt: observation.observedAt
      }
    }

    return { kind: 'not-open', status: observation.status }
  }

  assertOpenForSell(): Extract<ShiftAuthority, { kind: 'open' }> {
    const authority = this.resolveForSell()

    if (authority.kind !== 'open') {
      throw publicAppErrorSchema.parse({
        category: 'authorization',
        message: 'An observed open shift is required before selling.',
        retryable: false
      })
    }

    return authority
  }

  private writeShift(
    context: ShiftAuthorityContext,
    source: ShiftObservationSource,
    shift: Shift
  ): void {
    this.dependencies.observations.write({
      kind: 'shift',
      ...context,
      shiftUuid: shift.uuid,
      status: shift.status,
      openedAt: shift.openedAt,
      observedAt: this.timestamp(),
      source
    })
  }

  private timestamp(): string {
    return this.now().toISOString()
  }
}
