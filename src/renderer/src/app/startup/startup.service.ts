import type { IpcResult } from '@shared/contracts/ipc.contract'
import type { StartupSnapshot } from './types'

interface StartupBridge {
  readonly system: Window['posApi']['system']
  readonly device: Window['posApi']['device']
  readonly auth: Window['posApi']['auth']
  readonly bootstrap: Window['posApi']['bootstrap']
  readonly sync: Window['posApi']['sync']
}

function unwrap<T>(result: IpcResult<T>): T {
  if (!result.ok) {
    throw result.error
  }

  return result.data
}

export class StartupService {
  constructor(private readonly bridge: StartupBridge = window.posApi) {}

  async getSnapshot(): Promise<StartupSnapshot> {
    const [runtime, device, session, bootstrap, sync] = await Promise.all([
      this.bridge.system.getRuntimeInfo(),
      this.bridge.device.getIdentitySummary(),
      this.bridge.auth.getSessionSummary(),
      this.bridge.bootstrap.getStatus(),
      this.bridge.sync.getStatus()
    ])

    return {
      runtime: unwrap(runtime),
      device: unwrap(device),
      session: unwrap(session),
      bootstrap: unwrap(bootstrap),
      sync: unwrap(sync)
    }
  }
}
