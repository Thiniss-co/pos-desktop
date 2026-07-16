import type { IpcResult } from '@shared/contracts/ipc.contract'

export function unwrapIpcResult<T>(result: IpcResult<T>): T {
  if (!result.ok) {
    throw result.error
  }

  return result.data
}
