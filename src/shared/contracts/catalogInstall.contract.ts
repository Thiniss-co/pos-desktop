import { z } from 'zod'

/**
 * Rev 4 §8 — the catalog-install lifecycle surface.
 *
 * Every bootstrap mints a new catalog revision, so installing one would supersede an open cart or a
 * payment claimed under the old revision. Main therefore installs only through a hold that the
 * renderer arms synchronously and that ONLY main releases, after the new contract is applied.
 */

/** Renderer → main: the current POS draft, reported on every change (generation is monotonic). */
export const draftStateSchema = z
  .object({
    generation: z.number().int().min(0),
    hasLines: z.boolean(),
    hasHeldDrafts: z.boolean(),
    paymentActive: z.boolean(),
    completionPending: z.boolean()
  })
  .strict()
export type DraftState = z.infer<typeof draftStateSchema>

export const installPathSchema = z.enum(['background', 'manual', 'stale'])
export type InstallPath = z.infer<typeof installPathSchema>

/** Main → renderer: arm the hold (if admitted for this path) and reply. */
export const installHoldRequestSchema = z
  .object({
    holdId: z.uuid(),
    path: installPathSchema,
    consentGeneration: z.number().int().min(0).nullable()
  })
  .strict()
export type InstallHoldRequest = z.infer<typeof installHoldRequestSchema>

/** Renderer → main: whether the hold was armed, and the draft generation it was armed at. */
export const installHoldReplySchema = z
  .object({
    holdId: z.uuid(),
    admitted: z.boolean(),
    generation: z.number().int().min(0)
  })
  .strict()
export type InstallHoldReply = z.infer<typeof installHoldReplySchema>

export const installHoldStatusInputSchema = z.object({ holdId: z.uuid() }).strict()

export const installHoldStateSchema = z.enum([
  'requested',
  'held',
  'installing',
  'installed',
  'aborted',
  'unknown'
])
export type InstallHoldState = z.infer<typeof installHoldStateSchema>

export const installHoldStatusSchema = z.object({ state: installHoldStateSchema }).strict()

/** Main → renderer: the hold reached a terminal state. Lost pushes are recovered by status polls. */
export const installReleaseSchema = z
  .object({
    holdId: z.uuid(),
    installed: z.boolean()
  })
  .strict()
export type InstallRelease = z.infer<typeof installReleaseSchema>

/** Renderer → main: the header "Refresh workstation" (manual path, Rev 4 §8.3). */
export const workstationRefreshInputSchema = z
  .object({
    consent: z
      .object({ generation: z.number().int().min(0) })
      .strict()
      .nullable()
  })
  .strict()
export type WorkstationRefreshInput = z.infer<typeof workstationRefreshInputSchema>

export const workstationRefreshOutcomeSchema = z.enum([
  'installed',
  'license-only',
  'payment-active',
  'draft-changed',
  'busy',
  'denied',
  'failed'
])
export type WorkstationRefreshOutcome = z.infer<typeof workstationRefreshOutcomeSchema>

export const workstationRefreshResultSchema = z
  .object({
    outcome: workstationRefreshOutcomeSchema,
    revision: z.string().nullable(),
    revisionChanged: z.boolean()
  })
  .strict()
export type WorkstationRefreshResult = z.infer<typeof workstationRefreshResultSchema>

/** Main → renderer: claimed/committed attempts changed without the renderer asking (Rev 4 §9.1). */
export const attemptsChangedSchema = z.object({ reason: z.enum(['settled', 'committed']) }).strict()
export type AttemptsChanged = z.infer<typeof attemptsChangedSchema>
