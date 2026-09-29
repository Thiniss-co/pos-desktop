import type {
  CatalogCategory,
  CatalogBarcodeLookup,
  CatalogCustomer,
  CatalogCustomerPage,
  CatalogCustomerSearchInput,
  CatalogPaymentMethod,
  CatalogProduct,
  CatalogProductForSale,
  CatalogProductPage,
  CatalogRefreshResult,
  CatalogSearchInput,
  CatalogStatus
} from '@shared/contracts/catalog.contract'
import { unwrapIpcResult } from '@renderer/shared/utils/unwrapIpcResult'

export interface CatalogChange {
  readonly reason: 'stock' | 'snapshot'
  readonly revision: string | null
}
import { toIpcPayload } from '@renderer/shared/utils/ipcPayload'

export class CatalogRendererService {
  constructor(private readonly gateway: Window['posApi']['catalog'] = window.posApi.catalog) {}

  async getStatus(): Promise<CatalogStatus> {
    return unwrapIpcResult(await this.gateway.getStatus())
  }

  /**
   * The authoritative workstation-data refresh. Narrow and argument-free by design: the renderer
   * cannot name a company, device, warehouse, or catalog revision to refresh — main derives all of
   * that from the authenticated session and the bound device.
   */
  async refresh(): Promise<CatalogRefreshResult> {
    return unwrapIpcResult(await this.gateway.refresh())
  }

  async listCategories(): Promise<CatalogCategory[]> {
    return unwrapIpcResult(await this.gateway.listCategories())
  }

  async searchProducts(input: CatalogSearchInput): Promise<CatalogProductPage> {
    return unwrapIpcResult(await this.gateway.searchProducts(toIpcPayload(input)))
  }

  async getProduct(uuid: string): Promise<CatalogProduct> {
    return unwrapIpcResult(await this.gateway.getProduct({ uuid }))
  }

  /** Rev 3: the product with the catalog revision it was read under and its stock view. */
  async getProductForSale(uuid: string): Promise<CatalogProductForSale> {
    return unwrapIpcResult(await this.gateway.getProductForSale({ uuid }))
  }

  /** Rev 3: main → renderer change hints. Returns the unsubscribe function. */
  onChanged(listener: (change: CatalogChange) => void): () => void {
    return this.gateway.onChanged(listener)
  }

  async findProductByBarcode(barcode: string): Promise<CatalogBarcodeLookup> {
    return unwrapIpcResult(await this.gateway.findProductByBarcode({ barcode }))
  }

  async listPaymentMethods(): Promise<CatalogPaymentMethod[]> {
    return unwrapIpcResult(await this.gateway.listPaymentMethods())
  }

  async searchCustomers(input: CatalogCustomerSearchInput): Promise<CatalogCustomerPage> {
    return unwrapIpcResult(await this.gateway.searchCustomers(toIpcPayload(input)))
  }

  async getCustomer(uuid: string): Promise<CatalogCustomer> {
    return unwrapIpcResult(await this.gateway.getCustomer({ uuid }))
  }
}
