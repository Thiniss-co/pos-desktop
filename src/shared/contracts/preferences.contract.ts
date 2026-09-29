import { z } from 'zod'

export const localeCodeSchema = z.enum(['en', 'ar'])

export type LocaleCode = z.infer<typeof localeCodeSchema>

export const themePreferenceSchema = z.enum(['light', 'dark', 'system'])

export type ThemePreference = z.infer<typeof themePreferenceSchema>

/** The theme actually painted on screen once `system` is resolved against the OS preference. */
export type ResolvedTheme = Exclude<ThemePreference, 'system'>

/**
 * POS workspace cart column width — a LAYOUT-ONLY preference (integer CSS pixels). `null` means
 * "use the design's per-breakpoint default". The stored range is deliberately wider than what any
 * one window can show: the renderer clamps the applied width to the live workspace on every
 * resize, so a width chosen on a large monitor survives a session on a smaller one.
 */
export const POS_CART_WIDTH_MIN = 320
export const POS_CART_WIDTH_MAX = 960

export const posCartWidthSchema = z.number().int().min(POS_CART_WIDTH_MIN).max(POS_CART_WIDTH_MAX)

export const posCartWidthPreferenceSchema = posCartWidthSchema.nullable()

export type PosCartWidthPreference = z.infer<typeof posCartWidthPreferenceSchema>
