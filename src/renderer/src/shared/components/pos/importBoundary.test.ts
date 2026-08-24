import { readdirSync, readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

// Every Phase 3 presentational component under shared/components/pos/ must stay pure
// presentation: typed props/emits in, events out, no side effects. This is a source-text sweep
// (the repo's established pattern for a boundary that must hold across every file in a folder —
// see posApiSurface.test.ts) rather than a runtime mock, because the point is that the *import*
// itself must never appear, not just that a mocked call doesn't happen to run.
const componentsDir = new URL('./', import.meta.url)
const files = readdirSync(componentsDir).filter(
  (name) => name.endsWith('.vue') || (name.endsWith('.ts') && name !== 'importBoundary.test.ts')
)

const forbiddenPatterns: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'window.posApi', pattern: /window\.posApi/ },
  { label: 'a business Pinia store', pattern: /from ['"]@renderer\/modules\/(?!preferences)/ },
  { label: 'direct fetch/HTTP', pattern: /\bfetch\(/ },
  { label: 'SQLite/better-sqlite3', pattern: /better-sqlite3|\bsqlite\b/i }
]

describe('shared/components/pos import boundary', () => {
  it('found the expected component files (sanity check the sweep is not vacuous)', () => {
    expect(files.length).toBeGreaterThan(15)
  })

  for (const file of files) {
    it(`${file} never imports IPC, HTTP, SQLite, or a business store`, () => {
      const source = readFileSync(new URL(file, componentsDir), 'utf8')

      for (const { label, pattern } of forbiddenPatterns) {
        expect(pattern.test(source), `${file} appears to import/use ${label}`).toBe(false)
      }
    })
  }
})
