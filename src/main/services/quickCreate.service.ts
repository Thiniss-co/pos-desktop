import { randomUUID } from 'node:crypto'
import { publicAppErrorSchema } from '@shared/contracts/api.contract'
import {
  quickCreateCustomerInputSchema,
  quickCreateProductInputSchema,
  quickCreateSupplierInputSchema,
  type QuickCreateCustomerInput,
  type QuickCreateEntity,
  type QuickCreateProductInput,
  type QuickCreateProductOptions,
  type QuickCreateRecord,
  type QuickCreateResubmitInput,
  type QuickCreateStatus,
  type QuickCreateSupplierInput
} from '@shared/contracts/quickCreate.contract'
import type { SqliteDatabase } from '../database/connection'
import type {
  LocalEntityRecord,
  NewRequest,
  OutboxRow,
  QuickCreateOwner,
  QuickCreateRepository
} from '../repositories/quickCreate.repository'
import { canonicalJson, sha256Hex } from './localSale.fingerprint'
import type { QuickCreateAccessService } from './quickCreateAccess.service'

export interface QuickCreateServiceDependencies {
  readonly database: SqliteDatabase
  readonly repository: QuickCreateRepository
  readonly access: Pick<QuickCreateAccessService, 'assertCanCreate' | 'access'>
  readonly session: {
    getContext(): {
      readonly isAuthenticated: boolean
      readonly userUuid: string | null
      readonly companyUuid: string | null
      readonly deviceUuid: string | null
    }
  }
  /** Kicks the outbox worker (fire-and-forget). */
  readonly requestSync: () => void
  /**
   * Refreshes the bootstrap (permissions). A blocked request is replayed only after a bootstrap
   * newer than its refusal, so Retry on a blocked row refreshes first.
   */
  readonly refreshAccess?: () => Promise<unknown>
  readonly now?: () => Date
  readonly createUuid?: () => string
}

function failure(
  category: 'validation' | 'authorization' | 'conflict',
  message: string,
  backendCode?: string
): never {
  throw publicAppErrorSchema.parse({
    category,
    message,
    retryable: false,
    ...(backendCode ? { backendCode } : {})
  })
}

/**
 * POS improvements, Stage 2 — register quick-create in main.
 *
 * Every create re-checks access (capability, feature, permission, snapshot owner) in main, freezes
 * one canonical payload in the server's own field names, and writes the entity mirror plus the
 * pending request atomically. Nothing waits for the network: the worker sends later, and a product
 * becomes sellable only once the installed catalog carries its server-issued revision.
 */
export class QuickCreateService {
  private readonly now: () => Date
  private readonly createUuid: () => string

  constructor(private readonly dependencies: QuickCreateServiceDependencies) {
    this.now = dependencies.now ?? ((): Date => new Date())
    this.createUuid = dependencies.createUuid ?? randomUUID
  }

  createCustomer(input: QuickCreateCustomerInput): QuickCreateRecord {
    this.dependencies.access.assertCanCreate('customer')
    const owner = this.owner()
    const row = this.dependencies.repository.create(
      this.customerRequest(owner, this.createUuid(), input)
    )
    this.dependencies.requestSync()
    return this.view(row, owner)
  }

  createSupplier(input: QuickCreateSupplierInput): QuickCreateRecord {
    this.dependencies.access.assertCanCreate('supplier')
    const owner = this.owner()
    const row = this.dependencies.repository.create(
      this.supplierRequest(owner, this.createUuid(), input)
    )
    this.dependencies.requestSync()
    return this.view(row, owner)
  }

  createProduct(input: QuickCreateProductInput): QuickCreateRecord {
    this.dependencies.access.assertCanCreate('product')
    const owner = this.owner()
    const row = this.dependencies.repository.create(
      this.productRequest(owner, this.createUuid(), input)
    )
    this.dependencies.requestSync()
    return this.view(row, owner)
  }

