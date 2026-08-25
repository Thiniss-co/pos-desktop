import { z } from 'zod'

const isoSecondTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/)
const sha256RevisionSchema = z.string().regex(/^[a-f0-9]{64}$/)
const currencySchema = z.string().regex(/^[A-Z]{3}$/)
const taxModeSchema = z.enum(['none', 'inclusive', 'exclusive'])
const shiftMoneySchema = z.number().int().min(0).max(2_147_483_647)
const signedShiftMoneySchema = z.number().int().min(-2_147_483_648).max(2_147_483_647)

/**
 * Raw Laravel API Resource shapes for the desktop endpoints, transcribed from the actual
 * backend source (pos-backend). These are main-process-only: they carry secrets (the desktop
 * token, the license JWT) and backend-internal id conventions that must never reach the
 * renderer. Main services parse responses against these schemas, then build sanitized,
 * renderer-facing types (see src/shared/contracts/*).
 */

const accessDecisionResourceSchema = z
  .object({
    is_active: z.boolean(),
    is_trial: z.boolean(),
    is_in_grace: z.boolean(),
    is_expired: z.boolean(),
    is_suspended: z.boolean(),
    can_login: z.boolean(),
    can_sell: z.boolean(),
    can_sync: z.boolean(),
    can_activate_device: z.boolean(),
    restriction_level: z.string(),
    warning_message: z.string().nullable().optional()
  })
  .passthrough()

const namedActiveRefResourceSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    is_active: z.boolean()
  })
  .passthrough()

const desktopDeviceResourceSchema = z
  .object({
    id: z.string(),
    device_uuid: z.uuid(),
    device_name: z.string(),
    platform: z.string(),
    status: z.string().nullable().optional(),
    last_seen_at: z.string().nullable().optional(),
    last_license_validated_at: z.string().nullable().optional()
  })
  .passthrough()

const authUserResourceSchema = z
  .object({
    id: z.number(),
    uuid: z.uuid(),
    name: z.string(),
    email: z.string(),
    company_id: z.number().nullable().optional(),
    is_active: z.boolean(),
    roles: z.array(z.string()),
    permissions: z.array(z.string())
  })
  .passthrough()

export const deviceRegisterResourceSchema = z
  .object({
    id: z.string(),
    device_uuid: z.uuid(),
    device_name: z.string(),
    platform: z.string(),
    os_version: z.string().nullable().optional(),
    app_version: z.string().nullable().optional(),
    status: z.string(),
    last_seen_at: z.string().nullable().optional(),
    last_license_validated_at: z.string().nullable().optional(),
    blocked_at: z.string().nullable().optional(),
    blocked_reason: z.string().nullable().optional(),
    revoked_at: z.string().nullable().optional(),
    created_at: z.string(),
    updated_at: z.string()
  })
  .passthrough()

export type DeviceRegisterResource = z.infer<typeof deviceRegisterResourceSchema>

export const desktopSessionResourceSchema = z
  .object({
    token: z.string(),
    token_type: z.literal('Bearer'),
    abilities: z.array(z.string()),
    user: authUserResourceSchema,
    device: desktopDeviceResourceSchema,
    company: namedActiveRefResourceSchema.nullable().optional(),
    branch: namedActiveRefResourceSchema.nullable().optional(),
    warehouse: namedActiveRefResourceSchema.nullable().optional(),
    access: accessDecisionResourceSchema.extend({ allowed: z.boolean() })
  })
  .passthrough()

export type DesktopSessionResource = z.infer<typeof desktopSessionResourceSchema>

export const desktopUserContextResourceSchema = z
  .object({
    user: authUserResourceSchema,
    device: desktopDeviceResourceSchema,
    company: namedActiveRefResourceSchema,
    branch: namedActiveRefResourceSchema.nullable().optional(),
    warehouse: namedActiveRefResourceSchema.nullable().optional(),
    access: accessDecisionResourceSchema.extend({ allowed: z.boolean() })
  })
  .passthrough()

export const licenseResourceSchema = z
  .object({
    token: z.string(),
    expires_at: z.string(),
    access: accessDecisionResourceSchema,
    server_time: z.string(),
    last_validated_at: z.string(),
    next_validation_due_at: z.string(),
    max_offline_hours: z.number().int().positive(),
    subscription: z
      .object({
        status: z.string(),
        expires_at: z.string().nullable(),
        grace_ends_at: z.string().nullable()
      })
      .passthrough()
      .nullable()
  })
  .passthrough()

export type LicenseResource = z.infer<typeof licenseResourceSchema>

