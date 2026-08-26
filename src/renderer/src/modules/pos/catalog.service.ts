import type {
  CatalogCategory,
  CatalogBarcodeLookup,
  CatalogCustomer,
  CatalogCustomerPage,
  CatalogCustomerSearchInput,
  CatalogPaymentMethod,
  CatalogProduct,
  CatalogProductPage,
  CatalogSearchInput,
  CatalogStatus
} from '@shared/contracts/catalog.contract'
import { unwrapIpcResult } from '@renderer/shared/utils/unwrapIpcResult'

export class CatalogRendererService {
  constructor(private readonly gateway: Window['posApi']['catalog'] = window.posApi.catalog) {}

  async getStatus(): Promise<CatalogStatus> {
    return unwrapIpcResult(await this.gateway.getStatus())
  }

  async listCategories(): Promise<CatalogCategory[]> {
    return unwrapIpcResult(await this.gateway.listCategories())
  }

  async searchProducts(input: CatalogSearchInput): Promise<CatalogProductPage> {
    return unwrapIpcResult(await this.gateway.searchProducts(input))
  }

  async getProduct(uuid: string): Promise<CatalogProduct> {
    return unwrapIpcResult(await this.gateway.getProduct({ uuid }))
  }

  async findProductByBarcode(barcode: string): Promise<CatalogBarcodeLookup> {
    return unwrapIpcResult(await this.gateway.findProductByBarcode({ barcode }))
  }

  async listPaymentMethods(): Promise<CatalogPaymentMethod[]> {
    return unwrapIpcResult(await this.gateway.listPaymentMethods())
  }

  async searchCustomers(input: CatalogCustomerSearchInput): Promise<CatalogCustomerPage> {
    return unwrapIpcResult(await this.gateway.searchCustomers(input))
  }

  async getCustomer(uuid: string): Promise<CatalogCustomer> {
    return unwrapIpcResult(await this.gateway.getCustomer({ uuid }))
  }
}
