import { z } from 'zod'

export const bootstrapStatusSchema = z
  .object({
    isComplete: z.boolean(),
    updatedAt: z.string().nullable()
  })
  .strict()

export type BootstrapStatus = z.infer<typeof bootstrapStatusSchema>

export const bootstrapResultSchema = z
  .object({
    isComplete: z.boolean(),
    snapshotVersion: z.string(),
    serverTime: z.string(),
    fetchedAt: z.string(),
    counts: z.record(z.string(), z.number().int().nonnegative())
  })
  .strict()

export type BootstrapResult = z.infer<typeof bootstrapResultSchema>
