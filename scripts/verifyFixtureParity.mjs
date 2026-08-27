import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const desktopFixturesDir = resolve(projectRoot, 'tests', 'fixtures')
const backendFixturesDir = resolve(projectRoot, '..', 'pos-backend', 'tests', 'Fixtures')

const ARTIFACTS = [
  'pos-calculator-golden.json',
  'pos-calculator-exceptions-golden.json',
  'pos-request-validation-golden.json'
]

/** Mirrors the backend generator's canonicalize(): sort object keys recursively, leave arrays in order. */
const canonicalize = (value) => {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }

  if (value !== null && typeof value === 'object') {
    const sorted = {}
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalize(value[key])
    }
    return sorted
  }

  return value
}

/** Mirrors the backend generator's manifestHash(): sha256 of the canonicalized {schemaVersion, calculationVersion, cases}. */
const manifestHash = (manifest) => {
  const canonical = canonicalize({
    schemaVersion: manifest.schemaVersion,
    calculationVersion: manifest.calculationVersion,
    cases: manifest.cases
  })

  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

if (!existsSync(backendFixturesDir)) {
  console.error(
    `verify:fixture: sibling repo not found at ${backendFixturesDir}. Neither repo has CI, so ` +
      'this is a local-only gate — clone pos-backend alongside pos-desktop to run it.'
  )
  process.exit(1)
}

let failed = false

for (const artifact of ARTIFACTS) {
  const desktopPath = resolve(desktopFixturesDir, artifact)
  const backendPath = resolve(backendFixturesDir, artifact)

  if (!existsSync(desktopPath)) {
    console.error(`verify:fixture: ${artifact} is missing from this repo at ${desktopPath}`)
    failed = true
    continue
  }

  if (!existsSync(backendPath)) {
    console.error(`verify:fixture: ${artifact} is missing from pos-backend at ${backendPath}`)
    failed = true
    continue
  }

  const desktopRaw = readFileSync(desktopPath, 'utf8')
  const backendRaw = readFileSync(backendPath, 'utf8')

  if (desktopRaw !== backendRaw) {
    console.error(`verify:fixture: ${artifact} differs byte-for-byte between the two repos`)
    failed = true
    continue
  }

  const manifest = JSON.parse(desktopRaw)
  const recomputed = manifestHash(manifest)

  if (recomputed !== manifest.sha256) {
    console.error(
      `verify:fixture: ${artifact}'s stored sha256 (${manifest.sha256}) does not match its ` +
        `independently recomputed hash (${recomputed})`
    )
    failed = true
    continue
  }

  console.log(`verify:fixture: ${artifact} OK — byte-identical, hash independently verified`)
}

if (failed) {
  process.exit(1)
}

console.log('verify:fixture: all three golden fixtures verified byte-for-byte against pos-backend.')
