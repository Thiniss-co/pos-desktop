import { z } from 'zod'

export const sessionSummarySchema = z
  .object({
    isAuthenticated: z.boolean(),
    userName: z.string().nullable(),
    userEmail: z.string().nullable()
  })
  .strict()

export type SessionSummary = z.infer<typeof sessionSummarySchema>

export const loginInputSchema = z
  .object({
    email: z.string().trim().min(1).max(255),
    password: z.string().min(1)
  })
  .strict()

export type LoginInput = z.infer<typeof loginInputSchema>
