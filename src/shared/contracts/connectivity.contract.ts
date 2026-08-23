import { z } from 'zod'

export const connectivityStatusSchema = z.enum([
  'checking',
  'offline',
  'backend_unreachable',
  'online'
])

export const connectivityReasonSchema = z.enum([
  'startup',
  'network_offline',
  'probe_timeout',
  'probe_connection_failed',
  'probe_unhealthy',
  'probe_succeeded',
  'unknown'
])

export const connectivitySnapshotSchema = z
  .object({
    status: connectivityStatusSchema,
    networkAvailable: z.boolean().nullable(),
    backendReachable: z.boolean().nullable(),
    checkedAt: z.string().datetime({ offset: true }).nullable(),
    // Diagnostic only. Never use this as last_validated_at, next_validation_due_at, or a
    // trusted server-time anchor.
    lastBackendReachableAt: z.string().datetime({ offset: true }).nullable(),
    reason: connectivityReasonSchema
  })
  .strict()

export const connectivityRequestOutcomeSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('http_response'), status: z.number().int().min(100).max(599) })
    .strict(),
  z.object({ kind: z.literal('transport_failure') }).strict()
])

export type ConnectivityStatus = z.infer<typeof connectivityStatusSchema>
export type ConnectivityReason = z.infer<typeof connectivityReasonSchema>
export type ConnectivitySnapshot = z.infer<typeof connectivitySnapshotSchema>
export type ConnectivityRequestOutcome = z.infer<typeof connectivityRequestOutcomeSchema>
