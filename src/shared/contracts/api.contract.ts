import { z } from 'zod'

export const publicAppErrorCategorySchema = z.enum([
  'configuration',
  'transport',
  'authentication',
  'authorization',
  'validation',
  'conflict',
  'rejected',
  'unexpected'
])

export const fieldErrorsSchema = z.record(z.string(), z.array(z.string()))

/**
 * The largest `Retry-After` delay, in whole seconds, that is still exact once converted to
 * milliseconds. A server may legitimately ask for hours; anything past this bound is not a usable
 * delay and is treated as absent (the caller then falls back to its own backoff).
 */
export const MAX_RETRY_AFTER_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 1000)

export const publicAppErrorSchema = z
  .object({
    category: publicAppErrorCategorySchema,
    message: z.string(),
    backendCode: z.string().optional(),
    retryable: z.boolean(),
    fieldErrors: fieldErrorsSchema.optional(),
    traceId: z.string().optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    contentType: z.string().trim().min(1).max(200).optional(),
    /**
     * Present only on an HTTP 429 or 503 whose `Retry-After` header was valid: the whole number of
     * seconds the server asked the client to wait. Absent means "no usable server hint".
     */
    retryAfterSeconds: z.number().int().min(0).max(MAX_RETRY_AFTER_SECONDS).optional()
  })
  .strict()

export const apiSuccessEnvelopeSchema = z
  .object({
    success: z.literal(true),
    message: z.string(),
    code: z.string(),
    data: z.unknown(),
    meta: z.record(z.string(), z.unknown()).default({})
  })
  .passthrough()

export const apiErrorEnvelopeSchema = z
  .object({
    success: z.literal(false),
    message: z.string(),
    code: z.string(),
    // Laravel's ApiResponse::error() serializes an empty PHP array as `[]`, while an explicit
    // null has also appeared on controller-produced errors. Both mean no field-level validation
    // errors, so normalize only those empty representations to the contract's record shape.
    errors: z.preprocess(
      (value) =>
        value === null || value === undefined || (Array.isArray(value) && value.length === 0)
          ? {}
          : value,
      fieldErrorsSchema
    ),
    meta: z
      .object({
        trace_id: z.string().optional()
      })
      .passthrough()
      .default({})
  })
  .passthrough()

export const apiEnvelopeSchema = z.union([apiSuccessEnvelopeSchema, apiErrorEnvelopeSchema])

export type PublicAppError = z.infer<typeof publicAppErrorSchema>
export type ApiSuccessEnvelope = z.infer<typeof apiSuccessEnvelopeSchema>
export type ApiErrorEnvelope = z.infer<typeof apiErrorEnvelopeSchema>
export type ApiEnvelope = z.infer<typeof apiEnvelopeSchema>
