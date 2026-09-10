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

const stockItemResourceSchema = z
  .object({
    id: z.uuid(),
    product_uuid: z.uuid(),
    warehouse_uuid: z.uuid(),
    quantity: z.number().finite(),
    reserved_quantity: z.number().finite(),
    // Laravel's DesktopStockItemResource casts decimal quantities to float. Keep that exact wire
    // type here; it is retained only as a stock projection, never as allocation sale authority.
    allocation_reserved_quantity: z.number().finite(),
    available_quantity: z.number().finite(),
    minimum_quantity: z.number().finite().nullable(),
    maximum_quantity: z.number().finite().nullable(),
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

/**
 * PS4 §6.2: one server-issued offline-sale authority, exactly as the backend published it.
 *
 * `.strict()` for the same reason every other bootstrap sub-schema is: a server field added without
 * a desktop update must fail deliberately rather than be silently discarded. An authority is what
 * permits selling without a stock quota, so a shape this client does not fully understand is
 * precisely the thing it must not act on.
 */
export const offlineSaleAuthorityResourceSchema = z
  .object({
    id: z.uuid(),
    mode: z.enum(['allocation_exclusive', 'physical_presence']),
    policy_revision: z.number().int().positive(),
    contract_version: z.number().int().positive(),
    issued_at: z.string(),
    not_before: z.string(),
    not_after: z.string(),
    authority_hash: z.string().length(64)
  })
  .strict()

/**
 * One device-bound stock allocation envelope (backend `StockAllocationResource`). Bootstrap is
 * read-only for allocations: it reports the envelopes the server currently holds for this device
 * and never grants or mutates them. This is an exact, versioned cross-runtime contract: a server
 * field added without a desktop update must fail bootstrap deliberately, never be discarded.
 */
export const stockAllocationResourceSchema = z
  .object({
    id: z.uuid(),
    contract_version: z.number().int().positive(),
    company_uuid: z.uuid(),
    device_uuid: z.uuid(),
    warehouse_uuid: z.uuid(),
    product_uuid: z.uuid(),
    server_sequence: z.number().int().positive(),
    rights_generation: z.number().int().positive(),
    lifecycle_generation: z.number().int().positive(),
    granted_quantity_milli: z.number().int().positive(),
    consumed_quantity_milli: z.number().int().nonnegative(),
    remaining_quantity_milli: z.number().int().nonnegative(),
    consume_until: isoSecondTimestampSchema,
    status: z.enum(['active', 'revocation_pending', 'seal_acknowledged', 'released', 'consumed']),
    envelope_hash: sha256RevisionSchema,
    seal_nonce: z.uuid().nullable(),
    final_consumption_sequence: z.number().int().nonnegative().nullable(),
    final_consumption_hash: sha256RevisionSchema.nullable(),
    sealed_at: isoSecondTimestampSchema.nullable(),
    acknowledged_at: isoSecondTimestampSchema.nullable(),
    released_at: isoSecondTimestampSchema.nullable()
  })
  .strict()

export type StockAllocationResource = z.infer<typeof stockAllocationResourceSchema>

/**
 * BH-04B-3: the §3.1 coverage boundary the backend publishes per allocation, under
 * `allocation_payload_version=2`.
 *
 * Strict, and every field is required: a boundary is only meaningful as a whole. A partially
 * supplied triple is a contract error, not a boundary with defaults — absent coverage must never
 * read as a verified zero boundary, which is exactly what a `.optional()` here would allow.
 */
export const stockAllocationCoverageSchema = z
  .object({
    accepted_consumption_sequence: z.number().int().nonnegative(),
    accepted_consumed_quantity_milli: z.number().int().nonnegative(),
    accepted_chain_hash: sha256RevisionSchema
  })
  .strict()

/**
 * The opted-in allocation envelope: exactly the 21 legacy keys plus the coverage triple, still
 * `.strict()`. Unknown server keys keep failing both consumer paths closed.
 */
export const stockAllocationReconciliationResourceSchema = stockAllocationResourceSchema
  .extend(stockAllocationCoverageSchema.shape)
  .strict()

export type StockAllocationReconciliationResource = z.infer<
  typeof stockAllocationReconciliationResourceSchema
>

/**
 * Either representation, strictly. The reconciliation shape is tried first so a coverage-bearing
 * envelope never silently degrades to the legacy reading; a legacy backend's 21-key envelope still
 * parses, so a client that asks for version 2 and reaches an older deployment degrades to the
 * conservative mode instead of crashing.
 */
export const stockAllocationEnvelopeSchema = z.union([
  stockAllocationReconciliationResourceSchema,
  stockAllocationResourceSchema
])

/**
 * The §9.2-4 terminal marker. `id` is the allocation uuid — the same value the envelope publishes as
 * its own `id` — so a marker is directly comparable to a live allocation.
 */
export const stockAllocationTerminalMarkerSchema = z
  .object({
    id: z.uuid(),
    status: z.enum(['released', 'consumed']),
    lifecycle_generation: z.number().int().positive(),
    terminal_revision: z.number().int().nonnegative()
  })
  .strict()

export type StockAllocationTerminalMarker = z.infer<typeof stockAllocationTerminalMarkerSchema>

/**
 * `POST /api/v1/desktop/stock-allocations/top-up` response body (`data`), transcribed from
 * `DesktopStockAllocationController::topUp()`: `StockAllocationResource::collection(...)` unwrapped
 * by `ApiResponse::resource()`, so `data` is the bare array of the same envelopes bootstrap
 * publishes. Reusing `stockAllocationResourceSchema` verbatim is deliberate — there is exactly one
 * desktop allocation envelope contract, and an added server field must fail both paths identically
 * rather than being silently discarded on one of them.
 */
export const desktopStockAllocationTopUpDataSchema = z.array(stockAllocationEnvelopeSchema)

/**
 * The controller merges `['allocation_revision' => $result['revision']]` into the envelope meta,
 * alongside the `trace_id` every `ApiResponse` adds. `allocation_revision` is authority (it is the
 * server's monotonic lifecycle-audit high-water mark for this device) and is therefore required and
 * strictly typed; other meta keys are diagnostics owned by the shared envelope, not by this route,
 * so they are tolerated exactly as `parseApiEnvelope` already tolerates them.
 */
export const desktopStockAllocationTopUpMetaSchema = z.object({
  allocation_revision: z.number().int().nonnegative()
})

export type DesktopStockAllocationTopUpData = z.infer<typeof desktopStockAllocationTopUpDataSchema>

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
        currency: currencySchema,
        currency_exponent: z.number().int().min(0).max(3),
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
    // Optional: a backend that predates the allocation contract omits both keys.
    stock_allocations: z.array(stockAllocationEnvelopeSchema).optional(),
    stock_allocation_revision: z.number().int().nonnegative().optional(),
    // BH-04B-3: present only when this request negotiated `allocation_payload_version=2`. Its
    // absence means "this response says nothing about terminal allocations" — never "there are
    // none", which is why the persistence layer treats an absent key and an empty list differently.
    stock_allocation_terminal_markers: z.array(stockAllocationTerminalMarkerSchema).optional(),
    // PS4 §15.2: present only when this request negotiated `offline_sale_contract_version=1`.
    //
    // Three states, and they are genuinely different: the key ABSENT means this response says
    // nothing about offline-sale authority (an older backend, or a client that did not ask); the
    // key present and NULL means "you asked, and you currently hold none"; and a value means this
    // is the authority the server has issued. Collapsing absent and null would make an old backend
    // indistinguishable from an explicit revocation.
    offline_sale_authority: offlineSaleAuthorityResourceSchema.nullable().optional(),
    categories: z.array(categoryResourceSchema).optional(),
    products: z.array(productResourceSchema).optional(),
    product_barcodes: z.array(productBarcodeResourceSchema).optional(),
    stock_items: z.array(stockItemResourceSchema).optional(),
    taxes: z.array(taxResourceSchema).optional(),
    payment_methods: z.array(paymentMethodResourceSchema).optional(),
    customers: z.array(customerResourceSchema).optional()
  })
  .strict()
  .superRefine((resource, context) => {
    const allocationsPresent = Object.hasOwn(resource, 'stock_allocations')
    const revisionPresent = Object.hasOwn(resource, 'stock_allocation_revision')

    if (allocationsPresent !== revisionPresent) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'stock_allocations and stock_allocation_revision must be present together or both be absent'
      })
    }
  })

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

