import type { SessionSummary } from '@shared/contracts/auth.contract'
import { unwrapIpcResult } from '@renderer/shared/utils/unwrapIpcResult'

export class AuthService {
  constructor(private readonly gateway: Window['posApi']['auth'] = window.posApi.auth) {}

  async getSessionSummary(): Promise<SessionSummary> {
    return unwrapIpcResult(await this.gateway.getSessionSummary())
  }
}
