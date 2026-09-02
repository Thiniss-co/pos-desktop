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

// Phase 3F CP-5a (plan §6.4): a fourth artifact with a different hashed shape — it has no
// `calculationVersion`/`cases`, so it cannot reuse `manifestHash` above. Until BE-3F-2B places its
// own copy in pos-backend, this artifact is expected to report "missing from pos-backend" below —
// that is CP-5a's own definition ("Completing CP-5a does not mean the verification gate passed"),
// not a bug in this script.
const CP5A_ARTIFACT = 'desktop-committed-invoice-payload.json'
const ALLOCATION_ARTIFACT = 'stock-allocation-envelope-golden.json'
const ALLOCATION_RAW_SHA256 = 'ee71f33fa919983626fae769b831184b1bb47d44eb2de108a9bef995407fa049'
const ALLOCATION_SCHEMA_VERSION = 1
const SUPPORTED_ALLOCATION_CONTRACT_VERSION = 1
const ALLOCATION_STATUSES = [
  'active',
  'revocation_pending',
  'seal_acknowledged',
  'released',
  'consumed'
]

/** Mirrors `tests/electron/support/cp5aScenario.ts`'s `cp5aArtifactHash`. */
const cp5aArtifactHash = (manifest) => {
  const canonical = canonicalize({
    schemaVersion: manifest.schemaVersion,
    emittingSuite: manifest.emittingSuite,
    fixtureContext: manifest.fixtureContext,
    payload: manifest.payload
  })

  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

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

/** Mirrors the Laravel allocation generator: omit only canonicalSha256, then recursively sort. */
const allocationManifestHash = (manifest) => {
  const hashable = Object.fromEntries(
    Object.entries(manifest).filter(([key]) => key !== 'canonicalSha256')
  )
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(hashable)))
    .digest('hex')
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

{
  const desktopPath = resolve(desktopFixturesDir, CP5A_ARTIFACT)
  const backendPath = resolve(backendFixturesDir, CP5A_ARTIFACT)

  if (!existsSync(desktopPath)) {
    console.error(`verify:fixture: ${CP5A_ARTIFACT} is missing from this repo at ${desktopPath}`)
    failed = true
  } else {
    const desktopRaw = readFileSync(desktopPath, 'utf8')
    const manifest = JSON.parse(desktopRaw)
    const recomputed = cp5aArtifactHash(manifest)

    if (recomputed !== manifest.sha256) {
      console.error(
        `verify:fixture: ${CP5A_ARTIFACT}'s stored sha256 (${manifest.sha256}) does not match ` +
          `its independently recomputed hash (${recomputed})`
      )
      failed = true
    } else if (!existsSync(backendPath)) {
      // Plan §6.4/CP-5a: expected until BE-3F-2B places its own copy in pos-backend — "Completing
      // CP-5a does not mean the verification gate passed." The desktop-side hash is still valid.
      console.error(
        `verify:fixture: ${CP5A_ARTIFACT} is self-consistent (hash verified) but has no ` +
          `pos-backend copy yet at ${backendPath} — expected until BE-3F-2B lands; this is not a ` +
          'desktop-side defect.'
      )
      failed = true
    } else {
      const backendRaw = readFileSync(backendPath, 'utf8')

      if (desktopRaw !== backendRaw) {
        console.error(
          `verify:fixture: ${CP5A_ARTIFACT} differs byte-for-byte between the two repos`
        )
        failed = true
      } else {
        console.log(
          `verify:fixture: ${CP5A_ARTIFACT} OK — byte-identical, hash independently verified`
        )
      }
    }
  }
}

{
  const desktopPath = resolve(desktopFixturesDir, ALLOCATION_ARTIFACT)
  const backendPath = resolve(backendFixturesDir, ALLOCATION_ARTIFACT)

  if (!existsSync(desktopPath)) {
    console.error(
      `verify:fixture: ${ALLOCATION_ARTIFACT} is missing from this repo at ${desktopPath}`
    )
    failed = true
  } else if (!existsSync(backendPath)) {
    console.error(
      `verify:fixture: ${ALLOCATION_ARTIFACT} is missing from pos-backend at ${backendPath}`
    )
    failed = true
  } else {
    const desktopRaw = readFileSync(desktopPath)
    const backendRaw = readFileSync(backendPath)
    const rawSha256 = createHash('sha256').update(desktopRaw).digest('hex')

    if (!desktopRaw.equals(backendRaw)) {
      console.error(
        `verify:fixture: ${ALLOCATION_ARTIFACT} differs byte-for-byte between the two repos`
      )
      failed = true
    } else if (rawSha256 !== ALLOCATION_RAW_SHA256) {
      console.error(
        `verify:fixture: ${ALLOCATION_ARTIFACT} raw sha256 (${rawSha256}) does not match ` +
          `the approved Laravel artifact (${ALLOCATION_RAW_SHA256})`
      )
      failed = true
    } else {
      try {
        const manifest = JSON.parse(desktopRaw.toString('utf8'))
        const recomputed = allocationManifestHash(manifest)
        const caseStatuses = Array.isArray(manifest.cases)
          ? manifest.cases.map((entry) => entry?.status)
          : null
        const topUpData = manifest.topUpFragment?.data
        const bootstrapData = manifest.bootstrapFragment?.stock_allocations

        if (manifest.schemaVersion !== ALLOCATION_SCHEMA_VERSION) {
          throw new Error(`unsupported schemaVersion ${String(manifest.schemaVersion)}`)
        }
        if (manifest.allocationContractVersion !== SUPPORTED_ALLOCATION_CONTRACT_VERSION) {
          throw new Error(
            `unsupported allocationContractVersion ${String(manifest.allocationContractVersion)}`
          )
        }
        if (
          manifest.canonicalization?.algorithm !== 'recursive-key-sort-json-unescaped-slashes-v1'
        ) {
          throw new Error('unsupported canonicalization algorithm')
        }
        if (recomputed !== manifest.canonicalSha256) {
          throw new Error(
            `stored canonicalSha256 (${String(manifest.canonicalSha256)}) does not match ` +
              `the independently recomputed hash (${recomputed})`
          )
        }
        if (
          JSON.stringify(manifest.statuses) !== JSON.stringify(ALLOCATION_STATUSES) ||
          JSON.stringify(caseStatuses) !== JSON.stringify(ALLOCATION_STATUSES)
        ) {
          throw new Error('unexpected lifecycle status coverage')
        }
        if (
          !Array.isArray(manifest.resourceKeys) ||
          manifest.resourceKeys.length !== 21 ||
          !Array.isArray(topUpData) ||
          !Array.isArray(bootstrapData) ||
          JSON.stringify(topUpData) !== JSON.stringify(bootstrapData)
        ) {
          throw new Error('malformed or divergent allocation consumer fragments')
        }

        console.log(
          `verify:fixture: ${ALLOCATION_ARTIFACT} OK — byte-identical, raw and canonical hashes independently verified`
        )
      } catch (error) {
        console.error(
          `verify:fixture: ${ALLOCATION_ARTIFACT} is malformed: ${error instanceof Error ? error.message : String(error)}`
        )
        failed = true
      }
    }
  }
}

if (failed) {
  process.exit(1)
}

console.log('verify:fixture: all fixtures verified byte-for-byte against pos-backend.')
