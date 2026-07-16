import { z } from 'zod'
import { ipcFailure, ipcSuccess, type IpcResult } from '@shared/contracts/ipc.contract'
import { isPublicAppError } from '../http/apiError'

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
    return ipcFailure(isPublicAppError(error) ? error : unexpectedError)
  }
}
