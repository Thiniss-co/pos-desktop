import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import {
  receiptProfileGetInputSchema,
  receiptProfileChooseLogoInputSchema,
  receiptProfilePublishInputSchema
} from '@shared/validators/ipc.validators'
import type { ApplicationServices } from '../app/applicationServices'
import { isPublicAppError } from '../http/apiError'
import { ipcFailure } from '@shared/contracts/ipc.contract'
import { assertTrustedSender } from './assertTrustedSender'
import { handleIpcRequest } from './handleIpcRequest'

const unexpectedError = {
  category: 'unexpected',
  message: 'The request could not be completed',
  retryable: false
} as const

/**
 * Receipt-printing plan §D-11 -- the CompanyAdmin receipt-profile editor. Every channel resolves
 * the session first (`receiptAccess.resolveCaller()`, exactly like every other receipt channel),
 * then delegates to `ReceiptProfileAdminService`, which re-checks the mirrored `canManage`
 * verdict and the online requirement before touching the backend.
 */
export function registerReceiptProfileIpcHandlers(services: ApplicationServices): void {
  ipcMain.handle(IPC_CHANNELS.receiptProfileGet, (event, input: unknown) => {
    try {
      assertTrustedSender(event)
    } catch (error) {
      return isPublicAppError(error) ? ipcFailure(error) : ipcFailure(unexpectedError)
    }
    return handleIpcRequest(input, receiptProfileGetInputSchema, () => {
      const owner = services.receiptAccess.resolveCaller()
      return services.receiptProfileAdmin.get(owner)
    })
  })

  ipcMain.handle(IPC_CHANNELS.receiptProfileChooseLogo, (event, input: unknown) => {
    try {
      assertTrustedSender(event)
    } catch (error) {
      return isPublicAppError(error) ? ipcFailure(error) : ipcFailure(unexpectedError)
    }
    return handleIpcRequest(input, receiptProfileChooseLogoInputSchema, () => {
      const owner = services.receiptAccess.resolveCaller()
      return services.receiptProfileAdmin.chooseLogo(owner)
    })
  })

  ipcMain.handle(IPC_CHANNELS.receiptProfilePublish, (event, input: unknown) => {
    try {
      assertTrustedSender(event)
    } catch (error) {
      return isPublicAppError(error) ? ipcFailure(error) : ipcFailure(unexpectedError)
    }
    return handleIpcRequest(input, receiptProfilePublishInputSchema, (payload) => {
      const owner = services.receiptAccess.resolveCaller()
      return services.receiptProfileAdmin.publish(owner, payload)
    })
  })
}
