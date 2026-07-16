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

  it('does not expose tokens, SQL, filesystem access, HTTP, or a caller-provided channel', () => {
    expect(source).not.toMatch(/token|sqlite|sql|fs|fetch|axios/i)
    expect(source).not.toMatch(/invoke\(channel|invoke\(.*unknown/i)
  })
})
