import type { LoginInput, SessionSummary } from '@shared/contracts/auth.contract'
import { unwrapIpcResult } from '@renderer/shared/utils/unwrapIpcResult'
import { toIpcPayload } from '@renderer/shared/utils/ipcPayload'

export class AuthService {
  constructor(private readonly gateway: Window['posApi']['auth'] = window.posApi.auth) {}

  async getSessionSummary(): Promise<SessionSummary> {
    return unwrapIpcResult(await this.gateway.getSessionSummary())
  }

  async login(input: LoginInput): Promise<SessionSummary> {
    return unwrapIpcResult(await this.gateway.login(toIpcPayload(input)))
  }

  async refreshSession(): Promise<SessionSummary> {
    return unwrapIpcResult(await this.gateway.refreshSession())
  }

  async logout(): Promise<void> {
    return unwrapIpcResult(await this.gateway.logout())
  }
}