const invoiceMoneySchema = z.number().int().min(0).max(2_147_483_647)

/**
 * `POST /api/v1/desktop/invoices/upload` response body (`data`), transcribed from
 * `DesktopInvoiceResource::toArray()` in pos-backend. The same resource is returned for a fresh
 * commit (201) and for an idempotent replay (200) — only the envelope `code` distinguishes them.
 *
 * `id` is the server invoice uuid and becomes `local_invoices.remote_uuid`; `server_number` is the
 * fiscal number and becomes `local_invoices.server_number`. Those two are the only load-bearing
 * fields: the desktop never recomputes totals from this response, because the server is authority
 * for them and the local row already holds what was actually rung.
 *
 * `items` and `payments` are `whenLoaded(...)`, so the resource omits them entirely when the
 * relations are not eager-loaded. Both upload branches do load them, but they are modelled as
 * optional rather than required so a backend that stops loading them degrades into "no receipt
 * detail" instead of a hard contract failure on an invoice the server has already accepted.
 */
export const desktopInvoiceUploadResourceSchema = z
  .object({
    id: z.uuid(),
    server_number: z.string().min(1),
    offline_number: z.string().nullable(),
    status: z.string(),
    payment_status: z.string(),
    currency: currencySchema,
    subtotal_amount: invoiceMoneySchema,
    discount_total_amount: invoiceMoneySchema,
    tax_total_amount: invoiceMoneySchema,
    grand_total_amount: invoiceMoneySchema,
    paid_total_amount: invoiceMoneySchema,
    change_due_amount: invoiceMoneySchema,
    due_amount: invoiceMoneySchema,
    sold_at: isoSecondTimestampSchema.nullable(),
    items: z
      .array(
        z
          .object({
            id: z.uuid(),
            product_uuid: z.uuid(),
            quantity: z.string(),
            total_amount: invoiceMoneySchema
          })
          .passthrough()
      )
      .optional(),
    payments: z
      .array(
        z
          .object({
            id: z.uuid(),
            type: z.string(),
            amount: invoiceMoneySchema,
            reference: z.string().nullable()
          })
          .passthrough()
      )
      .optional(),
    /**
     * BH-04B-3: the per-allocation coverage block BH-04B-1 added to this response. It was already
     * being sent and silently dropped by this schema's passthrough; naming it here is what lets the
     * upload path reconcile from it. Optional, because a backend predating slice 1 omits it — and an
     * omitted block means "no coverage was reported", never "coverage is zero".
     *
     * Unlike bootstrap this carries the allocation identity inline, since an upload response has no
     * envelope to attach it to.
     */
    allocations: z
      .array(
        z
          .object({
            allocation_uuid: z.uuid(),
            rights_generation: z.number().int().positive()
          })
          .extend(stockAllocationCoverageSchema.shape)
          .strict()
      )
      .optional()
  })
  .passthrough()

