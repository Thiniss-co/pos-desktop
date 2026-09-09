import { describe, expect, it } from 'vitest'
import type { PrepareCycleOutcome } from './preparation.service'
import { PreparationReconnectService } from './preparationReconnect.service'

/*
 * CP4 — the §7.3 reconnect state machine.
 *
 * The properties under test are all *ordering* properties, and each corresponds to a rule the plan
 * had to correct at least once. They are worth pinning precisely because the wrong ordering does
 * not fail loudly: it deadlocks, or it seals healthy stock, and either way the symptom appears far
 * from the cause.
 */

const OWNER = { companyUuid: 'company', deviceUuid: 'device', warehouseUuid: 'warehouse' }

function build(overrides: {
  readonly authority?: { ok: boolean; detail?: string }
  readonly refresh?: { ok: boolean; detail?: string }
  readonly drain?: { ok: boolean; detail?: string }
  readonly preparation?: PrepareCycleOutcome
}): {
  readonly service: PreparationReconnectService
  readonly calls: string[]
} {
  const calls: string[] = []

  const service = new PreparationReconnectService({
    restoreAuthority: async () => {
      calls.push('restoreAuthority')
      return overrides.authority ?? { ok: true }
    },
    refreshAuthoritativeState: async () => {
      calls.push('refreshAuthoritativeState')
      return overrides.refresh ?? { ok: true }
    },
    drainCapturedDependencies: async () => {
      calls.push('drainCapturedDependencies')
      return overrides.drain ?? { ok: true }
    },
    preparation: {
      runCycle: async () => {
        calls.push('runCycle')
        return overrides.preparation ?? { kind: 'applied', operationUuid: 'operation' }
      }
    }
  })

  return { service, calls }
}

describe('the §7.3 reconnect state machine', () => {
  it('restores authority, refreshes, drains, then prepares — in that order', () => {
    const { service, calls } = build({})

    return service.reconnect(OWNER).then((outcome) => {
      expect(calls).toEqual([
        'restoreAuthority',
        'refreshAuthoritativeState',
        'drainCapturedDependencies',
        'runCycle'
      ])
      expect(outcome.preparation).toEqual({ kind: 'applied', operationUuid: 'operation' })
    })
  })

  it('refreshes BEFORE uploading, and does not reintroduce an upload-first rule', async () => {
    // §2.2 finding 1: "every refresh before every upload is unsafe" is FALSE. The frozen
    // reconciliation representation makes a verified refresh safe before upload, and the required
    // rule is monotonic reconciliation rather than blanket upload-first ordering.
    //
    // Reintroducing upload-first here would recreate the exact deadlock §7.3 exists to remove:
    // uploads need refreshed authority, and refresh would be waiting for an empty queue that §7.1
    // proves never comes.
    const { service, calls } = build({})
    await service.reconnect(OWNER)

    expect(calls.indexOf('refreshAuthoritativeState')).toBeLessThan(
      calls.indexOf('drainCapturedDependencies')
    )
  })

  it('stops before refresh, drain, and preparation when authority cannot be restored', async () => {
    // Without current authority nothing later can be trusted, and preparation in particular would
    // dispatch under credentials the server may already have revoked.
    const { service, calls } = build({ authority: { ok: false, detail: 'license_overdue' } })
    const outcome = await service.reconnect(OWNER)

    expect(calls).toEqual(['restoreAuthority'])
    expect(outcome.preparation).toBeNull()
    expect(outcome.steps).toEqual([
      { step: 'authority_restored', ok: false, detail: 'license_overdue' }
    ])
  })

  it('still drains and prepares when refresh fails', async () => {
    // A queued invoice's payload is immutable and its authority is historical, so uploading it does
    // not need a fresh snapshot. Blocking the drain on refresh is precisely the dependency cycle
    // §7.3 removes.
    const { service, calls } = build({ refresh: { ok: false, detail: 'bootstrap_incomplete' } })
    await service.reconnect(OWNER)

    expect(calls).toContain('drainCapturedDependencies')
    expect(calls).toContain('runCycle')
  })

  it('never seals or retires healthy grants merely because connectivity returned', async () => {
    // §7.3 item 6 and §14.2 item 8. The non-action is recorded explicitly in the trace so a future
    // change cannot quietly add one without this assertion noticing.
    const { service } = build({})
    const outcome = await service.reconnect(OWNER)
    const retirement = outcome.steps.find((step) => step.step === 'retirement_skipped')

    expect(retirement).toEqual({
      step: 'retirement_skipped',
      ok: true,
      detail: 'healthy_grants_retained'
    })
  })

  it('reports a blocked cycle as a normal outcome rather than a failed reconnect', async () => {
    // §4.4: a blocked cycle is a persisted terminal outcome with its reasons. The UI shows it and
    // does not loop, mint a new operation, or imply that refreshing will fix it.
    const { service } = build({
      preparation: { kind: 'blocked', reason: 'terminal_conflict' }
    })
    const outcome = await service.reconnect(OWNER)

    expect(outcome.preparation).toEqual({ kind: 'blocked', reason: 'terminal_conflict' })
    expect(outcome.steps.find((step) => step.step === 'preparation_ran')?.detail).toBe('blocked')
  })

  it('records an ambiguous cycle without treating it as success', async () => {
    const { service } = build({
      preparation: { kind: 'ambiguous', operationUuid: 'operation' }
    })
    const outcome = await service.reconnect(OWNER)

    expect(outcome.steps.find((step) => step.step === 'preparation_ran')?.ok).toBe(false)
  })
})
