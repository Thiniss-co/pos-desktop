import type { DesktopBootstrapResource } from '../http/desktopResources.contract'
import type { SqliteDatabase } from '../database/connection'

export interface BootstrapPersistResult {
  readonly snapshotVersion: string
  readonly serverTime: string
  readonly counts: Record<string, number>
}

export interface BootstrapCompany {
  readonly companyUuid: string
  readonly name: string
  readonly isActive: boolean
  readonly updatedAt: string
}

function bit(value: boolean): number {
  return value ? 1 : 0
}

function decimal(value: number | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toFixed(3)
}

function normalizeSearch(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
}

function assertCatalogSemantics(resource: DesktopBootstrapResource): void {
  const contract = resource.catalog_contract
  const generatedAt = Date.parse(contract.generated_at)
  const validUntil = Date.parse(contract.valid_until)

  if (!Number.isFinite(generatedAt) || !Number.isFinite(validUntil) || generatedAt >= validUntil) {
    throw new Error('The sellable catalog validity window is invalid')
  }

  const activeCategories = new Set(
    (resource.categories ?? [])
      .filter((category) => category.is_active)
      .map((category) => category.id)
  )

  for (const product of resource.products ?? []) {
    if (!product.is_active) {
      continue
    }

    if (
      product.status !== 'active' ||
      !product.category_uuid ||
      !activeCategories.has(product.category_uuid) ||
      !product.resolved_price ||
      !product.resolved_tax
    ) {
      throw new Error('An active catalog product is missing its sellable snapshot')
    }

    const price = product.resolved_price
    const tax = product.resolved_tax

    if (
      Date.parse(price.valid_from) > generatedAt ||
      price.valid_until !== contract.valid_until ||
      price.amount > contract.maximum_unit_price ||
      (tax.mode === 'none' && (tax.id !== null || tax.rate_basis_points !== 0)) ||
      (tax.mode !== 'none' && tax.id === null)
    ) {
      throw new Error('A catalog product conflicts with the issued calculation contract')
    }
  }
}

/**
 * Persists a full desktop bootstrap snapshot as one atomic replace-in-transaction. Phase 2 only
 * performs full (non-incremental) bootstrap, so each entity table is fully replaced; incremental
 * upsert/tombstone handling is deferred to a later phase.
 */
export class BootstrapSnapshotRepository {
  constructor(private readonly database: SqliteDatabase) {}

