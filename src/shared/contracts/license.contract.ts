import { z } from 'zod'

// Laravel serializes timestamps as ISO-8601 with an explicit offset ("+00:00"), which
// z.iso.datetime() rejects by default; `offset: true` accepts both that and the "Z" form
// we write ourselves via Date#toISOString().
const isoDateTimeSchema = z.iso.datetime({ offset: true })

/**
 * Phase 4 closeout (O-7): a paid renewal with identical entitlements, scheduled when this license was validated. The
 * server already bounded the offline authority and catalog by its end; the local access decision uses it only when it
 * starts exactly at the current period's end (see `CommercialAccessService`).
 */
export const licenseOfflineCoverageSchema = z
  .object({
    renewalId: z.string().min(1),
    startsAt: isoDateTimeSchema,
    expiresAt: isoDateTimeSchema,
    graceEndsAt: isoDateTimeSchema.nullable()
  })
  .strict()

export type LicenseOfflineCoverage = z.infer<typeof licenseOfflineCoverageSchema>

export const licenseSubscriptionSchema = z
  .object({
    status: z.string(),
    expiresAt: isoDateTimeSchema.nullable(),
    graceEndsAt: isoDateTimeSchema.nullable(),
    // Optional: statuses persisted by earlier builds have no such key.
    offlineCoverage: licenseOfflineCoverageSchema.nullable().optional()
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

export const commercialAccessActionSchema = z.enum(['sell', 'sync'])

export const commercialAccessReasonSchema = z.enum([
  'device-not-registered',
  'device-revoked',
  'device-blocked',
  'session-invalid',
  'clock-untrusted',
  'license-state-invalid',
  'grace-ended',
  'validation-overdue',
  'license-denied',
  'permission-denied',
  'bootstrap-incomplete',
  'company-inactive',
  'company-suspended',
  'feature-not-enabled',
  'connectivity-unavailable'
])

export const commercialAccessWarningSchema = z.enum(['grace', 'validation-due-soon'])

export const commercialAccessDecisionSchema = z
  .object({
    allowed: z.boolean(),
    reason: commercialAccessReasonSchema.nullable(),
    warning: commercialAccessWarningSchema.nullable(),
    action: commercialAccessActionSchema.default('sell'),
    retryable: z.boolean().default(false),
    evaluatedAt: isoDateTimeSchema.nullable().default(null),
    nextValidationDueAt: isoDateTimeSchema.nullable().default(null),
    restrictionLevel: z.string().nullable().default(null),
    warningMessage: z.string().nullable().default(null)
  })
  .strict()

export const commercialAccessSnapshotSchema = z
  .object({
    sell: commercialAccessDecisionSchema,
    sync: commercialAccessDecisionSchema
  })
  .strict()

export type CommercialAccessDecision = z.infer<typeof commercialAccessDecisionSchema>
export type CommercialAccessAction = z.infer<typeof commercialAccessActionSchema>
export type CommercialAccessReason = z.infer<typeof commercialAccessReasonSchema>
export type CommercialAccessSnapshot = z.infer<typeof commercialAccessSnapshotSchema>

export const COMMERCIAL_ACCESS_REASON_CLASSIFICATION = Object.freeze({
  'device-not-registered': {
    category: 'authorization',
    retryable: false,
    transition: 'device'
  },
  'device-revoked': { category: 'authorization', retryable: false, transition: 'device' },
  'device-blocked': { category: 'authorization', retryable: false, transition: 'device' },
  'session-invalid': { category: 'authentication', retryable: false, transition: 'session' },
  'clock-untrusted': { category: 'authorization', retryable: false, transition: 'none' },
  'license-state-invalid': { category: 'authorization', retryable: false, transition: 'none' },
  'grace-ended': { category: 'authorization', retryable: false, transition: 'none' },
  'validation-overdue': { category: 'authorization', retryable: false, transition: 'none' },
  'license-denied': { category: 'authorization', retryable: false, transition: 'none' },
  'permission-denied': { category: 'authorization', retryable: false, transition: 'none' },
  'bootstrap-incomplete': { category: 'authorization', retryable: false, transition: 'bootstrap' },
  'company-inactive': { category: 'authorization', retryable: false, transition: 'none' },
  // Phase 3: new local sales stop while the platform has suspended the company; uploads, shift close and
  // sign-out continue, and the denial lifts on its own when a newer revision says the suspension ended.
  'company-suspended': { category: 'authorization', retryable: true, transition: 'none' },
  'feature-not-enabled': { category: 'authorization', retryable: false, transition: 'none' },
  'connectivity-unavailable': { category: 'transport', retryable: true, transition: 'none' }
} as const satisfies Record<
  CommercialAccessReason,
  {
    readonly category: 'authentication' | 'authorization' | 'transport'
    readonly retryable: boolean
    readonly transition: 'none' | 'session' | 'device' | 'bootstrap'
  }
>)
