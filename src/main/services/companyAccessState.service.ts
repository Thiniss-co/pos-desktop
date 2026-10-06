import { z } from 'zod'

/**
 * Phase 3: the platform's suspension state of this workstation's company, as last observed in any server
 * response (`meta.company_access` on success and error envelopes: sign-in, heartbeat, uploads, refusals).
 *
 * - Persisted (survives a restart) and keyed by company: it only ever applies to the signed-in company.
 * - Applied by revision: an observation with a LOWER revision than the stored one is ignored, so a late
 *   response can never restore an older state. Equal revisions are the same state.
 * - An observation for another company than the session's is ignored (a late answer of an ended session).
 *
 * It is not derived from bootstrap or `company.isActive`: suspension and deactivation are different facts.
 */
export const COMPANY_ACCESS_STATE_SETTING_KEY = 'platform_company_access'

const observationSchema = z
  .object({
    company_id: z.string().uuid(),
    state: z.enum(['active', 'suspended']),
    revision: z.number().int().nonnegative(),
    suspended_at: z.string().nullable()
  })
  .passthrough()

const storedSchema = z
  .object({
    companyId: z.string(),
    state: z.enum(['active', 'suspended']),
    revision: z.number().int().nonnegative(),
    suspendedAt: z.string().nullable(),
    observedAt: z.string()
  })
  .strict()

export type CompanyAccessObservation = z.infer<typeof storedSchema>

export interface CompanyAccessSettings {
  get(key: string): string | null
  set(key: string, value: string): void
}

export interface CompanyAccessSessionContext {
  getContext(): { readonly isAuthenticated: boolean; readonly companyUuid: string | null }
}

export class CompanyAccessStateService {
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly settings: CompanyAccessSettings,
    private readonly session: CompanyAccessSessionContext,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** Applies `meta.company_access` from one response. Returns true when the stored state changed. */
  observe(raw: unknown): boolean {
    const parsed = observationSchema.safeParse(raw)

    if (!parsed.success) {
      return false
    }

    const sessionCompany = this.session.getContext().companyUuid

    if (sessionCompany !== null && sessionCompany !== parsed.data.company_id) {
      return false
    }

    const stored = this.stored()

    if (
      stored &&
      stored.companyId === parsed.data.company_id &&
      parsed.data.revision <= stored.revision
    ) {
      return false
    }

    const next: CompanyAccessObservation = {
      companyId: parsed.data.company_id,
      state: parsed.data.state,
      revision: parsed.data.revision,
      suspendedAt: parsed.data.suspended_at,
      observedAt: this.now().toISOString()
    }
    this.settings.set(COMPANY_ACCESS_STATE_SETTING_KEY, JSON.stringify(next))

    const changed = !stored || stored.companyId !== next.companyId || stored.state !== next.state

    if (changed) {
      for (const listener of this.listeners) {
        try {
          listener()
        } catch {
          // A listener failure must never affect the business request that carried the observation.
        }
      }
    }

    return changed
  }

  /** The stored observation for the signed-in company, or null. */
  current(): CompanyAccessObservation | null {
    const stored = this.stored()
    const sessionCompany = this.session.getContext().companyUuid

    return stored && sessionCompany !== null && stored.companyId === sessionCompany ? stored : null
  }

  /** True only when the signed-in company was last observed suspended. */
  isSuspended(): boolean {
    return this.current()?.state === 'suspended'
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)

    return () => this.listeners.delete(listener)
  }

  private stored(): CompanyAccessObservation | null {
    const value = this.settings.get(COMPANY_ACCESS_STATE_SETTING_KEY)

    if (value === null) {
      return null
    }

    try {
      const parsed = storedSchema.safeParse(JSON.parse(value))

      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }
}
