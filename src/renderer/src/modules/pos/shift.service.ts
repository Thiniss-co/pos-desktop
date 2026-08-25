import type {
  CloseShiftInput,
  OpenShiftInput,
  PauseShiftInput,
  ResumeShiftInput,
  Shift
} from '@shared/contracts/shift.contract'
import { unwrapIpcResult } from '@renderer/shared/utils/unwrapIpcResult'

export class ShiftRendererService {
  constructor(private readonly gateway: Window['posApi']['shifts'] = window.posApi.shifts) {}

  async current(): Promise<Shift | null> {
    return unwrapIpcResult(await this.gateway.current())
  }

  async get(uuid: string): Promise<Shift> {
    return unwrapIpcResult(await this.gateway.get({ uuid }))
  }

  async open(input: OpenShiftInput): Promise<Shift> {
    return unwrapIpcResult(await this.gateway.open(input))
  }

  async pause(input: PauseShiftInput): Promise<Shift> {
    return unwrapIpcResult(await this.gateway.pause(input))
  }

  async resume(input: ResumeShiftInput): Promise<Shift> {
    return unwrapIpcResult(await this.gateway.resume(input))
  }

  async close(input: CloseShiftInput): Promise<Shift> {
    return unwrapIpcResult(await this.gateway.close(input))
  }
}
