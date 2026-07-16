import type { PublicAppError } from './api.contract'

export type IpcResult<T> =
  | {
      ok: true
      data: T
    }
  | {
      ok: false
      error: PublicAppError
    }

export function ipcSuccess<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}

export function ipcFailure<T>(error: PublicAppError): IpcResult<T> {
  return { ok: false, error }
}
