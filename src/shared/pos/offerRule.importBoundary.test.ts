import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./offerRule.ts', import.meta.url), 'utf8')

describe('shared offer rule import boundary', () => {
  it('imports nothing, so main and renderer evaluate offers with the same code', () => {
    expect(/^import /m.test(source)).toBe(false)
  })
})