export type DesktopInvoiceUploadResource = z.infer<typeof desktopInvoiceUploadResourceSchema>

/**
 * The two success codes `DesktopInvoiceController::upload()` can return. They are a closed set:
 * any other success code on this route means the backend contract moved underneath us and must be
 * treated as a contract error, never guessed at.
 */
export const DESKTOP_INVOICE_UPLOADED_CODE = 'DESKTOP_INVOICE_UPLOADED' as const
export const DESKTOP_INVOICE_ALREADY_UPLOADED_CODE = 'DESKTOP_INVOICE_ALREADY_UPLOADED' as const

/**
 * CP3 (plan §5.4): the negotiated prepare response, `response_representation_version = 1`.
 *
 * `.strict()` throughout, like every other envelope this client parses: an unknown server key fails
 * closed rather than being silently ignored, because a newer response may carry lifecycle semantics
 * this build would misread.
 *
 * The shape enforces §5.4's central separation at the type level. `decision` is the immutable
 * snapshot taken at `prepared_at` — identical on every replay, forever. `reconciliation` is current
 * observation, explicitly labelled and explicitly *not* part of the decision. They are never merged:
 * §13 lists "a replay presents an old successful decision as renewed readiness" as a stop condition.
 *
 * `decision.products` is required to carry one entry per selected product, **including every zero**.
 * That is what makes the completeness predicate checkable at all — without the zero entries a client
 * cannot distinguish "granted nothing, on purpose, for this reason" from "this product's decision
 * never arrived", which §6.7 shows silently destroying a real grant.
 */
