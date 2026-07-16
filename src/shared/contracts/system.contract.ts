import { z } from 'zod'

export const runtimeInfoSchema = z
  .object({
    appVersion: z.string(),
    electronVersion: z.string(),
    chromeVersion: z.string(),
    nodeVersion: z.string(),
    platform: z.string(),
    apiConfiguration: z.enum(['configured', 'not_configured'])
  })
  .strict()

export type RuntimeInfo = z.infer<typeof runtimeInfoSchema>
