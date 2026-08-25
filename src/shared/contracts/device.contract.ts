import { z } from 'zod'

export const deviceIdentitySummarySchema = z
  .object({
    deviceUuid: z.uuid(),
    deviceName: z.string(),
    platform: z.string(),
    osVersion: z.string(),
    appVersion: z.string(),
    isRegistered: z.boolean(),
    registrationStatus: z.string().nullable()
  })
  .strict()

export type DeviceIdentitySummary = z.infer<typeof deviceIdentitySummarySchema>