  /** Categories and taxes of the installed catalog, for the product dialog. */
  productOptions(): QuickCreateProductOptions {
    this.dependencies.access.assertCanCreate('product')
    const meta = this.catalogCurrency()
    const categories = this.dependencies.database
      .prepare(
        'SELECT uuid, name FROM catalog_categories WHERE is_active = 1 ORDER BY search_name, uuid'
      )
      .all() as Array<{ uuid: string; name: string }>
    const taxes = this.dependencies.database
      .prepare(
        "SELECT id AS uuid, name, rate FROM taxes WHERE is_active = 1 AND (type IS NULL OR type = 'percentage') ORDER BY name, id"
      )
      .all() as Array<{ uuid: string; name: string; rate: number }>
    return {
      currency: meta.currency,
      currencyExponent: meta.exponent,
      categories,
      taxes: taxes.map((tax) => ({
        uuid: tax.uuid,
        name: tax.name,
        rateLabel: `${Number(tax.rate)}%`
      }))
    }
  }

  /** This company's requests on this register (every creator), newest first. */
  list(): QuickCreateRecord[] {
    const owner = this.ownerOrNull()
    if (owner === null) {
      return []
    }
    return this.dependencies.repository
      .listForCompany(owner.companyUuid)
      .map((row) => this.view(row, owner))
  }

  /** Retry a blocked or unknown request now (same key and bytes); the worker decides eligibility. */
  retry(requestKey: string): QuickCreateRecord {
    const owner = this.owner()
    const row = this.mine(requestKey, owner)
    if (row.state === 'blocked_permission') {
      const refresh = this.dependencies.refreshAccess
      if (refresh) {
        // The bootstrap callback re-runs the worker; nothing is sent if the server still says no.
        void refresh()
          .catch(() => undefined)
          .finally(() => this.dependencies.requestSync())
        return this.view(row, owner)
      }
      this.dependencies.access.assertCanCreate(row.entityType)
    } else if (row.state !== 'unknown' && row.state !== 'pending') {
      failure('conflict', 'Only a waiting request can be retried.')
    }
    this.dependencies.requestSync()
    return this.view(row, owner)
  }

  /**
   * Hands another user's request that provably never left this register (`pending`, no dispatch
   * evidence) to the signed-in user, who must be allowed to create it. Audited; the entity id stays.
   */
  reassign(requestKey: string): QuickCreateRecord {
    const owner = this.owner()
    const old = this.dependencies.repository.find(requestKey)
    if (!old || old.companyUuid !== owner.companyUuid || old.deviceUuid !== owner.deviceUuid) {
      failure('validation', 'This request is not on this register.')
    }
    this.dependencies.access.assertCanCreate(old.entityType)
    const replacement: NewRequest = {
      requestKey: this.createUuid(),
      clientEntityUuid: old.clientEntityUuid,
      owner,
      canonicalPayloadJson: old.canonicalPayloadJson,
      payloadSha256: old.payloadSha256,
      record: this.recordFromPayload(old.entityType, old.canonicalPayloadJson),
      now: this.now().toISOString()
    }
    if (this.dependencies.repository.reassign(requestKey, replacement, owner) !== 'reassigned') {
      failure(
        'conflict',
        'This request may already have been sent, so it cannot be handed over. Ask its creator to sign in.',
        'QUICK_CREATE_NOT_REASSIGNABLE'
      )
    }
    this.dependencies.requestSync()
    return this.view(this.dependencies.repository.find(replacement.requestKey)!, owner)
  }

  /** A corrected request for the same entity id after a durable refusal or a key conflict. */
  resubmit(input: QuickCreateResubmitInput): QuickCreateRecord {
    const owner = this.owner()
    const old = this.dependencies.repository.find(input.requestKey)
    if (
      !old ||
      old.companyUuid !== owner.companyUuid ||
      old.deviceUuid !== owner.deviceUuid ||
      old.entityType !== input.entityType
    ) {
      failure('validation', 'This request is not on this register.')
    }
    this.dependencies.access.assertCanCreate(old.entityType)
    const replacement =
      input.entityType === 'customer'
        ? this.customerRequest(owner, old.clientEntityUuid, input.fields)
        : input.entityType === 'supplier'
          ? this.supplierRequest(owner, old.clientEntityUuid, input.fields)
          : this.productRequest(owner, old.clientEntityUuid, input.fields)
    if (this.dependencies.repository.resubmit(input.requestKey, replacement) !== 'resubmitted') {
      failure(
        'conflict',
        'Only a refused request can be corrected, once.',
        'QUICK_CREATE_NOT_RESUBMITTABLE'
      )
    }
    this.dependencies.requestSync()
    return this.view(this.dependencies.repository.find(replacement.requestKey)!, owner)
  }

