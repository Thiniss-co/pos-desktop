import { z } from 'zod'

/**
 * POS workspace layout — a PRESENTATION-ONLY preference stored per company + user + workstation.
 * Main derives the owner from the signed-in session; the renderer only ever sends this shape.
 *
 * It holds no cart lines, amounts, customers, credentials or any other business state, and has no
 * free-form keys: every field is a closed enum, a bounded integer, a boolean or a fixed ordering of
 * known section ids, and the serialized form is capped at {@link POS_WORKSPACE_MAX_BYTES}.
 */
export const POS_WORKSPACE_LAYOUT_VERSION = 1
export const POS_WORKSPACE_MAX_BYTES = 2048

/** Requested cart share of the workspace width, in whole percent. The renderer clamps the applied width. */
export const POS_CART_SHARE_MIN = 35
export const POS_CART_SHARE_MAX = 85

export const posWorkspacePresetSchema = z.enum(['cartFirst', 'balanced', 'scanner', 'custom'])
export type PosWorkspacePreset = z.infer<typeof posWorkspacePresetSchema>

/** Logical side: `end` is the right in LTR and the left in RTL (the layout mirrors with the language). */
export const posCartSideSchema = z.enum(['start', 'end'])
export type PosCartSide = z.infer<typeof posCartSideSchema>

export const posDensitySchema = z.enum(['compact', 'comfortable'])
export type PosDensity = z.infer<typeof posDensitySchema>

/** How products are browsed: compact text tiles or the full image cards. */
export const posCatalogViewSchema = z.enum(['compact', 'cards'])
export type PosCatalogView = z.infer<typeof posCatalogViewSchema>

export const POS_CART_SECTION_IDS = ['actions', 'scan', 'lines', 'totals'] as const
export const POS_CATALOG_SECTION_IDS = ['categories', 'search', 'products'] as const

export const posCartSectionIdSchema = z.enum(POS_CART_SECTION_IDS)
export const posCatalogSectionIdSchema = z.enum(POS_CATALOG_SECTION_IDS)
export type PosCartSectionId = z.infer<typeof posCartSectionIdSchema>
export type PosCatalogSectionId = z.infer<typeof posCatalogSectionIdSchema>

function isPermutation(values: readonly string[], ids: readonly string[]): boolean {
  return values.length === ids.length && ids.every((id) => values.includes(id))
}

/**
 * Supported cart orderings: the totals (with Pay) are always last and pinned, the scan entry always
 * comes before the lines, and the action toolbar may sit above the scan entry, between the scan entry
 * and the lines, or between the lines and the totals.
 */
export function isSupportedCartOrder(order: readonly string[]): boolean {
  return (
    isPermutation(order, POS_CART_SECTION_IDS) &&
    order[order.length - 1] === 'totals' &&
    order.indexOf('scan') < order.indexOf('lines')
  )
}

/** Supported catalog orderings: categories and search may swap; the products (and paging) stay last. */
export function isSupportedCatalogOrder(order: readonly string[]): boolean {
  return isPermutation(order, POS_CATALOG_SECTION_IDS) && order[order.length - 1] === 'products'
}

export const posWorkspaceSectionsSchema = z
  .object({
    cart: z.array(posCartSectionIdSchema).length(POS_CART_SECTION_IDS.length),
    catalog: z.array(posCatalogSectionIdSchema).length(POS_CATALOG_SECTION_IDS.length)
  })
  .strict()
  .refine((sections) => isSupportedCartOrder(sections.cart), {
    message: 'Unsupported cart section order',
    path: ['cart']
  })
  .refine((sections) => isSupportedCatalogOrder(sections.catalog), {
    message: 'Unsupported catalog section order',
    path: ['catalog']
  })

export type PosWorkspaceSections = z.infer<typeof posWorkspaceSectionsSchema>

export const posWorkspaceLayoutSchema = z
  .object({
    version: z.literal(POS_WORKSPACE_LAYOUT_VERSION),
    preset: posWorkspacePresetSchema,
    cartSide: posCartSideSchema,
    cartShare: z.number().int().min(POS_CART_SHARE_MIN).max(POS_CART_SHARE_MAX),
    density: posDensitySchema,
    catalogView: posCatalogViewSchema,
    catalogCollapsed: z.boolean(),
    sections: posWorkspaceSectionsSchema
  })
  .strict()
  .refine((layout) => serializedByteLength(layout) <= POS_WORKSPACE_MAX_BYTES, {
    message: 'The layout is too large'
  })

export type PosWorkspaceLayout = z.infer<typeof posWorkspaceLayoutSchema>

export function serializedByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length
}

const DEFAULT_CART_ORDER: PosCartSectionId[] = ['actions', 'scan', 'lines', 'totals']
const DEFAULT_CATALOG_ORDER: PosCatalogSectionId[] = ['categories', 'search', 'products']

export const POS_WORKSPACE_PRESETS: Readonly<
  Record<Exclude<PosWorkspacePreset, 'custom'>, PosWorkspaceLayout>
