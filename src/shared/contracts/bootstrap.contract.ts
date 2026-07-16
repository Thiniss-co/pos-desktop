import { z } from 'zod'

export const bootstrapStatusSchema = z
  .object({
    isComplete: z.boolean(),
    updatedAt: z.string().nullable()
  })
  .strict()

export type BootstrapStatus = z.infer<typeof bootstrapStatusSchema>
