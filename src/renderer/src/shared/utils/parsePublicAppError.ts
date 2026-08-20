import { publicAppErrorSchema, type PublicAppError } from '@shared/contracts/api.contract'

export function parsePublicAppError(value: unknown): PublicAppError | null {
  const parsed = publicAppErrorSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
