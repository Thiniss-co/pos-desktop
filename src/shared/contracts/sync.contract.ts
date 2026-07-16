import { z } from 'zod'

export const syncCountsSchema = z
  .object({
    pending: z.number().int().nonnegative(),
    uploading: z.number().int().nonnegative(),
    retryableError: z.number().int().nonnegative(),
    conflict: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative()
  })
  .strict()

export const syncStatusSchema = z
  .object({
    state: z.enum(['idle', 'paused']),
    pausedReason: z.string().nullable(),
    counts: syncCountsSchema
  })
  .strict()

export type SyncCounts = z.infer<typeof syncCountsSchema>
export type SyncStatus = z.infer<typeof syncStatusSchema>
