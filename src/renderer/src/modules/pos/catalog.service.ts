import type {
  CatalogCategory,
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

  async findByBarcode(barcode: string): Promise<CatalogProduct> {
    return unwrapIpcResult(await this.gateway.findByBarcode({ barcode }))
  }
}