  persistSnapshot(resource: DesktopBootstrapResource, fetchedAt: string): BootstrapPersistResult {
    assertCatalogSemantics(resource)
    const counts: Record<string, number> = {}

    const commit = this.database.transaction(() => {
      this.database
        .prepare(
          `
            INSERT INTO bootstrap_company (id, company_uuid, name, is_active, updated_at)
            VALUES (1, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              company_uuid = excluded.company_uuid,
              name = excluded.name,
              is_active = excluded.is_active,
              updated_at = excluded.updated_at
          `
        )
        .run(resource.company.id, resource.company.name, bit(resource.company.is_active), fetchedAt)

      this.replaceBranch(resource.branch, fetchedAt)
      this.replaceWarehouse(resource.warehouse, fetchedAt)
      this.replaceSubscription(resource.subscription, fetchedAt)
      this.persistDeviceRegistration(resource.device, fetchedAt)

      this.database.prepare('DELETE FROM bootstrap_features').run()
      for (const [code, enabled] of Object.entries(resource.features)) {
        this.database
          .prepare(
            'INSERT INTO bootstrap_features (feature_code, is_enabled, updated_at) VALUES (?, ?, ?)'
          )
          .run(code, bit(enabled), fetchedAt)
      }

      this.database.prepare('DELETE FROM bootstrap_limits').run()
      for (const [key, value] of Object.entries(resource.limits)) {
        this.database
          .prepare(
            'INSERT INTO bootstrap_limits (limit_key, limit_value, updated_at) VALUES (?, ?, ?)'
          )
          .run(key, value, fetchedAt)
      }

      this.database.prepare('DELETE FROM bootstrap_permissions').run()
      for (const permission of resource.permissions) {
        this.database
          .prepare('INSERT INTO bootstrap_permissions (permission_name, updated_at) VALUES (?, ?)')
          .run(permission, fetchedAt)
      }

      this.database
        .prepare(
          `
            INSERT INTO bootstrap_role (id, name, updated_at) VALUES (1, ?, ?)
            ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
          `
        )
        .run(resource.role.name, fetchedAt)

      // The Phase 3 sellable catalogue is isolated from the legacy Phase 2 numeric-ID tables.
      // Existing legacy rows remain available for diagnostics after migration but are never used
      // to authorize or calculate a new cart. Replacement keeps foreign keys enabled throughout.
      this.clearSellableCatalogue()

      const contract = resource.catalog_contract
      this.database
        .prepare(
          `
            INSERT INTO catalog_metadata (
              id, revision, generated_at, valid_until, quantity_scale, minimum_quantity,
              maximum_quantity, maximum_unit_price, maximum_line_total, maximum_invoice_total,
              mixed_tax_mode_policy, fetched_at
            ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          contract.revision,
          contract.generated_at,
          contract.valid_until,
          contract.quantity_scale,
          contract.minimum_quantity,
          contract.maximum_quantity,
          contract.maximum_unit_price,
          contract.maximum_line_total,
          contract.maximum_invoice_total,
          contract.mixed_tax_mode_policy,
          fetchedAt
        )

      counts.categories = this.replaceCollection(resource.categories ?? [], (row) =>
        this.database
          .prepare(
            `
              INSERT INTO catalog_categories (uuid, name, search_name, is_active, updated_at)
              VALUES (?, ?, ?, ?, ?)
            `
          )
          .run(
            row.id,
            row.name,
            normalizeSearch(row.name),
            bit(row.is_active),
            row.updated_at ?? null
          )
      )

      counts.products = this.replaceCollection(resource.products ?? [], (row) =>
        this.database
          .prepare(
            `
              INSERT INTO catalog_products (
                uuid, category_uuid, name, search_name, sku, search_sku, barcode, description,
                status, is_active, track_stock, unit, price_amount, price_currency, price_source,
                price_revision, price_valid_from, price_valid_until, tax_uuid, tax_mode,
                tax_rate_basis_points, tax_revision, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
          )
          .run(
            row.uuid,
            row.category_uuid,
            row.name,
            normalizeSearch(row.name),
            row.sku ?? null,
            row.sku ? normalizeSearch(row.sku) : null,
            row.barcode ?? null,
            row.description ?? null,
            row.status ?? 'inactive',
            bit(row.is_active),
            bit(row.track_stock),
            row.unit ?? null,
            row.resolved_price?.amount ?? null,
            row.resolved_price?.currency ?? null,
            row.resolved_price?.source ?? null,
            row.resolved_price?.revision ?? null,
            row.resolved_price?.valid_from ?? null,
            row.resolved_price?.valid_until ?? null,
            row.resolved_tax?.id ?? null,
            row.resolved_tax?.mode ?? null,
            row.resolved_tax?.rate_basis_points ?? null,
            row.resolved_tax?.revision ?? null,
            row.updated_at ?? null
          )
      )

      counts.product_barcodes = this.replaceCollection(resource.product_barcodes ?? [], (row) =>
        this.database
          .prepare(
            `
                INSERT INTO catalog_product_barcodes (
                  uuid, product_uuid, barcode, type, is_primary, is_active, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
              `
          )
          .run(
            row.id,
            row.product_uuid,
            row.barcode,
            row.type ?? null,
            bit(row.is_primary),
            bit(row.is_active),
            row.updated_at ?? null
          )
      )

      // Raw ProductPrice and Tax collections are deliberately non-authoritative. Their exact
      // calculation-ready values are persisted on catalog_products from resolved_price/tax.
      counts.product_prices = resource.product_prices?.length ?? 0

      counts.stock_items = this.replaceCollection(resource.stock_items ?? [], (row) =>
        this.database
          .prepare(
            `
              INSERT INTO catalog_stock_items (
                uuid, product_uuid, warehouse_uuid, quantity, reserved_quantity, available_quantity,
                minimum_quantity, maximum_quantity, is_active, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
          )
          .run(
            row.id,
            row.product_uuid,
            row.warehouse_uuid,
            decimal(row.quantity),
            decimal(row.reserved_quantity),
            decimal(row.available_quantity),
            decimal(row.minimum_quantity),
            decimal(row.maximum_quantity),
            bit(row.is_active),
            row.updated_at ?? null
          )
      )

      counts.taxes = resource.taxes?.length ?? 0

      this.database.prepare('DELETE FROM payment_methods').run()
      this.database.prepare('DELETE FROM customers').run()

      counts.payment_methods = this.replaceCollection(resource.payment_methods ?? [], (row) =>
        this.database
          .prepare(
            `
                INSERT INTO payment_methods (
                  id, name, code, type, is_active, allows_change, requires_reference, sort_order, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              `
          )
          .run(
            row.id,
            row.name,
            row.code ?? null,
            row.type ?? null,
            bit(row.is_active),
            bit(row.allows_change),
            bit(row.requires_reference),
            row.sort_order,
            row.updated_at ?? null
          )
      )

      counts.customers = this.replaceCollection(resource.customers ?? [], (row) =>
        this.database
          .prepare(
            `
              INSERT INTO customers (id, name, email, phone, tax_number, address, notes, is_active, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
          )
          .run(
            row.id,
            row.name,
            row.email ?? null,
            row.phone ?? null,
            row.tax_number ?? null,
            row.address ?? null,
            row.notes ?? null,
            bit(row.is_active),
            row.updated_at ?? null
          )
      )
    })

    commit()

    return {
      snapshotVersion: resource.sync.snapshot_version,
      serverTime: resource.server_time,
      counts
    }
  }

  hasPermission(permission: string): boolean {
    const row = this.database
      .prepare('SELECT 1 AS present FROM bootstrap_permissions WHERE permission_name = ?')
      .get(permission) as { readonly present: number } | undefined

    return Boolean(row?.present)
  }

  getPermissions(): string[] {
    const rows = this.database
      .prepare('SELECT permission_name FROM bootstrap_permissions ORDER BY permission_name')
      .all() as Array<{ permission_name: string }>

    return rows.map((row) => row.permission_name)
  }

  getCompany(): BootstrapCompany | null {
    const row = this.database
      .prepare(
        'SELECT company_uuid, name, is_active, updated_at FROM bootstrap_company WHERE id = 1'
      )
      .get() as
      | {
          readonly company_uuid: string
          readonly name: string
          readonly is_active: number
          readonly updated_at: string
        }
      | undefined

    return row
      ? {
          companyUuid: row.company_uuid,
          name: row.name,
          isActive: row.is_active === 1,
          updatedAt: row.updated_at
        }
      : null
  }

  isFeatureEnabled(code: string): boolean {
    const row = this.database
      .prepare('SELECT is_enabled FROM bootstrap_features WHERE feature_code = ?')
      .get(code) as { readonly is_enabled: number } | undefined

    return row?.is_enabled === 1
  }

  getLimit(key: string): number | null {
    const row = this.database
      .prepare('SELECT limit_value FROM bootstrap_limits WHERE limit_key = ?')
      .get(key) as { limit_value: number | null } | undefined

    return row?.limit_value ?? null
  }

  private replaceCollection<T>(rows: readonly T[], insert: (row: T) => void): number {
    for (const row of rows) {
      insert(row)
    }

    return rows.length
  }

  private clearSellableCatalogue(): void {
    for (const table of [
      'catalog_product_barcodes',
      'catalog_stock_items',
      'catalog_products',
      'catalog_categories',
      'catalog_metadata'
    ]) {
      this.database.prepare(`DELETE FROM ${table}`).run()
    }
  }

  private replaceBranch(branch: DesktopBootstrapResource['branch'], fetchedAt: string): void {
    if (!branch) {
      this.database.prepare('DELETE FROM bootstrap_branch WHERE id = 1').run()
      return
    }

    this.database
      .prepare(
        `
          INSERT INTO bootstrap_branch (id, branch_uuid, name, is_active, updated_at)
          VALUES (1, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            branch_uuid = excluded.branch_uuid,
            name = excluded.name,
            is_active = excluded.is_active,
            updated_at = excluded.updated_at
        `
      )
      .run(branch.id, branch.name, bit(branch.is_active), fetchedAt)
  }

  private persistDeviceRegistration(
    device: DesktopBootstrapResource['device'],
    fetchedAt: string
  ): void {
    this.database
      .prepare(
        `
          INSERT INTO device_registration (id, server_device_id, status, last_seen_at, updated_at)
          VALUES (1, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            server_device_id = excluded.server_device_id,
            status = excluded.status,
            last_seen_at = excluded.last_seen_at,
            updated_at = excluded.updated_at
        `
      )
      .run(device.id, device.status ?? 'unknown', device.last_seen_at ?? null, fetchedAt)
  }

  private replaceWarehouse(
    warehouse: DesktopBootstrapResource['warehouse'],
    fetchedAt: string
  ): void {
    if (!warehouse) {
      this.database.prepare('DELETE FROM bootstrap_warehouse WHERE id = 1').run()
      return
    }

    this.database
      .prepare(
        `
          INSERT INTO bootstrap_warehouse (id, warehouse_uuid, name, is_active, updated_at)
          VALUES (1, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            warehouse_uuid = excluded.warehouse_uuid,
            name = excluded.name,
            is_active = excluded.is_active,
            updated_at = excluded.updated_at
        `
      )
      .run(warehouse.id, warehouse.name, bit(warehouse.is_active), fetchedAt)
  }

  private replaceSubscription(
    subscription: DesktopBootstrapResource['subscription'],
    fetchedAt: string
  ): void {
    if (!subscription) {
      this.database.prepare('DELETE FROM bootstrap_subscription WHERE id = 1').run()
      return
    }

    this.database
      .prepare(
        `
          INSERT INTO bootstrap_subscription (
            id, plan_code, plan_name, status, billing_cycle, starts_at, renews_at, expires_at, grace_ends_at, updated_at
          ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            plan_code = excluded.plan_code,
            plan_name = excluded.plan_name,
            status = excluded.status,
            billing_cycle = excluded.billing_cycle,
            starts_at = excluded.starts_at,
            renews_at = excluded.renews_at,
            expires_at = excluded.expires_at,
            grace_ends_at = excluded.grace_ends_at,
            updated_at = excluded.updated_at
        `
      )
      .run(
        subscription.plan_code,
        subscription.plan_name,
        subscription.status,
        subscription.billing_cycle,
        subscription.starts_at,
        subscription.renews_at,
        subscription.expires_at,
        subscription.grace_ends_at,
        fetchedAt
      )
  }
}
