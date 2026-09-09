import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import { allocationRecoveryStartInputSchema } from '@shared/validators/ipc.validators'
import type { ApplicationServices } from '../app/applicationServices'
import { isPublicAppError } from '../http/apiError'
import { ipcFailure } from '@shared/contracts/ipc.contract'
import { assertTrustedSender } from './assertTrustedSender'
import { handleIpcRequest } from './handleIpcRequest'

export function registerAllocationRecoveryIpcHandlers(services: ApplicationServices): void {
  ipcMain.handle(IPC_CHANNELS.allocationRecoveryStart, (event, input: unknown) => {
    try {
      assertTrustedSender(event)
    } catch (error) {
      return ipcFailure(
        isPublicAppError(error)
          ? error
          : {
              category: 'unexpected',
              message: 'The request could not be completed',
              retryable: false
            }
      )
    }

    return handleIpcRequest(
      input,
      allocationRecoveryStartInputSchema,
      async ({ allocationUuid }) => {
        await services.allocationRecoveries.start(allocationUuid)
      }
    )
  })

  ipcMain.handle(IPC_CHANNELS.allocationRecoveryResume, (event, input: unknown) => {
    try {
      assertTrustedSender(event)
    } catch (error) {
      return ipcFailure(
        isPublicAppError(error)
          ? error
          : {
              category: 'unexpected',
              message: 'The request could not be completed',
              retryable: false
            }
      )
    }

    return handleIpcRequest(input, allocationRecoveryStartInputSchema.optional(), async () => {
      await services.allocationRecoveries.resume()
    })
  })
}
