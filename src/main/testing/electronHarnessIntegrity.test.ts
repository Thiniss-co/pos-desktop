import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectRoot = resolve(process.cwd())
const electronRoot = resolve(projectRoot, 'tests/electron')

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? filesUnder(path) : [path]
  })
}

function source(path: string): string {
  return readFileSync(path, 'utf8')
}

describe('Electron SQLite harness integrity', () => {
  it('keeps every production-ABI suite imported and free of fake repositories', () => {
    const files = filesUnder(electronRoot)
    const suites = files.filter((path) => path.endsWith('.suite.ts'))
    const index = source(resolve(electronRoot, 'index.ts'))

    expect(suites.length).toBeGreaterThan(0)
    for (const suite of suites) {
      const basename = suite.slice(suite.lastIndexOf('/') + 1, -3)
      expect(index).toContain(`./suites/${basename}`)
      const suiteSource = source(suite)
      expect(suiteSource).toContain('databaseTest(')
      expect(suiteSource).not.toMatch(/\b(?:vi|jest|sinon)\./)
      expect(suiteSource).not.toMatch(/class\s+\w*(?:Mock|Fake)Repository/)
      expect(suiteSource).not.toContain("':memory:'")

      if (/\broll(?:s)? back\b/i.test(suiteSource)) {
        expect(suiteSource).toContain('readCommitted(')
      }
    }
  })

  it('contains native filesystem and database entry points only in their sanctioned support modules', () => {
    const allowances: Record<string, readonly string[]> = {
      'new Database(': ['support/committedState.ts'],
      'openDatabase(': ['support/openTestDatabase.ts'],
      'runMigrations(': ['support/openTestDatabase.ts'],
      'rmSync(': ['support/sandbox.ts']
    }

    for (const [needle, allowedPaths] of Object.entries(allowances)) {
      const matchedPaths: string[] = []

      for (const path of filesUnder(electronRoot)) {
        if (!source(path).includes(needle)) {
          continue
        }

        const relativePath = path.slice(electronRoot.length + 1)
        matchedPaths.push(relativePath)
        expect(allowedPaths).toContain(relativePath)
      }

      expect(matchedPaths.length, `source sweep did not cover ${needle}`).toBeGreaterThan(0)
    }

    for (const path of filesUnder(electronRoot)) {
      expect(source(path)).not.toContain('applicationServices')
    }
  })

  it('constructs concrete repositories only through the asserted factory', () => {
    const factoryPath = resolve(electronRoot, 'support/realRepositories.ts')

    for (const path of filesUnder(electronRoot)) {
      if (path === factoryPath) {
        continue
      }

      expect(source(path)).not.toMatch(/\bnew\s+\w*Repository\s*\(/)
    }
  })

  it('prevents production main-process modules from importing test fixtures', () => {
    const mainRoot = resolve(projectRoot, 'src/main')
    const productionFiles = filesUnder(mainRoot).filter(
      (path) => !path.includes('/testing/') && !path.endsWith('.test.ts')
    )

    for (const path of productionFiles) {
      expect(source(path)).not.toContain('/testing/')
      expect(source(path)).not.toContain('../testing/')
    }
  })
})
