import { z } from 'zod'

/**
 * PS6b §7.3a.3/§7.3a.5 — the STORED disposition result, as the desktop strictly parses it.
 *
 * `.strict()` throughout, and every field required. A result the desktop does not fully understand
 * must fail verification rather than be partially applied: this decides whether a completed sale
 * converges and whether an allocation identity is permanently held, so a silently-ignored field is
 * not an acceptable outcome.
 */
export const dispositionProofResultSchema = z
  .object({
    line_index: z.number().int().nonnegative(),
    proof_index: z.number().int().nonnegative(),
    allocation_uuid: z.string(),
    rights_generation: z.number().int().positive(),
    consumption_sequence: z.number().int().positive(),
    local_consumption_uuid: z.string(),
    item_line_uuid: z.string(),
    quantity_milli: z.number().int().positive(),
    request_hash: z.string().length(64),
    outcome: z.enum(['accepted', 'overridden']),
    server_consumption_uuid: z.string().nullable(),
    override_reason: z.string().nullable()
  })
  .strict()

export const dispositionCoverageSchema = z
  .object({
    allocation_uuid: z.string(),
    rights_generation: z.number().int().positive(),
    accepted_consumption_sequence: z.number().int().positive(),
    accepted_consumed_quantity_milli: z.number().int().nonnegative(),
    accepted_chain_hash: z.string().nullable()
  })
  .strict()

export const dispositionRequiredHoldSchema = z
  .object({
    allocation_uuid: z.string(),
    rights_generation: z.number().int().positive(),
    first_overridden_sequence: z.number().int().positive(),
    reason: z.literal('invoice_disposition_chain_break'),
    // A literal false, not a boolean: there is no release path in this scope, so a `true` here is a
    // contract violation rather than an instruction.
    release_allowed: z.literal(false)
  })
  .strict()

export const dispositionResultSchema = z
  .object({
    version: z.literal(1),
    decision: z.enum(['accept_without_proof', 'reject_permanently']),
    decided_at: z.string(),
    binding: z
      .object({
        idempotency_key: z.string(),
        local_invoice_uuid: z.string(),
        request_hash: z.string().length(64),
        client_contract_version: z.literal(3),
        offline_sale_authority_uuid: z.string().nullable()
      })
      .strict(),
    invoice: z.object({ invoice_uuid: z.string(), server_number: z.string() }).strict().nullable(),
    proof_results: z.array(dispositionProofResultSchema),
    coverage: z.array(dispositionCoverageSchema),
    required_holds: z.array(dispositionRequiredHoldSchema)
  })
  .strict()

export const dispositionEnvelopeSchema = z
  .object({
    id: z.string(),
    decision: z.enum(['accept_without_proof', 'reject_permanently']),
    decided_at: z.string(),
    result_version: z.literal(1),
    result_hash: z.string().length(64),
    result: dispositionResultSchema
  })
  .strict()

export const syncStatusEntrySchema = z
  .object({
    idempotency_key: z.string(),
    status: z.string(),
    local_invoice_uuid: z.string().optional(),
    client_contract_version: z.number().int().optional(),
    quarantine_reason: z.string().nullable().optional(),
    quarantined_at: z.string().nullable().optional(),
    processed_at: z.string().nullable().optional(),
    invoice: z
      .object({ invoice_uuid: z.string(), server_number: z.string() })
      .strict()
      .nullable()
      .optional(),
    disposition: dispositionEnvelopeSchema.nullable().optional()
  })
  .passthrough()

export const syncStatusResponseSchema = z
  .object({ statuses: z.array(syncStatusEntrySchema) })
  .passthrough()

export type DispositionEnvelope = z.infer<typeof dispositionEnvelopeSchema>
export type DispositionResult = z.infer<typeof dispositionResultSchema>
export type DispositionProofResult = z.infer<typeof dispositionProofResultSchema>
export type SyncStatusEntry = z.infer<typeof syncStatusEntrySchema>

/** PS6b: why a discovered result was refused. Every value is durable evidence, never a retry hint. */
export const DISPOSITION_CONFLICT_CODES = [
  'malformed-result',
  'result-hash-mismatch',
  'binding-mismatch',
  'payload-hash-mismatch',
  'proof-set-mismatch',
  'accepted-proof-missing-server-consumption',
  'rejection-contains-accepted-proof',
  'coverage-prefix-unverified',
  'hold-instruction-mismatch',
  'invoice-uuid-conflict',
  'conflicting-disposition'
] as const

export type DispositionConflictCode = (typeof DISPOSITION_CONFLICT_CODES)[number]
