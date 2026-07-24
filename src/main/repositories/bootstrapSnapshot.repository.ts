import type { DesktopBootstrapResource } from '../http/desktopResources.contract'
import type { SqliteDatabase } from '../database/connection'

export interface BootstrapPersistResult {
  readonly snapshotVersion: string
  readonly serverTime: string
  readonly counts: Record<string, number>
}

function bit(value: boolean): number {
  return value ? 1 : 0
}

function decimal(value: number | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toFixed(3)
}

/**
 * Persists a full desktop bootstrap snapshot as one atomic replace-in-transaction. Phase 2 only
 * performs full (non-incremental) bootstrap, so each entity table is fully replaced; incremental
 * upsert/tombstone handling is deferred to a later phase.
 */
export class BootstrapSnapshotRepository {
  constructor(private readonly database: SqliteDatabase) {}

  persistSnapshot(resource: DesktopBootstrapResource, fetchedAt: string): BootstrapPersistResult {
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

      counts.categories = this.replaceCollection('categories', resource.categories ?? [], (row) =>
        this.database
          .prepare('INSERT INTO categories (uuid, name, is_active, updated_at) VALUES (?, ?, ?, ?)')
          .run(row.id, row.name, bit(row.is_active), row.updated_at ?? null)
      )

      counts.products = this.replaceCollection('products', resource.products ?? [], (row) =>
        this.database
          .prepare(
            `
              INSERT INTO products (
                uuid, server_id, company_id, category_id, name, sku, barcode, description,
                status, is_active, track_stock, unit, tax_mode, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
          )
          .run(
            row.uuid,
            row.server_id,
            row.company_id,
            row.category_id ?? null,
            row.name,
            row.sku ?? null,
            row.barcode ?? null,
            row.description ?? null,
            row.status ?? null,
            bit(row.is_active),
            bit(row.track_stock),
            row.unit ?? null,
            row.tax_mode ?? null,
            row.updated_at ?? null
          )
      )

      counts.product_barcodes = this.replaceCollection(
        'product_barcodes',
        resource.product_barcodes ?? [],
        (row) =>
          this.database
            .prepare(
              `
                INSERT INTO product_barcodes (id, product_id, barcode, type, is_primary, is_active, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
              `
            )
            .run(
              row.id,
              row.product_id,
              row.barcode,
              row.type ?? null,
              bit(row.is_primary),
              bit(row.is_active),
              row.updated_at ?? null
            )
      )

      counts.product_prices = this.replaceCollection(
        'product_prices',
        resource.product_prices ?? [],
        (row) =>
          this.database
            .prepare(
              `
                INSERT INTO product_prices (id, product_id, label, amount, currency, price_type, is_active, starts_at, ends_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `
            )
            .run(
              row.id,
              row.product_id,
              row.label ?? null,
              row.amount,
              row.currency,
              row.price_type ?? null,
              bit(row.is_active),
              row.starts_at ?? null,
              row.ends_at ?? null,
              row.updated_at ?? null
            )
      )

      counts.stock_items = this.replaceCollection(
        'stock_items',
        resource.stock_items ?? [],
        (row) =>
          this.database
            .prepare(
              `
              INSERT INTO stock_items (
                id, product_id, warehouse_id, quantity, reserved_quantity, available_quantity,
                minimum_quantity, maximum_quantity, is_active, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
            )
            .run(
              row.id,
              row.product_id,
              row.warehouse_id,
              decimal(row.quantity),
              decimal(row.reserved_quantity),
              decimal(row.available_quantity),
              decimal(row.minimum_quantity),
              decimal(row.maximum_quantity),
              bit(row.is_active),
              row.updated_at ?? null
            )
      )

      counts.taxes = this.replaceCollection('taxes', resource.taxes ?? [], (row) =>
        this.database
          .prepare(
            `
              INSERT INTO taxes (id, name, code, rate, type, is_default, is_active, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `
          )
          .run(
            row.id,
            row.name,
            row.code ?? null,
            row.rate,
            row.type ?? null,
            bit(row.is_default),
            bit(row.is_active),
            row.updated_at ?? null
          )
      )

      counts.payment_methods = this.replaceCollection(
        'payment_methods',
        resource.payment_methods ?? [],
        (row) =>
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

      counts.customers = this.replaceCollection('customers', resource.customers ?? [], (row) =>
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

  getPermissions(): string[] {
    const rows = this.database
      .prepare('SELECT permission_name FROM bootstrap_permissions ORDER BY permission_name')
      .all() as Array<{ permission_name: string }>

    return rows.map((row) => row.permission_name)
  }

  getLimit(key: string): number | null {
    const row = this.database
      .prepare('SELECT limit_value FROM bootstrap_limits WHERE limit_key = ?')
      .get(key) as { limit_value: number | null } | undefined

    return row?.limit_value ?? null
  }

  private replaceCollection<T>(
    table: string,
    rows: readonly T[],
    insert: (row: T) => void
  ): number {
    this.database.prepare(`DELETE FROM ${table}`).run()

    for (const row of rows) {
      insert(row)
    }

    return rows.length
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