> = Object.freeze({
  cartFirst: {
    version: 1,
    preset: 'cartFirst',
    cartSide: 'end',
    cartShare: 64,
    density: 'compact',
    catalogView: 'compact',
    catalogCollapsed: false,
    sections: { cart: [...DEFAULT_CART_ORDER], catalog: [...DEFAULT_CATALOG_ORDER] }
  },
  balanced: {
    version: 1,
    preset: 'balanced',
    cartSide: 'end',
    cartShare: 45,
    density: 'compact',
    catalogView: 'cards',
    catalogCollapsed: false,
    sections: { cart: [...DEFAULT_CART_ORDER], catalog: [...DEFAULT_CATALOG_ORDER] }
  },
  scanner: {
    version: 1,
    preset: 'scanner',
    cartSide: 'end',
    cartShare: 85,
    density: 'compact',
    catalogView: 'compact',
    catalogCollapsed: true,
    sections: {
      cart: ['scan', 'actions', 'lines', 'totals'],
      catalog: ['search', 'categories', 'products']
    }
  }
})

/** The recommended default: Cart first. */
export function defaultWorkspaceLayout(): PosWorkspaceLayout {
  return clonePreset('cartFirst')
}

export function clonePreset(preset: Exclude<PosWorkspacePreset, 'custom'>): PosWorkspaceLayout {
  const source = POS_WORKSPACE_PRESETS[preset]
  return {
    ...source,
    sections: { cart: [...source.sections.cart], catalog: [...source.sections.catalog] }
  }
}

/**
 * Reads a stored/received value defensively. Only version-1 objects are salvaged, field by field:
 * every invalid or missing field takes the Cart-first default and an unsupported section order is
 * replaced as a whole. Anything else (malformed, unknown or future version) is the default layout.
 * The result always passes {@link posWorkspaceLayoutSchema}.
 */
export function normalizeWorkspaceLayout(value: unknown): PosWorkspaceLayout {
  const fallback = defaultWorkspaceLayout()

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fallback
  }

  const record = value as Record<string, unknown>

  if (record.version !== POS_WORKSPACE_LAYOUT_VERSION) {
    return fallback
  }

  const pick = <T>(schema: z.ZodType<T>, field: unknown, otherwise: T): T => {
    const parsed = schema.safeParse(field)
    return parsed.success ? parsed.data : otherwise
  }

  const sections =
    typeof record.sections === 'object' && record.sections !== null
      ? (record.sections as Record<string, unknown>)
      : {}
  const cartOrder = pick(z.array(posCartSectionIdSchema), sections.cart, fallback.sections.cart)
  const catalogOrder = pick(
    z.array(posCatalogSectionIdSchema),
    sections.catalog,
    fallback.sections.catalog
  )

  const layout: PosWorkspaceLayout = {
    version: POS_WORKSPACE_LAYOUT_VERSION,
    preset: pick(posWorkspacePresetSchema, record.preset, fallback.preset),
    cartSide: pick(posCartSideSchema, record.cartSide, fallback.cartSide),
    cartShare: pick(
      z.number().int().min(POS_CART_SHARE_MIN).max(POS_CART_SHARE_MAX),
      record.cartShare,
      fallback.cartShare
    ),
    density: pick(posDensitySchema, record.density, fallback.density),
    catalogView: pick(posCatalogViewSchema, record.catalogView, fallback.catalogView),
    catalogCollapsed: pick(z.boolean(), record.catalogCollapsed, fallback.catalogCollapsed),
    sections: {
      cart: isSupportedCartOrder(cartOrder) ? [...cartOrder] : [...fallback.sections.cart],
      catalog: isSupportedCatalogOrder(catalogOrder)
        ? [...catalogOrder]
        : [...fallback.sections.catalog]
    }
  }

  return posWorkspaceLayoutSchema.safeParse(layout).success ? layout : fallback
}

/** Parses the stored JSON text; malformed JSON is the default layout. */
export function parseStoredWorkspaceLayout(json: string | null): PosWorkspaceLayout {
  if (json === null) {
    return defaultWorkspaceLayout()
  }

  try {
    return normalizeWorkspaceLayout(JSON.parse(json))
  } catch {
    return defaultWorkspaceLayout()
  }
}

/**
 * The opaque, non-secret token main issues with every read. It identifies the session context the
 * read was made in (company, user, device, session epoch); a write carrying a token that no longer
 * matches the current context is refused, so a save started by one cashier can never land on the
 * next cashier's row. It never selects the owner and is never stored.
 */
export const posWorkspaceContextTokenSchema = z.string().min(1).max(128)

export const posWorkspaceReadResultSchema = z
  .object({
    layout: posWorkspaceLayoutSchema,
    /** `false` when nothing is stored for this owner (the layout is the default). */
    stored: z.boolean(),
    /** `null` when signed out: nothing can be written. */
    contextToken: posWorkspaceContextTokenSchema.nullable()
  })
  .strict()

export type PosWorkspaceReadResult = z.infer<typeof posWorkspaceReadResultSchema>

export const setPosWorkspaceInputSchema = z
  .object({
    /** `null` restores the default (the stored row is removed). */
    layout: posWorkspaceLayoutSchema.nullable(),
    contextToken: posWorkspaceContextTokenSchema
  })
  .strict()

export type SetPosWorkspaceInput = z.infer<typeof setPosWorkspaceInputSchema>
