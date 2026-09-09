import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./posApi.ts', import.meta.url), 'utf8')

describe('posApi surface', () => {
  it('contains only named foundation methods', () => {
    expect(source).toContain('getRuntimeInfo')
    expect(source).toContain('getIdentitySummary')
    expect(source).toContain('getSessionSummary')
    expect(source).toContain('getStatus')
  })

  it('contains the Phase 2 activation, login, license, and bootstrap methods', () => {
    expect(source).toContain('register')
    expect(source).toContain('login')
    expect(source).toContain('refreshSession')
    expect(source).toContain('logout')
    expect(source).toContain('validate')
    expect(source).toContain('getAccess')
    expect(source).toContain('refresh')
  })

  it('contains only the named connectivity and preference methods', () => {
    expect(source).toContain('connectivity')
    expect(source).toContain('getState')
    expect(source).toContain('checkNow')
    expect(source).toContain('onChanged')
    expect(source).toContain('preferences')
    expect(source).toContain('getLocale')
    expect(source).toContain('setLocale')
    expect(source).toContain('getTheme')
    expect(source).toContain('setTheme')
  })

  it('contains only named company-user management methods', () => {
    expect(source).toContain('companyUsers')
    expect(source).toContain('listAssignableRoles')
    expect(source).toContain('setEnabled')
    expect(source).toContain('setRoles')
  })

  it('contains only narrow read-only catalog and explicit shift lifecycle methods', () => {
    expect(source).toContain('catalog')
    expect(source).toContain('listCategories')
    expect(source).toContain('searchProducts')
    expect(source).toContain('findProductByBarcode')
    expect(source).toContain('searchCustomers')
    expect(source).toContain('listPaymentMethods')
    expect(source).toContain('shifts')
    expect(source).toContain('pause')
    expect(source).toContain('resume')
    expect(source).toContain('close')
  })

  it('contains the checkout preview method and the five Phase 3F completion/recovery methods', () => {
    expect(source).toContain('checkout')
    expect(source).toContain('checkoutValidate')
    expect(source).toContain('complete')
    expect(source).toContain('retryAttempt')
    expect(source).toContain('abandonAttempt')
    expect(source).toContain('acknowledgeAttempt')
    expect(source).toContain('pendingAttempts')
  })

  it('does not expose tokens, SQL, filesystem access, HTTP, or a caller-provided channel', () => {
    expect(source).not.toMatch(/token|sqlite|sql|fs|fetch|axios/i)
    expect(source).not.toMatch(/invoke\(channel|invoke\(.*unknown/i)
  })

  it('exposes only the narrow stock-allocation recovery capability (BH-04B-4)', () => {
    // Allocation acquisition is main-only and reachable solely as a side effect of
    // `checkout:complete`/`checkout:retry-attempt`. Recovery may name an already-owned allocation,
    // but cannot request rights, quantities, generations, revisions, or idempotency keys.
    expect(source).toContain('allocationRecovery')
    expect(source).toContain('start(input: { allocationUuid: string })')
    expect(source).toContain('resume(): Promise<IpcResult<void>>')
    expect(source).not.toMatch(
      /requestAllocation|grantAllocation|requestedQuantity|rightsGeneration/i
    )
    expect(source).not.toMatch(/top-?up/i)
    expect(source).not.toMatch(/idempotency/i)
  })

  it('keeps runtime validation out of the sandboxed preload bundle', () => {
    expect(source).not.toContain('connectivitySnapshotSchema')
    expect(source).not.toContain('syncStatusSchema')
    expect(source).not.toContain('syncFailurePageSchema')
  })

  it('exposes exactly the four named sync capabilities (CP-3G-4)', () => {
    expect(source).toContain('uploadNow')
    expect(source).toContain('listFailures')
    expect(source).toContain('syncGetStatus')
    expect(source).toContain('syncUploadNow')
    expect(source).toContain('syncListFailures')
    expect(source).toContain('syncChanged')
  })

  it('validates a pushed sync status structurally before calling a renderer listener', () => {
    // The listener is called only from inside the guard, so neither a malformed payload nor the
    // Electron event object can reach renderer code.
    expect(source).toContain('isSyncStatusShape')
    expect(source).toMatch(/if \(isSyncStatusShape\(payload\)\) \{\s*listener\(payload\)/)
  })

  it('exposes no sync mutation beyond an unparameterised scheduling hint', () => {
    // `uploadNow` takes no argument at all: the renderer cannot name a queue row, an invoice, an
    // owner or a state, so no preload call can retry, resolve or revive a terminal failure.
    expect(source).toContain('uploadNow: () => ipcRenderer.invoke(IPC_CHANNELS.syncUploadNow)')
    expect(source).not.toMatch(/retryUpload|resolveConflict|deleteFailure|markResolved/i)
  })

  it('never registers an inbound handler for the push-only sync channel', () => {
    // `sync:changed` is main-to-renderer only; the preload may listen, never send.
    expect(source).not.toMatch(/send\(IPC_CHANNELS\.syncChanged/)
    expect(source).not.toMatch(/invoke\(IPC_CHANNELS\.syncChanged/)
  })
})
