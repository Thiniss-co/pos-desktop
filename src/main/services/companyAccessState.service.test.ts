import { describe, expect, it, vi } from 'vitest'
import {
  COMPANY_ACCESS_STATE_SETTING_KEY,
  CompanyAccessStateService
} from './companyAccessState.service'

const COMPANY = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'

interface SetUp {
  readonly service: CompanyAccessStateService
  readonly values: Map<string, string>
  readonly context: { isAuthenticated: boolean; companyUuid: string | null }
}

interface AccessPayload {
  readonly company_id: string
  readonly state: 'active' | 'suspended'
  readonly revision: number
  readonly suspended_at: string | null
}

function setUp(companyUuid: string | null = COMPANY): SetUp {
  const values = new Map<string, string>()
  const settings = {
    get: (key: string) => values.get(key) ?? null,
    set: (key: string, value: string) => void values.set(key, value)
  }
  const context = { isAuthenticated: companyUuid !== null, companyUuid }
  const service = new CompanyAccessStateService(
    settings,
    { getContext: () => context },
    () => new Date('2026-10-06T12:00:00Z')
  )

  return { service, values, context }
}

const access = (
  state: 'active' | 'suspended',
  revision: number,
  company = COMPANY
): AccessPayload => ({
  company_id: company,
  state,
  revision,
  suspended_at: state === 'suspended' ? '2026-10-06T10:00:00+00:00' : null
})

describe('CompanyAccessStateService', () => {
  it('applies a newer revision, persists it and notifies once per state change', () => {
    const { service, values } = setUp()
    const listener = vi.fn()
    service.onChange(listener)

    expect(service.observe(access('suspended', 1))).toBe(true)
    expect(service.isSuspended()).toBe(true)
    expect(JSON.parse(values.get(COMPANY_ACCESS_STATE_SETTING_KEY) ?? '{}')).toMatchObject({
      companyId: COMPANY,
      state: 'suspended',
      revision: 1
    })
    expect(service.observe(access('suspended', 1))).toBe(false)
    expect(service.observe(access('active', 2))).toBe(true)
    expect(service.isSuspended()).toBe(false)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('never lets a late, older answer restore an older state', () => {
    const { service } = setUp()
    service.observe(access('suspended', 3))

    expect(service.observe(access('active', 2))).toBe(false)
    expect(service.isSuspended()).toBe(true)
  })

  it('ignores another company and anything malformed, and only reports the signed-in company', () => {
    const { service, context } = setUp()

    expect(service.observe(access('suspended', 1, OTHER))).toBe(false)
    expect(service.observe({ state: 'suspended' })).toBe(false)
    expect(service.observe(null)).toBe(false)
    expect(service.isSuspended()).toBe(false)

    service.observe(access('suspended', 1))
    context.companyUuid = OTHER
    expect(service.isSuspended()).toBe(false)
    expect(service.current()).toBeNull()
  })

  it('accepts the state carried by a sign-in response before the session records its company', () => {
    const { service, context } = setUp(null)

    expect(service.observe(access('suspended', 4))).toBe(true)
    context.companyUuid = COMPANY
    expect(service.isSuspended()).toBe(true)
  })
})
