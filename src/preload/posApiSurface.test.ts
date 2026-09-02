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

  it('exposes no stock-allocation request, grant, or revision capability (CP-5D)', () => {
    // Allocation acquisition is main-only and reachable solely as a side effect of
    // `checkout:complete`/`checkout:retry-attempt`; the renderer can neither ask for a grant nor
    // name one.
    expect(source).not.toMatch(/allocation/i)
    expect(source).not.toMatch(/top-?up/i)
    expect(source).not.toMatch(/idempotency/i)
  })

  it('keeps runtime validation out of the sandboxed preload bundle', () => {
    expect(source).not.toContain('connectivitySnapshotSchema')
  })
})