const subscriptionResourceSchema = z
  .object({
    plan_code: z.string().nullable(),
    plan_name: z.string().nullable(),
    status: z.string(),
    billing_cycle: z.string(),
    starts_at: z.string().nullable(),
    renews_at: z.string().nullable(),
    expires_at: z.string().nullable(),
    grace_ends_at: z.string().nullable()
  })
  .passthrough()

const syncEntityCountResourceSchema = z
  .object({
    count: z.number().int().nonnegative(),
    last_changed_at: z.string().nullable()
  })
  .passthrough()

const categoryResourceSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    is_active: z.boolean(),
    updated_at: z.string().nullable().optional()
  })
  .passthrough()

const productResourceSchema = z
  .object({
    uuid: z.uuid(),
    category_uuid: z.uuid().nullable(),
    name: z.string(),
    sku: z.string().nullable().optional(),
    barcode: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    is_active: z.boolean(),
    track_stock: z.boolean(),
    unit: z.string().nullable().optional(),
    resolved_price: z
      .object({
        amount: z.number().int().min(0).max(1_000_000_000),
        currency: currencySchema,
        source: z.literal('product_base'),
        revision: sha256RevisionSchema,
        valid_from: isoSecondTimestampSchema,
        valid_until: isoSecondTimestampSchema
      })
      .strict()
      .nullable(),
    resolved_tax: z
      .object({
        id: z.uuid().nullable(),
        mode: taxModeSchema,
        rate_basis_points: z.number().int().min(0).max(10_000),
        revision: sha256RevisionSchema
      })
      .strict()
      .nullable(),
    updated_at: z.string().nullable().optional()
  })
  .strict()

const productBarcodeResourceSchema = z
  .object({
    id: z.uuid(),
    product_uuid: z.uuid(),
    barcode: z.string(),
    type: z.string().nullable().optional(),
    is_primary: z.boolean(),
    is_active: z.boolean(),
    updated_at: z.string().nullable().optional()
  })
  .strict()

const productPriceResourceSchema = z
  .object({
    id: z.uuid(),
    product_id: z.number().int(),
    label: z.string().nullable().optional(),
    amount: z.number().int(),
    currency: z.string(),
    price_type: z.string().nullable().optional(),
    is_active: z.boolean(),
    starts_at: z.string().nullable().optional(),
    ends_at: z.string().nullable().optional(),
    updated_at: z.string().nullable().optional()
  })
  .passthrough()

const stockItemResourceSchema = z
  .object({
    id: z.uuid(),
    product_uuid: z.uuid(),
    warehouse_uuid: z.uuid(),
    quantity: z.number(),
    reserved_quantity: z.number(),
    available_quantity: z.number(),
    minimum_quantity: z.number().nullable().optional(),
    maximum_quantity: z.number().nullable().optional(),
    is_active: z.boolean(),
    updated_at: z.string().nullable().optional()
  })
  .strict()

const taxResourceSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    code: z.string().nullable().optional(),
    rate: z.number(),
    type: z.string().nullable().optional(),
    is_default: z.boolean(),
    is_active: z.boolean(),
    updated_at: z.string().nullable().optional()
  })
  .passthrough()

const paymentMethodResourceSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    code: z.string().nullable().optional(),
    type: z.string().nullable().optional(),
    is_active: z.boolean(),
    allows_change: z.boolean(),
    requires_reference: z.boolean(),
    sort_order: z.number().int(),
    updated_at: z.string().nullable().optional()
  })
  .passthrough()

const customerResourceSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    email: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
    tax_number: z.string().nullable().optional(),
    address: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    is_active: z.boolean(),
    updated_at: z.string().nullable().optional()
  })
  .passthrough()

