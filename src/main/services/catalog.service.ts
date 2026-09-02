import { publicAppErrorSchema, type PublicAppError } from '@shared/contracts/api.contract'
import {
  catalogBarcodeLookupSchema,
  catalogProductPageSchema,
  catalogStatusSchema,
  type CatalogBarcodeLookup,
  type CatalogCategory,
  type CatalogCustomer,
  type CatalogCustomerPage,
  type CatalogCustomerSearchInput,
  type CatalogPaymentMethod,
  type CatalogProduct,
  type CatalogProductPage,
  type CatalogSearchInput,
  type CatalogStatus,
  type CheckoutResolution
} from '@shared/contracts/catalog.contract'
import type {
  CatalogRepository,
  CatalogSnapshot,
  CheckoutResolutionInput
} from '../repositories/catalog.repository'
import type { StockAllocationRepository } from '../repositories/stockAllocation.repository'
import { milliToQuantity } from './localSale.fingerprint'
import type { CatalogReadAccess } from './catalogReadAccess.service'
import type { CatalogTrustedClock } from './catalogTrustedClock.service'

export interface CatalogAllocationOwner {
  readonly companyUuid: string
  readonly deviceUuid: string
  readonly warehouseUuid: string
}

function catalogError(code: string, message: string): PublicAppError {
  return publicAppErrorSchema.parse({
    category: 'rejected',
    message,
    backendCode: code,
    retryable: false
  })
}

function unavailableStatus(): CatalogStatus {
  return catalogStatusSchema.parse({
    status: 'unavailable',
    isReadable: false,
    catalogValid: false,
    lastSyncedAt: null,
    contract: null
  })
}

/** Main-process catalog facade. Every call re-applies read authorization before touching rows. */
export class CatalogService {
  private publishedRevision: string | null = null

  constructor(
    private readonly repository: CatalogRepository,
    private readonly readAccess: CatalogReadAccess,
    private readonly clock: CatalogTrustedClock,
    private readonly stockAllocations?: Pick<
      StockAllocationRepository,
      'usableGrantsForProduct' | 'remainingMilli'
    >
  ) {}

  markPublished(revision: string): void {
    this.publishedRevision = revision
  }

  getStatus(): CatalogStatus {
    if (!this.readAccess.evaluate().allowed) {
      return unavailableStatus()
    }

    return this.statusForEligibleContext()
  }

  listCategories(): CatalogCategory[] {
    this.assertReadable()
    return this.repository.listCategories()
  }

  searchProducts(input: CatalogSearchInput): CatalogProductPage {
    const snapshot = this.assertReadable()
    const result = this.repository.searchProducts(input)

    return catalogProductPageSchema.parse({
      ...result,
      limit: input.limit,
      offset: input.offset,
      contract: snapshot.contract
    })
  }

  getProduct(uuid: string): CatalogProduct {
    this.assertReadable()
    const product = this.repository.getProduct(uuid)

    if (!product) {
      throw catalogError(
        'CATALOG_PRODUCT_NOT_FOUND',
        'The product is not available in this catalog.'
      )
    }

    return product
  }

  findProductByBarcode(barcode: string): CatalogBarcodeLookup {
    const status = this.getStatus()

    if (status.status === 'stale') {
      return catalogBarcodeLookupSchema.parse({ outcome: 'stale-catalog' })
    }

    if (!status.isReadable) {
      return catalogBarcodeLookupSchema.parse({ outcome: 'unavailable-catalog' })
    }

    const products = this.repository.findProductsByBarcode(barcode)

    if (products.length === 0) {
      return catalogBarcodeLookupSchema.parse({ outcome: 'not-found' })
    }

    if (products.length > 1) {
      return catalogBarcodeLookupSchema.parse({ outcome: 'ambiguous' })
    }

    return catalogBarcodeLookupSchema.parse({ outcome: 'found', product: products[0] })
  }

  listPaymentMethods(): CatalogPaymentMethod[] {
    this.assertReadable()
    return this.repository.listPaymentMethods()
  }

