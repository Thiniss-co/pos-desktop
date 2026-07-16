import { z } from 'zod'

export const sessionSummarySchema = z
  .object({
    isAuthenticated: z.boolean(),
    userName: z.string().nullable(),
    userEmail: z.string().nullable()
  })
  .strict()

export type SessionSummary = z.infer<typeof sessionSummarySchema>
