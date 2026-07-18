import { z } from 'zod'

export const licenseStatusSchema = z
  .object({
    restrictionLevel: z.string(),
    canSell: z.boolean(),
    canSync: z.boolean(),
    isActive: z.boolean(),
    isInGrace: z.boolean(),
    isExpired: z.boolean(),
    expiresAt: z.string().nullable(),
    warningMessage: z.string().nullable(),
    validatedAt: z.string()
  })
  .strict()

export type LicenseStatus = z.infer<typeof licenseStatusSchema>
