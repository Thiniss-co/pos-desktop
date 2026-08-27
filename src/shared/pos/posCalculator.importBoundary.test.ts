import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./posCalculator.ts', import.meta.url), 'utf8')

const forbiddenImports: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }> = [
  { label: '@renderer', pattern: /from ['"]@renderer\// },
  { label: 'Vue', pattern: /from ['"]vue['"]/ },
  { label: 'Pinia', pattern: /from ['"]pinia['"]/ },
  { label: 'Electron', pattern: /from ['"]electron['"]/ },
  { label: 'Node', pattern: /from ['"]node:/ }
]

describe('shared POS calculator import boundary', () => {
  it('stays portable across renderer and future main-process calculation', () => {
    for (const { label, pattern } of forbiddenImports) {
      expect(pattern.test(source), `posCalculator imports ${label}`).toBe(false)
    }
  })
})
