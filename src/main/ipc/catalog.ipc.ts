import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import {
  catalogFindByBarcodeInputSchema,
  catalogGetProductInputSchema,
  catalogGetStatusInputSchema,
  catalogListCategoriesInputSchema,
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
      services.catalog.findByBarcode(value.barcode)
    )
  )
}