  private customerRequest(
    owner: QuickCreateOwner,
    uuid: string,
    raw: QuickCreateCustomerInput
  ): NewRequest {
    const input = quickCreateCustomerInputSchema.parse(raw)
    const payload = {
      name: input.name,
      phone: input.phone ?? null,
      email: input.email ?? null,
      tax_number: input.taxNumber ?? null,
      address: input.address ?? null,
      notes: input.notes ?? null
    }
    return this.request(owner, uuid, payload, {
      type: 'customer',
      name: input.name,
      phone: payload.phone,
      email: payload.email,
      taxNumber: payload.tax_number,
      address: payload.address,
      notes: payload.notes
    })
  }

  private supplierRequest(
    owner: QuickCreateOwner,
    uuid: string,
    raw: QuickCreateSupplierInput
  ): NewRequest {
    const input = quickCreateSupplierInputSchema.parse(raw)
    const payload = {
      name: input.name,
      contact_person: input.contactPerson ?? null,
      phone: input.phone ?? null,
      email: input.email ?? null,
      tax_number: input.taxNumber ?? null
    }
    return this.request(owner, uuid, payload, {
      type: 'supplier',
      name: input.name,
      contactPerson: payload.contact_person,
      phone: payload.phone,
      email: payload.email,
      taxNumber: payload.tax_number
    })
  }

  private productRequest(
    owner: QuickCreateOwner,
    uuid: string,
    raw: QuickCreateProductInput
  ): NewRequest {
    const input = quickCreateProductInputSchema.parse(raw)
    const { currency, exponent } = this.catalogCurrency()
    const category = this.dependencies.database
      .prepare('SELECT uuid FROM catalog_categories WHERE uuid = ? AND is_active = 1')
      .get(input.categoryUuid)
    if (!category) {
      failure('validation', 'Choose a category from this register’s catalog.')
    }
    if (input.taxUuid !== null) {
      const tax = this.dependencies.database
        .prepare('SELECT id FROM taxes WHERE id = ? AND is_active = 1')
        .get(input.taxUuid)
      if (!tax) {
        failure('validation', 'Choose a tax from this register’s catalog.')
      }
    }
    const priceAmount = toMinorUnits(input.price, exponent)
    const payload = {
      name: input.name,
      sku: input.sku ?? null,
      barcode: input.barcode ?? null,
      price: priceAmount,
      category_uuid: input.categoryUuid,
      tax_uuid: input.taxUuid,
      tax_mode: input.taxMode,
      unit: input.unit ?? null,
      track_stock: input.trackStock ?? true
    }
    return this.request(owner, uuid, payload, {
      type: 'product',
      name: input.name,
      sku: payload.sku,
      barcode: payload.barcode,
      priceAmount,
      currency,
      categoryUuid: input.categoryUuid,
      taxUuid: input.taxUuid,
      taxMode: input.taxMode,
      unit: payload.unit,
      trackStock: payload.track_stock
    })
  }

  private request(
    owner: QuickCreateOwner,
    uuid: string,
    payload: Record<string, unknown>,
    record: LocalEntityRecord
  ): NewRequest {
    const canonical = canonicalJson(payload)
    return {
      requestKey: this.createUuid(),
      clientEntityUuid: uuid,
      owner,
      canonicalPayloadJson: canonical,
      payloadSha256: sha256Hex(canonical),
      record,
      now: this.now().toISOString()
    }
  }

  private recordFromPayload(type: QuickCreateEntity, canonical: string): LocalEntityRecord {
    const payload = JSON.parse(canonical) as Record<string, never>
    if (type === 'customer') {
      return {
        type,
        name: payload.name,
        phone: payload.phone,
        email: payload.email,
        taxNumber: payload.tax_number,
        address: payload.address,
        notes: payload.notes
      }
    }
    if (type === 'supplier') {
      return {
        type,
        name: payload.name,
        contactPerson: payload.contact_person,
        phone: payload.phone,
        email: payload.email,
        taxNumber: payload.tax_number
      }
    }
    return {
      type,
      name: payload.name,
      sku: payload.sku,
      barcode: payload.barcode,
      priceAmount: payload.price,
      currency: this.catalogCurrency().currency,
      categoryUuid: payload.category_uuid,
      taxUuid: payload.tax_uuid,
      taxMode: payload.tax_mode,
      unit: payload.unit,
      trackStock: payload.track_stock
    }
  }