export const preparePlanProductOutcomeSchema = z
  .object({
    product_uuid: z.string(),
    reason: z.enum([
      'full',
      'partial_cap',
      'partial_stock',
      'zero_at_target',
      'zero_cap',
      'zero_stock',
      'blocked_by_unreleased_hold'
    ]),
    granted_quantity_milli: z.number().int().nonnegative(),
    advance_target_milli: z.number().int().nonnegative(),
    device_hard_cap_milli: z.number().int().nonnegative(),
    warehouse_budget_milli: z.number().int().nonnegative(),
    device_held_before_milli: z.number().int().nonnegative(),
    warehouse_held_before_milli: z.number().int().nonnegative(),
    physical_unreserved_milli: z.number().int().nonnegative(),
    window_qualified_hold_milli: z.number().int().nonnegative(),
    short_lived_hold_milli: z.number().int().nonnegative(),
    expired_hold_milli: z.number().int().nonnegative(),
    quarantined_hold_milli: z.number().int().nonnegative(),
    // Present exactly when something was granted. `null` here is a *decided* zero, never a missing
    // decision — the reason code above says which zero it is.
    allocation_uuid: z.string().nullable(),
    issued_at: z.string().nullable(),
    consume_until: z.string().nullable(),
    blocking_allocation_uuids: z.array(z.string())
  })
  .strict()

export const prepareManifestSchema = z
  .object({
    prepared_at: z.string(),
    required_duration_seconds: z.number().int().positive(),
    required_ready_until: z.string(),
    authority_ready_until: z.string(),
    actual_supported_seconds: z.number().int().nonnegative(),
    primary_limiting_reason: z.string(),
    tied_limiting_reasons: z.array(z.string()),
    evaluated_guards: z.array(
      z
        .object({
          guard: z.string(),
          deadline: z.string().nullable(),
          bounded: z.boolean()
        })
        .strict()
    )
  })
  .strict()

export const prepareOperationResourceSchema = z
  .object({
    operation_uuid: z.string(),
    request_hash: sha256RevisionSchema,
    response_representation_version: z.literal(1),
    decision: z
      .object({
        prepare_contract_version: z.number().int().positive(),
        selection_version: z.number().int().positive(),
        authority_reference_version: z.number().int().positive(),
        requested_policy_revision: z.number().int().nonnegative(),
        applied_policy_revision: z.number().int().nonnegative().nullable(),
        selected_product_uuids: z.array(z.string()),
        result: z.enum(['ready_72h', 'partial_time', 'partial_quantity', 'blocked', 'expired']),
        primary_limiting_reason: z.string(),
        manifest: prepareManifestSchema,
        authority_references: z.record(z.string(), z.unknown()),
        products: z.array(preparePlanProductOutcomeSchema)
      })
      .strict(),
    // The grants, in the same envelope shape the desktop already ingests, plus server-assigned
    // provenance read from each grant's own row.
    allocations: z.array(
      stockAllocationResourceSchema
        .extend({
          origin_operation_uuid: z.string().nullable(),
          origin_request_uuid: z.string().nullable(),
          grant_purpose: z.string()
        })
        .strict()
    ),
    reconciliation: z.record(z.string(), z.unknown())
  })
  .strict()

export type PrepareOperationResource = z.infer<typeof prepareOperationResourceSchema>
export type PreparePlanProductOutcome = z.infer<typeof preparePlanProductOutcomeSchema>
