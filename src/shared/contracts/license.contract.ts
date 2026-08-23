import { z } from 'zod'

// Laravel serializes timestamps as ISO-8601 with an explicit offset ("+00:00"), which
// z.iso.datetime() rejects by default; `offset: true` accepts both that and the "Z" form
// we write ourselves via Date#toISOString().
const isoDateTimeSchema = z.iso.datetime({ offset: true })

export const licenseSubscriptionSchema = z
  .object({
    status: z.string(),
    expiresAt: isoDateTimeSchema.nullable(),
    graceEndsAt: isoDateTimeSchema.nullable()
  })
  .strict()

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
    validatedAt: isoDateTimeSchema,
    serverTime: isoDateTimeSchema,
    nextValidationDueAt: isoDateTimeSchema,
    maxOfflineHours: z.number().int().positive(),
    subscription: licenseSubscriptionSchema.nullable()
  })
  .strict()

export type LicenseStatus = z.infer<typeof licenseStatusSchema>

export const commercialAccessReasonSchema = z.enum([
  'session-invalid',
  'clock-untrusted',
  'license-state-invalid',
  'grace-ended',
  'validation-overdue',
  'license-denied',
  'permission-denied'
])

export const commercialAccessWarningSchema = z.enum(['grace', 'validation-due-soon'])

export const commercialAccessDecisionSchema = z
  .object({
    allowed: z.boolean(),
    reason: commercialAccessReasonSchema.nullable(),
    warning: commercialAccessWarningSchema.nullable()
  })
  .strict()

export const commercialAccessSnapshotSchema = z
  .object({
    sell: commercialAccessDecisionSchema,
    sync: commercialAccessDecisionSchema
  })
  .strict()

export type CommercialAccessDecision = z.infer<typeof commercialAccessDecisionSchema>
export type CommercialAccessReason = z.infer<typeof commercialAccessReasonSchema>
export type CommercialAccessSnapshot = z.infer<typeof commercialAccessSnapshotSchema>
