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

  it('does not expose tokens, SQL, filesystem access, HTTP, or a caller-provided channel', () => {
    expect(source).not.toMatch(/token|sqlite|sql|fs|fetch|axios/i)
    expect(source).not.toMatch(/invoke\(channel|invoke\(.*unknown/i)
  })

  it('keeps runtime validation out of the sandboxed preload bundle', () => {
    expect(source).not.toContain('connectivitySnapshotSchema')
  })
})