  private catalogCurrency(): { currency: string; exponent: number } {
    const row = this.dependencies.database
      .prepare('SELECT currency, currency_exponent FROM catalog_metadata WHERE id = 1')
      .get() as { currency: string; currency_exponent: number } | undefined
    if (!row) {
      failure('validation', 'Refresh workstation data before adding products.')
    }
    return { currency: row.currency, exponent: row.currency_exponent }
  }

  private status(row: OutboxRow, owner: QuickCreateOwner): QuickCreateStatus {
    switch (row.state) {
      case 'pending':
        return row.creatorUserUuid === owner.userUuid ? 'pending_sync' : 'waiting_for_creator'
      case 'dispatching':
      case 'unknown':
        return 'pending_sync'
      case 'blocked_permission':
        return 'blocked'
      case 'refused':
        return 'refused'
      case 'conflict':
        return 'conflict'
      case 'superseded':
        return 'superseded'
      case 'accepted':
        if (row.entityType !== 'product') {
          return 'created'
        }
        // Ready to sell only once the INSTALLED catalog carries this product's issued revision.
        return this.dependencies.database
          .prepare(
            'SELECT 1 FROM catalog_products WHERE uuid = ? AND price_revision IS NOT NULL AND length(price_revision) = 64'
          )
          .get(row.clientEntityUuid)
          ? 'ready_to_sell'
          : 'awaiting_catalog'
    }
  }

  private view(row: OutboxRow, owner: QuickCreateOwner): QuickCreateRecord {
    const status = this.status(row, owner)
    const mine = row.creatorUserUuid === owner.userUuid
    let fields: Record<string, string[]> | null = null
    if (row.resultFieldsJson) {
      try {
        fields = JSON.parse(row.resultFieldsJson) as Record<string, string[]>
      } catch {
        fields = null
      }
    }
    return {
      requestKey: row.requestKey,
      entityType: row.entityType,
      entityUuid: row.clientEntityUuid,
      name: this.dependencies.repository.recordName(row.entityType, row.clientEntityUuid) ?? '',
      status,
      mine,
      resultCode: row.resultCode,
      resultMessage: row.resultMessage,
      resultFields: fields,
      traceId: row.traceId,
      sendCount: row.dispatchCount,
      createdAt: row.createdAt,
      resubmittedAs: row.resubmittedAsRequestKey,
      actions: {
        retry: mine && (row.state === 'blocked_permission' || row.state === 'unknown'),
        reassign: !mine && row.state === 'pending' && row.dispatchCount === 0,
        resubmit:
          (row.state === 'refused' || row.state === 'conflict') &&
          row.resubmittedAsRequestKey === null
      }
    }
  }

  private mine(requestKey: string, owner: QuickCreateOwner): OutboxRow {
    const row = this.dependencies.repository.find(requestKey)
    if (
      !row ||
      row.companyUuid !== owner.companyUuid ||
      row.deviceUuid !== owner.deviceUuid ||
      row.creatorUserUuid !== owner.userUuid
    ) {
      failure('validation', 'This request is not yours on this register.')
    }
    return row
  }

  private ownerOrNull(): QuickCreateOwner | null {
    const context = this.dependencies.session.getContext()
    if (
      !context.isAuthenticated ||
      !context.userUuid ||
      !context.companyUuid ||
      !context.deviceUuid
    ) {
      return null
    }
    return {
      companyUuid: context.companyUuid,
      deviceUuid: context.deviceUuid,
      userUuid: context.userUuid
    }
  }

  private owner(): QuickCreateOwner {
    const owner = this.ownerOrNull()
    if (owner === null) {
      failure('authorization', 'Sign in to create records on this register.', 'PERMISSION_DENIED')
    }
    return owner
  }
}

/** "12.5" with exponent 2 → 1250. Refuses more fraction digits than the currency has. */
export function toMinorUnits(decimal: string, exponent: number): number {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(decimal.trim())
  if (!match) {
    failure('validation', 'Enter the price as a number.')
  }
  const fraction = match[2] ?? ''
  if (fraction.length > exponent && /[1-9]/.test(fraction.slice(exponent))) {
    failure('validation', `The price can have at most ${exponent} decimal places.`)
  }
  const minor =
    Number(match[1]) * 10 ** exponent +
    Number((fraction + '0'.repeat(exponent)).slice(0, exponent) || '0')
  if (!Number.isSafeInteger(minor) || minor > 1_000_000_000) {
    failure('validation', 'The price is too large.')
  }
  return minor
}
