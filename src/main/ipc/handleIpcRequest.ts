import { z } from 'zod'
import { ipcFailure, ipcSuccess, type IpcResult } from '@shared/contracts/ipc.contract'
import { isPublicAppError, redactSensitiveText } from '../http/apiError'

const invalidRequestError = {
  category: 'validation',
  message: 'The request is invalid',
  retryable: false
} as const

const unexpectedError = {
  category: 'unexpected',
  message: 'The request could not be completed',
  retryable: false
} as const

export async function handleIpcRequest<TInput, TOutput>(
  input: unknown,
  schema: z.ZodType<TInput>,
  handler: (value: TInput) => TOutput | Promise<TOutput>
): Promise<IpcResult<TOutput>> {
  const parsedInput = schema.safeParse(input)

  if (!parsedInput.success) {
    return ipcFailure(invalidRequestError)
  }

  try {
    return ipcSuccess(await handler(parsedInput.data))
  } catch (error) {
    if (isPublicAppError(error)) {
      return ipcFailure(error)
    }

    // Never send this detail to the renderer — it may contain internal shapes, paths, or
    // stack frames. Logging it main-side is the only diagnostic trail for unexpected failures.
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    console.error('[ipc] unexpected error:', redactSensitiveText(detail))

    return ipcFailure(unexpectedError)
  }
}
