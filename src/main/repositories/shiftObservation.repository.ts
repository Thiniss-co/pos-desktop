import type { Shift } from '@shared/contracts/shift.contract'
import type { SqliteDatabase } from '../database/connection'

export type ShiftObservationSource = 'current' | 'open' | 'pause' | 'resume' | 'close'
type ShiftStatus = Shift['status']

export interface ShiftObservationIdentity {
  readonly companyUuid: string
  readonly deviceUuid: string
  readonly userUuid: string
  readonly sessionEpoch: number
}

interface ShiftObservationMetadata extends ShiftObservationIdentity {
  readonly observedAt: string
  readonly source: ShiftObservationSource
}

export type StoredShiftObservation =
  | (ShiftObservationMetadata & {
      readonly kind: 'none'
    })
  | (ShiftObservationMetadata & {
      readonly kind: 'shift'
      readonly shiftUuid: string
      readonly status: ShiftStatus
      readonly openedAt: string | null
    })
  | (ShiftObservationMetadata & {
      readonly kind: 'reconciliation_required'
    })

interface ShiftObservationRow {
  readonly kind: StoredShiftObservation['kind']
  readonly shift_uuid: string | null
  readonly status: ShiftStatus | null
  readonly company_uuid: string
  readonly device_uuid: string
  readonly user_uuid: string
  readonly session_epoch: number
  readonly opened_at: string | null
  readonly observed_at: string
  readonly source: ShiftObservationSource
}

function mapObservation(row: ShiftObservationRow): StoredShiftObservation {
  const metadata: ShiftObservationMetadata = {
    companyUuid: row.company_uuid,
    deviceUuid: row.device_uuid,
    userUuid: row.user_uuid,
    sessionEpoch: row.session_epoch,
    observedAt: row.observed_at,
    source: row.source
  }

  if (row.kind === 'none') {
    return { kind: 'none', ...metadata }
  }

  if (row.kind === 'reconciliation_required') {
    return { kind: 'reconciliation_required', ...metadata }
  }

  if (!row.shift_uuid || !row.status) {
    throw new Error('The stored shift observation violates its required shift fields')
  }

  return {
    kind: 'shift',
    ...metadata,
    shiftUuid: row.shift_uuid,
    status: row.status,
    openedAt: row.opened_at
  }
}

export class ShiftObservationRepository {
  constructor(private readonly database: SqliteDatabase) {}

  get(): StoredShiftObservation | null {
    const row = this.database
      .prepare(
        `
          SELECT kind, shift_uuid, status, company_uuid, device_uuid, user_uuid, session_epoch,
            opened_at, observed_at, source
          FROM shift_observation
          WHERE id = 1
        `
      )
      .get() as ShiftObservationRow | undefined

    return row ? mapObservation(row) : null
  }

  write(observation: StoredShiftObservation): void {
    this.database
      .prepare(
        `
          INSERT INTO shift_observation (
            id, kind, shift_uuid, status, company_uuid, device_uuid, user_uuid, session_epoch,
            opened_at, observed_at, source
          ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            kind = excluded.kind,
            shift_uuid = excluded.shift_uuid,
            status = excluded.status,
            company_uuid = excluded.company_uuid,
            device_uuid = excluded.device_uuid,
            user_uuid = excluded.user_uuid,
            session_epoch = excluded.session_epoch,
            opened_at = excluded.opened_at,
            observed_at = excluded.observed_at,
            source = excluded.source
        `
      )
      .run(
        observation.kind,
        observation.kind === 'shift' ? observation.shiftUuid : null,
        observation.kind === 'shift' ? observation.status : null,
        observation.companyUuid,
        observation.deviceUuid,
        observation.userUuid,
        observation.sessionEpoch,
        observation.kind === 'shift' ? observation.openedAt : null,
        observation.observedAt,
        observation.source
      )
  }

  clear(): void {
    this.database.prepare('DELETE FROM shift_observation WHERE id = 1').run()
  }
}
