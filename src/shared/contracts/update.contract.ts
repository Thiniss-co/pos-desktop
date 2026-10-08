import { z } from 'zod'

/**
 * Automatic updates (main-owned). `not_configured`: this build has no update feed. The rest follow
 * electron-updater: a background check, a background download, then `ready` until the cashier
 * restarts at a safe moment.
 */
export const updatePhaseSchema = z.enum([
  'not_configured',
  'idle',
  'checking',
  'downloading',
  'ready',
  'error'
])

/** Work that a restart would interrupt. Queued offline work is NOT one: it survives the upgrade. */
export const restartBlockerSchema = z.enum([
  'sale_in_progress',
  'refund_in_flight',
  'print_in_progress',
  'upload_in_flight',
  'catalog_install'
])

export const updateStatusSchema = z
  .object({
    phase: updatePhaseSchema,
    currentVersion: z.string().min(1).max(64),
    availableVersion: z.string().min(1).max(64).nullable(),
    percent: z.number().min(0).max(100).nullable(),
    lastCheckedAt: z.string().datetime({ offset: true }).nullable(),
    nextCheckAt: z.string().datetime({ offset: true }).nullable(),
    /** A short, sanitized reason for `error` (never a URL, path or stack). */
    errorCode: z.string().max(64).nullable(),
    blockers: z.array(restartBlockerSchema)
  })
  .strict()

export const updateRestartResultSchema = z
  .object({
    restarting: z.boolean(),
    blockers: z.array(restartBlockerSchema)
  })
  .strict()

export type UpdatePhase = z.infer<typeof updatePhaseSchema>
export type RestartBlocker = z.infer<typeof restartBlockerSchema>
export type UpdateStatus = z.infer<typeof updateStatusSchema>
export type UpdateRestartResult = z.infer<typeof updateRestartResultSchema>
