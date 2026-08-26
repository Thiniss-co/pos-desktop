import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import {
  catalogFindByBarcodeInputSchema,
  catalogGetCustomerInputSchema,
  catalogGetProductInputSchema,
  catalogGetStatusInputSchema,
  catalogListCategoriesInputSchema,
  catalogListPaymentMethodsInputSchema,
  catalogSearchCustomersInputSchema,
  catalogSearchProductsInputSchema
} from '@shared/validators/ipc.validators'
import type { ApplicationServices } from '../app/applicationServices'
import { handleIpcRequest } from './handleIpcRequest'

export function registerCatalogIpcHandlers(services: ApplicationServices): void {
  ipcMain.handle(IPC_CHANNELS.catalogGetStatus, (_event, input: unknown) =>
    handleIpcRequest(input, catalogGetStatusInputSchema, () => services.catalog.getStatus())
  )
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
