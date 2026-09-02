#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(HERE, '..')
const DIST_ROOT = join(PROJECT_ROOT, 'dist')
const CONFIG_PATH = join(PROJECT_ROOT, 'electron-builder.yml')
const FORBIDDEN = [
  /(?:^|\/)seedLiveBackend\.php$/i,
  /(?:^|\/)cp3g5LiveUpload\.mjs$/i,
  /(?:^|\/)cp3g5-backend\.sqlite$/i,
  /(?:^|\/)cp3g5-fixture\.json$/i,
  /(?:^|\/)pos-desktop-cp3g5-[^/]+/i
]

function fail(message) {
  console.error(`[cp3g5-package] ${message}`)
  process.exit(1)
}

function filesUnder(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? filesUnder(path) : [path]
  })
}

function assertNoForbiddenPath(path) {
  const normalized = path.replaceAll('\\', '/')

  if (FORBIDDEN.some((pattern) => pattern.test(normalized))) {
    fail(`packaged output contains forbidden CP-3G-5 asset: ${basename(path)}`)
  }
}

const config = readFileSync(CONFIG_PATH, 'utf8')
const requiredExclusions = [
  '!scripts/cp3g5LiveUpload.mjs',
  '!tests/electron/support/cp3g5/**',
  '!**/pos-desktop-cp3g5-*',
  '!**/cp3g5-backend.sqlite',
  '!**/cp3g5-fixture.json'
]

for (const exclusion of requiredExclusions) {
  if (!config.includes(exclusion)) fail(`electron-builder configuration lacks ${exclusion}`)
}

if (!existsSync(DIST_ROOT)) fail('dist does not exist; run npm run build:unpack first')

const artifacts = filesUnder(DIST_ROOT)

for (const artifact of artifacts) assertNoForbiddenPath(artifact)

const asars = artifacts.filter((path) => basename(path) === 'app.asar' && lstatSync(path).isFile())

if (asars.length === 0) fail('no packaged app.asar found under dist')

for (const asar of asars) {
  const listing = spawnSync(join(PROJECT_ROOT, 'node_modules/.bin/asar'), ['list', asar], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8'
  })

  if (listing.status !== 0) fail('could not inspect packaged app.asar')

  for (const packagedPath of listing.stdout.split('\n').filter(Boolean)) {
    assertNoForbiddenPath(packagedPath)
  }
}

console.log(
  `[cp3g5-package] PASS: inspected ${artifacts.length} files and ${asars.length} app.asar artifact(s)`
)