export const desktopBootstrapResourceSchema = z
  .object({
    server_time: isoSecondTimestampSchema,
    company: namedActiveRefResourceSchema,
    device: desktopDeviceResourceSchema,
    license: accessDecisionResourceSchema,
    subscription: subscriptionResourceSchema.nullable(),
    features: z.record(z.string(), z.boolean()),
    limits: z.record(z.string(), z.number().int().nullable()),
    permissions: z.array(z.string()),
    role: z.object({ name: z.string() }).passthrough(),
    loyalty: z
      .object({
        enabled: z.boolean(),
        earn_enabled: z.boolean(),
        redeem_enabled: z.boolean(),
        points_per_amount: z.number(),
        amount_per_point: z.number(),
        minimum_redeem_points: z.number(),
        maximum_redeem_percent: z.number(),
        points_expire_after_days: z.number().int().min(1).nullable(),
        points_activate_after_days: z.number(),
        allow_partial_redemption: z.boolean()
      })
      .passthrough()
      .nullable(),
    branch: namedActiveRefResourceSchema.nullable(),
    warehouse: namedActiveRefResourceSchema.nullable(),
    catalog_contract: z
      .object({
        revision: sha256RevisionSchema,
        generated_at: isoSecondTimestampSchema,
        valid_until: isoSecondTimestampSchema,
        quantity_scale: z.literal(3),
        minimum_quantity: z.literal('0.001'),
        maximum_quantity: z.literal('999999.999'),
        maximum_unit_price: z.literal(1_000_000_000),
        maximum_line_total: z.literal(900_000_000_000_000),
        maximum_invoice_total: z.literal(900_000_000_000_000),
        mixed_tax_mode_policy: z.literal('single_invoice_mode')
      })
      .strict(),
    sync: z
      .object({
        snapshot_version: z.string(),
        full_sync_required: z.boolean(),
        entities: z.record(z.string(), syncEntityCountResourceSchema)
      })
      .passthrough(),
    categories: z.array(categoryResourceSchema).optional(),
    products: z.array(productResourceSchema).optional(),
    product_barcodes: z.array(productBarcodeResourceSchema).optional(),
    product_prices: z.array(productPriceResourceSchema).optional(),
    stock_items: z.array(stockItemResourceSchema).optional(),
    taxes: z.array(taxResourceSchema).optional(),
    payment_methods: z.array(paymentMethodResourceSchema).optional(),
    customers: z.array(customerResourceSchema).optional()
  })
  .strict()

export type DesktopBootstrapResource = z.infer<typeof desktopBootstrapResourceSchema>

export const desktopShiftResourceSchema = z
  .object({
    id: z.uuid(),
    uuid: z.uuid(),
    status: z.enum(['open', 'paused', 'closed', 'cancelled']),
    company_id: z.number().int(),
    branch_id: z.number().int(),
    warehouse_id: z.number().int(),
    device_uuid: z.uuid().optional(),
    user: z
      .object({
        id: z.number().int(),
        uuid: z.uuid(),
        name: z.string(),
        email: z.string()
      })
      .strict()
      .optional(),
    opening_cash_amount: shiftMoneySchema,
    expected_cash_amount: signedShiftMoneySchema.nullable(),
    actual_cash_amount: shiftMoneySchema.nullable(),
    cash_difference_amount: signedShiftMoneySchema.nullable(),
    sales_total_amount: shiftMoneySchema,
    refund_total_amount: shiftMoneySchema,
    cash_sales_amount: shiftMoneySchema,
    card_sales_amount: shiftMoneySchema,
    other_payment_total_amount: shiftMoneySchema,
    cash_movement_in_amount: shiftMoneySchema,
    cash_movement_out_amount: shiftMoneySchema,
    cash_movement_net_amount: signedShiftMoneySchema,
    safe_drop_amount: shiftMoneySchema,
    expense_payout_amount: shiftMoneySchema,
    cash_drawer_movement_count: z.number().int().nonnegative(),
    opened_at: z.string(),
    closed_at: z.string().nullable(),
    paused_at: z.string().nullable(),
    pause_count: z.number().int().nonnegative(),
    total_paused_seconds: z.number().int().nonnegative(),
    active_pause: z
      .object({
        uuid: z.uuid(),
        paused_at: z.string(),
        reason: z.string().nullable(),
        notes: z.string().nullable()
      })
      .strict()
      .nullable()
      .optional(),
    notes: z.string().nullable(),
    close_notes: z.string().nullable()
  })
  .strict()

export type DesktopShiftResource = z.infer<typeof desktopShiftResourceSchema>

export const companyUserResourceSchema = z
  .object({
    id: z.uuid(),
    uuid: z.uuid(),
    name: z.string(),
    email: z.string(),
    company_id: z.number().int(),
    is_active: z.boolean(),
    roles: z.array(z.string()),
    created_at: z.string().nullable().optional(),
    updated_at: z.string().nullable().optional()
  })
  .passthrough()

export type CompanyUserResource = z.infer<typeof companyUserResourceSchema>

export const assignableRoleResourceSchema = z
  .object({
    system_roles: z.array(
      z
        .object({
          key: z.string(),
          label: z.string(),
          assignable: z.boolean()
        })
        .passthrough()
    ),
    company_roles: z.array(
      z
        .object({
          uuid: z.uuid(),
          name: z.string(),
          is_active: z.boolean()
        })
        .passthrough()
    )
  })
  .passthrough()

export type AssignableRoleResource = z.infer<typeof assignableRoleResourceSchema>

export const paginationMetaResourceSchema = z
  .object({
    current_page: z.number().int().positive(),
    per_page: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    last_page: z.number().int().positive()
  })
  .passthrough()
