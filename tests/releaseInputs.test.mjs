/**
 * The release inputs gate (scripts/verifyReleaseInputs.mjs): today's template configuration is
 * refused, and a configuration with every input supplied passes.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { releaseInputProblems } from '../scripts/verifyReleaseInputs.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const builderYaml = readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8')
const templateIcon = readFileSync(join(ROOT, 'resources/icon.png'))

test('the repository as committed is not a release candidate', () => {
  const problems = releaseInputProblems({
    packageJson,
    builderYaml,
    env: {},
    files: { 'resources/icon.png': templateIcon, 'build/icon.ico': null }
  })
  for (const expected of [
    /appId/,
    /author/,
    /homepage/,
    /linux\.maintainer/,
    /scaffold icon/,
    /icon\.ico/,
    /MAIN_VITE_POS_API_ORIGIN/,
    /MAIN_VITE_POS_UPDATE_FEED_URL/,
    /publish\.url/,
    /code signing/
  ]) {
    assert.ok(
      problems.some((problem) => expected.test(problem)),
      `expected a problem matching ${expected}`
    )
  }
})

const supplied = {
  packageJson: {
    ...packageJson,
    author: 'Company Ltd <support@company.test>',
    homepage: 'https://company.test'
  },
  builderYaml: builderYaml
    .replace(/^appId: .*$/m, 'appId: test.company.pos')
    .replace(/^ {2}maintainer: .*$/m, '  maintainer: Company Ltd <support@company.test>')
    .replace(
      /^ {2}url: https:\/\/example\.com\/auto-updates$/m,
      '  url: https://updates.company.test/pos'
    )
    .replace(/^win:\n/m, 'win:\n  signtoolOptions:\n    publisherName: Company Ltd\n'),
  env: {
    MAIN_VITE_POS_API_ORIGIN: 'https://api.company.test',
    MAIN_VITE_POS_UPDATE_FEED_URL: 'https://updates.company.test/pos/'
  },
  files: { 'resources/icon.png': Buffer.from('company icon'), 'build/icon.ico': Buffer.from('ico') }
}

test('a configuration with every input supplied passes', () => {
  assert.deepEqual(releaseInputProblems(supplied), [])
})

test('a loopback origin or a test opt-in is never a release candidate', () => {
  for (const env of [
    { ...supplied.env, MAIN_VITE_POS_API_ORIGIN: 'https://127.0.0.1:8443' },
    { ...supplied.env, MAIN_VITE_POS_API_ORIGIN: 'http://api.company.test' },
    { ...supplied.env, MAIN_VITE_POS_ALLOW_LOOPBACK_ORIGIN: 'true' },
    { ...supplied.env, MAIN_VITE_POS_UPDATE_FEED_URL: 'https://updates.company.test/other/' }
  ]) {
    assert.notDeepEqual(releaseInputProblems({ ...supplied, env }), [], JSON.stringify(env))
  }
})
