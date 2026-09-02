import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import {
  catalogFindByBarcodeInputSchema,
  catalogGetCustomerInputSchema,
  catalogGetProductInputSchema,
  catalogGetStatusInputSchema,
  catalogListCategoriesInputSchema,
  catalogListPaymentMethodsInputSchema,
  catalogRefreshInputSchema,
  catalogSearchCustomersInputSchema,
  catalogSearchProductsInputSchema
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

export function registerCatalogIpcHandlers(services: ApplicationServices): void {
  ipcMain.handle(IPC_CHANNELS.catalogGetStatus, (_event, input: unknown) =>
    handleIpcRequest(input, catalogGetStatusInputSchema, () => services.catalog.getStatus())
  )
  // `catalog:refresh` is the only catalog channel that changes durable state and reaches the
  // network, so it is the only one that carries the trusted-sender check — asserted *before* the
  // payload is parsed, exactly like the checkout write channels.
  ipcMain.handle(IPC_CHANNELS.catalogRefresh, (event, input: unknown) => {
    try {
      assertTrustedSender(event)
    } catch (error) {
      return isPublicAppError(error) ? ipcFailure(error) : ipcFailure(unexpectedError)
    }

    return handleIpcRequest(input, catalogRefreshInputSchema, () =>
      services.catalogRefresh.refresh()
    )
  })

  ipcMain.handle(IPC_CHANNELS.catalogListCategories, (_event, input: unknown) =>
    handleIpcRequest(input, catalogListCategoriesInputSchema, () =>
      services.catalog.listCategories()
    )
  )
  ipcMain.handle(IPC_CHANNELS.catalogSearchProducts, (_event, input: unknown) =>
    handleIpcRequest(input, catalogSearchProductsInputSchema, (value) =>
      services.catalog.searchProducts(value)
    )
  )
  ipcMain.handle(IPC_CHANNELS.catalogGetProduct, (_event, input: unknown) =>
    handleIpcRequest(input, catalogGetProductInputSchema, (value) =>
      services.catalog.getProduct(value.uuid)
    )
  )
  ipcMain.handle(IPC_CHANNELS.catalogFindByBarcode, (_event, input: unknown) =>
    handleIpcRequest(input, catalogFindByBarcodeInputSchema, (value) =>
      services.catalog.findProductByBarcode(value.barcode)
    )
  )
  ipcMain.handle(IPC_CHANNELS.catalogListPaymentMethods, (_event, input: unknown) =>
    handleIpcRequest(input, catalogListPaymentMethodsInputSchema, () =>
      services.catalog.listPaymentMethods()
    )
  )
  ipcMain.handle(IPC_CHANNELS.catalogSearchCustomers, (_event, input: unknown) =>
    handleIpcRequest(input, catalogSearchCustomersInputSchema, (value) =>
      services.catalog.searchCustomers(value)
    )
  )
  ipcMain.handle(IPC_CHANNELS.catalogGetCustomer, (_event, input: unknown) =>
    handleIpcRequest(input, catalogGetCustomerInputSchema, (value) =>
      services.catalog.getCustomer(value.uuid)
    )
  )
}
