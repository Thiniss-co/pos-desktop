import { z } from 'zod'

export const activationInputSchema = z
  .object({
    companyCode: z.string().trim().min(1).max(100),
    activationCode: z.string().min(1),
    deviceName: z.string().trim().min(1).max(255).optional()
  })
  .strict()

export type ActivationInput = z.infer<typeof activationInputSchema>

export const activationResultSchema = z
  .object({
    deviceUuid: z.uuid(),
    deviceName: z.string(),
    status: z.string(),
    isRegistered: z.boolean()
  })
  .strict()

export type ActivationResult = z.infer<typeof activationResultSchema>