  searchCustomers(input: CatalogCustomerSearchInput): CatalogCustomerPage {
    this.assertReadable()
    return this.repository.searchCustomers(input)
  }

  /**
   * Internal to the checkout preview authority. Deliberately not registered as an IPC channel:
   * the renderer never picks its own products/methods/customer, it only ever names uuids that a
   * later authoritative resolution re-checks from scratch.
   */
  resolveForCheckout(input: CheckoutResolutionInput): CheckoutResolution | null {
    this.assertReadable()
    return this.repository.resolveForCheckout(input)
  }

  /**
   * D2-B: the sellable-remaining quantity for one tracked product at one device/warehouse, computed
   * the same way the commit-time allocation split is (`usableGrantsForProduct` + `remainingMilli`
   * over immutable grants and committed local consumptions — never a cached/shared-stock number).
   * `null` for an untracked product, when no trusted time is available, or when the product does not
   * exist — the caller falls back to the product's plain cached `availableQuantity` in that case,
   * never to an unreserved warehouse total.
   */
  getAllocationRemaining(owner: CatalogAllocationOwner, productUuid: string): string | null {
    if (!this.stockAllocations) {
      throw new Error('CatalogService was constructed without a stock allocation repository')
    }

    this.assertReadable()
    const product = this.repository.getProduct(productUuid)
    if (!product || !product.trackStock) {
      return null
    }

    const trustedTime = this.clock.now()
    if (!trustedTime) {
      return null
    }

    const grants = this.stockAllocations.usableGrantsForProduct(
      owner,
      productUuid,
      trustedTime.now.toISOString()
    )
    const totalMilli = grants.reduce(
      (sum, grant) => sum + this.stockAllocations!.remainingMilli(grant.allocationUuid),
      0
    )

    return milliToQuantity(totalMilli)
  }

  getCustomer(uuid: string): CatalogCustomer {
    this.assertReadable()
    const customer = this.repository.getCustomer(uuid)

    if (!customer) {
      throw catalogError(
        'CATALOG_CUSTOMER_NOT_FOUND',
        'The customer is not available in this catalog.'
      )
    }

    return customer
  }

  private assertReadable(): CatalogSnapshot {
    this.readAccess.assertAllowed()
    const status = this.statusForEligibleContext()

    if (!status.isReadable) {
      throw catalogError(
        'CATALOG_UNAVAILABLE',
        'A complete local catalog is not available. Refresh workstation data when connected.'
      )
    }

    const snapshot = this.repository.getSnapshot()
    if (!snapshot) {
      throw catalogError('CATALOG_UNAVAILABLE', 'A complete local catalog is not available.')
    }

    return snapshot
  }

  private statusForEligibleContext(): CatalogStatus {
    const snapshot = this.repository.getSnapshot()
    if (!snapshot || !this.repository.isSnapshotIntact(snapshot)) {
      return unavailableStatus()
    }

    const trustedTime = this.clock.now()
    if (!trustedTime) {
      return unavailableStatus()
    }

    const generatedAt = Date.parse(snapshot.contract.generatedAt)
    const validUntil = Date.parse(snapshot.contract.validUntil)
    const now = trustedTime.now.getTime()

    if (!Number.isFinite(generatedAt) || !Number.isFinite(validUntil) || now < generatedAt) {
      return unavailableStatus()
    }

    if (now >= validUntil) {
      return catalogStatusSchema.parse({
        status: 'stale',
        isReadable: true,
        catalogValid: false,
        lastSyncedAt: snapshot.fetchedAt,
        contract: snapshot.contract
      })
    }

    // A detected wall-clock rollback is deliberately not an availability failure. The trusted
    // clock already floors `now` at the persisted high-water mark, so a rollback can never move a
    // stale catalog back inside its validity window; it only fails to advance time. Hiding rows
    // here would instead deny an authorized cashier the cached catalog the phase guarantees.
    const status = this.publishedRevision === snapshot.contract.revision ? 'fresh' : 'cached'
    return catalogStatusSchema.parse({
      status,
      isReadable: true,
      catalogValid: true,
      lastSyncedAt: snapshot.fetchedAt,
      contract: snapshot.contract
    })
  }
}
