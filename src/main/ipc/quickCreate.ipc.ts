import { BrowserWindow, ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import {
  quickCreateCustomerInputSchema,
  quickCreateGetAccessInputSchema,
  quickCreateNoInputSchema,
  quickCreateProductInputSchema,
  quickCreateRequestKeyInputSchema,
  quickCreateResubmitInputSchema,
  quickCreateSupplierInputSchema
} from '@shared/validators/ipc.validators'
import { ipcFailure } from '@shared/contracts/ipc.contract'
import type { ApplicationServices } from '../app/applicationServices'
import { isPublicAppError } from '../http/apiError'
import { assertTrustedSender } from './assertTrustedSender'
import { handleIpcRequest } from './handleIpcRequest'

const unexpectedError = {
  category: 'unexpected',
  message: 'The request could not be completed',
  retryable: false
} as const

/** Tells every renderer that register quick-create records changed; it carries nothing. */
export function broadcastQuickCreateChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue
    }
    try {
      window.webContents.send(IPC_CHANNELS.quickCreateChanged)
    } catch {
      // A teardown race in one renderer must not stop delivery to the others.
    }
  }
}

/**
 * POS improvements — register quick-create. Every handler checks the sender, validates its input
 * with Zod, and leaves every decision (access, owner, identity, payload) to main.
 */
export function registerQuickCreateIpcHandlers(services: ApplicationServices): void {
  const guarded = <T>(
    channel: string,
    schema: Parameters<typeof handleIpcRequest>[1],
    run: (input: never) => T
  ): void => {
    ipcMain.handle(channel, (event, input: unknown) => {
      try {
        assertTrustedSender(event)
      } catch (error) {
        return isPublicAppError(error) ? ipcFailure(error) : ipcFailure(unexpectedError)
      }
      return handleIpcRequest(input, schema, run as (input: unknown) => T)
    })
  }

  guarded(IPC_CHANNELS.quickCreateGetAccess, quickCreateGetAccessInputSchema, () =>
    services.quickCreateAccess.access()
  )
  guarded(IPC_CHANNELS.quickCreateCustomer, quickCreateCustomerInputSchema, (input) =>
    services.quickCreate.createCustomer(input)
  )
  guarded(IPC_CHANNELS.quickCreateSupplier, quickCreateSupplierInputSchema, (input) =>
    services.quickCreate.createSupplier(input)
  )
  guarded(IPC_CHANNELS.quickCreateProduct, quickCreateProductInputSchema, (input) =>
    services.quickCreate.createProduct(input)
  )
  guarded(IPC_CHANNELS.quickCreateProductOptions, quickCreateNoInputSchema, () =>
    services.quickCreate.productOptions()
  )
  guarded(IPC_CHANNELS.quickCreateList, quickCreateNoInputSchema, () => services.quickCreate.list())
  guarded(
    IPC_CHANNELS.quickCreateRetry,
    quickCreateRequestKeyInputSchema,
    (input: { requestKey: string }) => services.quickCreate.retry(input.requestKey)
  )
  guarded(
    IPC_CHANNELS.quickCreateReassign,
    quickCreateRequestKeyInputSchema,
    (input: { requestKey: string }) => services.quickCreate.reassign(input.requestKey)
  )
  guarded(IPC_CHANNELS.quickCreateResubmit, quickCreateResubmitInputSchema, (input) =>
    services.quickCreate.resubmit(input)
  )
}
