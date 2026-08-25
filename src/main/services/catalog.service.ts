import { publicAppErrorSchema, type PublicAppError } from '@shared/contracts/api.contract'
import {
  catalogProductPageSchema,
  catalogStatusSchema,
  type CatalogCategory,
  type CatalogContract,
  type CatalogProduct,
  type CatalogProductPage,
  type CatalogSearchInput,
  type CatalogStatus
} from '@shared/contracts/catalog.contract'
import type { CommercialAccessService } from './commercialAccess.service'
import type { CatalogRepository } from '../repositories/catalog.repository'

function catalogError(
  code: string,
  message: string,
  category: 'rejected' | 'conflict' = 'rejected'
): PublicAppError {
  return publicAppErrorSchema.parse({
    category,
    message,
    backendCode: code,
    retryable: false
  })
}

export class CatalogService {
  constructor(
    private readonly repository: CatalogRepository,
    private readonly commercialAccess: CommercialAccessService,
    private readonly now: () => Date = () => new Date()
  ) {}

  getStatus(): CatalogStatus {
    const contract = this.repository.getContract()

    if (!contract) {
      return catalogStatusSchema.parse({ available: false, reason: 'missing', contract: null })
    }

    if (!this.commercialAccess.evaluate('sell').allowed) {
      return catalogStatusSchema.parse({
        available: false,
        reason: 'commercial-access-denied',
        contract
      })
    }

    const now = this.now().getTime()

    return catalogStatusSchema.parse({
      available: now >= Date.parse(contract.generatedAt) && now < Date.parse(contract.validUntil),
      reason:
        now < Date.parse(contract.generatedAt)
          ? 'not-yet-valid'
          : now >= Date.parse(contract.validUntil)
            ? 'expired'
            : 'ready',
      contract
    })
  }

  listCategories(): CatalogCategory[] {
    this.assertAvailable()
    return this.repository.listCategories()
  }

  searchProducts(input: CatalogSearchInput): CatalogProductPage {
    const contract = this.assertAvailable()
    const result = this.repository.searchProducts(input, this.now().toISOString())

    return catalogProductPageSchema.parse({
      ...result,
      limit: input.limit,
      offset: input.offset,
      contract
    })
  }

  getProduct(uuid: string): CatalogProduct {
    this.assertAvailable()
    const product = this.repository.getProduct(uuid, this.now().toISOString())

    if (!product) {
      throw catalogError(
        'CATALOG_PRODUCT_NOT_FOUND',
        'The product is not available in this catalog'
      )
    }

    return product
  }

  findByBarcode(barcode: string): CatalogProduct {
    this.assertAvailable()
    const products = this.repository.findProductsByBarcode(barcode, this.now().toISOString())

    if (products.length === 0) {
      throw catalogError('CATALOG_BARCODE_NOT_FOUND', 'No available product matches this barcode')
    }

    if (products.length > 1) {
      throw catalogError(
        'CATALOG_BARCODE_AMBIGUOUS',
        'More than one available product matches this barcode',
        'conflict'
      )
    }

    return products[0]
  }

  private assertAvailable(): CatalogContract {
    this.commercialAccess.assertAllowed('sell')
    const status = this.getStatus()

    if (!status.available || !status.contract) {
      throw catalogError(
        status.reason === 'expired' ? 'CATALOG_EXPIRED' : 'CATALOG_UNAVAILABLE',
        'A current local catalog is required. Refresh workstation data to continue.'
      )
    }

    return status.contract
  }
}
