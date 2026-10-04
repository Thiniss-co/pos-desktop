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

/**
 * POS improvements, Stage 5: per-user preferences on this workstation. The identity is always the
 * main-process session's; the renderer only names a key and a boolean.
 */
export const userPreferenceKeySchema = z.enum(['ui.touchMode', 'printing.autoPrint'])

export type UserPreferenceKey = z.infer<typeof userPreferenceKeySchema>

export const userPreferencesSchema = z
  .object({
    touchMode: z.boolean(),
    /** D3: ON unless this user turned it off; an old workstation-level "off" is not an opt-out. */
    autoPrint: z.boolean()
  })
  .strict()

export type UserPreferences = z.infer<typeof userPreferencesSchema>

export const setUserPreferenceInputSchema = z
  .object({ key: userPreferenceKeySchema, value: z.boolean() })
  .strict()

export type SetUserPreferenceInput = z.infer<typeof setUserPreferenceInputSchema>
