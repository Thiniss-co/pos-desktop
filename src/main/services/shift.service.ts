import {
  closeShiftInputSchema,
  openShiftInputSchema,
  pauseShiftInputSchema,
  resumeShiftInputSchema,
  shiftSchema,
  shiftStatusSchema,
  type CloseShiftInput,
  type OpenShiftInput,
  type PauseShiftInput,
  type ResumeShiftInput,
  type Shift
} from '@shared/contracts/shift.contract'
import { DESKTOP_API_ROUTES, type DesktopApiRoute } from '@shared/constants/apiRoutes'
import type { DesktopApiClient } from '../http/desktopApiClient'
import {
  desktopShiftResourceSchema,
  type DesktopShiftResource
} from '../http/desktopResources.contract'
import type { CommercialAccessService } from './commercialAccess.service'
import type { ShiftPermissions } from './shiftPermissions'

const activeDesktopShiftResourceSchema = desktopShiftResourceSchema.extend({
  status: shiftStatusSchema.extract(['open', 'paused'])
})

function shiftRoute(route: DesktopApiRoute, uuid: string, action = ''): DesktopApiRoute {
  return { ...route, path: `${route.path}/${uuid}${action}` }
}

function mapShift(resource: DesktopShiftResource): Shift {
  return shiftSchema.parse({
    uuid: resource.uuid,
    status: resource.status,
    openingCashAmount: resource.opening_cash_amount,
    expectedCashAmount: resource.expected_cash_amount,
    actualCashAmount: resource.actual_cash_amount,
    cashDifferenceAmount: resource.cash_difference_amount,
    openedAt: resource.opened_at,
    closedAt: resource.closed_at,
    pausedAt: resource.paused_at,
    pauseCount: resource.pause_count,
    totalPausedSeconds: resource.total_paused_seconds,
    activePause: resource.active_pause
      ? {
          uuid: resource.active_pause.uuid,
          pausedAt: resource.active_pause.paused_at,
          reason: resource.active_pause.reason,
          notes: resource.active_pause.notes
        }
      : null,
    notes: resource.notes,
    closeNotes: resource.close_notes
  })
}

export class ShiftService {
  constructor(
    private readonly apiClient: DesktopApiClient,
    private readonly commercialAccess: CommercialAccessService,
    private readonly permissions: ShiftPermissions
  ) {}

  async current(): Promise<Shift | null> {
    this.permissions.assertShiftPermission('shifts.view')
    const resource = activeDesktopShiftResourceSchema
      .nullable()
      .parse(await this.apiClient.request<unknown>(DESKTOP_API_ROUTES.shiftsCurrent))
    return resource ? mapShift(resource) : null
  }

  async get(uuid: string): Promise<Shift> {
    this.permissions.assertShiftPermission('shifts.view')
    return mapShift(
      desktopShiftResourceSchema.parse(
        await this.apiClient.request<unknown>(shiftRoute(DESKTOP_API_ROUTES.shiftsShow, uuid))
      )
    )
  }

  async open(rawInput: OpenShiftInput): Promise<Shift> {
    const input = openShiftInputSchema.parse(rawInput)
    this.permissions.assertShiftPermission('shifts.manage')
    this.commercialAccess.assertAllowed('sell')
    return this.mutate(DESKTOP_API_ROUTES.shiftsOpen, {
      opening_cash_amount: input.openingCashAmount,
      notes: input.notes ?? null
    })
  }

  async pause(rawInput: PauseShiftInput): Promise<Shift> {
    const input = pauseShiftInputSchema.parse(rawInput)
    this.permissions.assertShiftPermission('shifts.manage')
    return this.mutate(shiftRoute(DESKTOP_API_ROUTES.shiftsPause, input.uuid, '/pause'), {
      reason: input.reason ?? null,
      notes: input.notes ?? null
    })
  }

  async resume(rawInput: ResumeShiftInput): Promise<Shift> {
    const input = resumeShiftInputSchema.parse(rawInput)
    this.permissions.assertShiftPermission('shifts.manage')
    this.commercialAccess.assertAllowed('sell')
    return this.mutate(shiftRoute(DESKTOP_API_ROUTES.shiftsResume, input.uuid, '/resume'), {
      resume_notes: input.resumeNotes ?? null
    })
  }

  async close(rawInput: CloseShiftInput): Promise<Shift> {
    const input = closeShiftInputSchema.parse(rawInput)
    this.permissions.assertShiftPermission('shifts.manage')
    return this.mutate(shiftRoute(DESKTOP_API_ROUTES.shiftsClose, input.uuid, '/close'), {
      actual_cash_amount: input.actualCashAmount,
      close_notes: input.closeNotes ?? null
    })
  }

  private async mutate(route: DesktopApiRoute, body: unknown): Promise<Shift> {
    return mapShift(
      desktopShiftResourceSchema.parse(await this.apiClient.request<unknown>(route, body))
    )
  }
}
