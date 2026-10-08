#!/usr/bin/env node
/**
 * Release inputs gate: refuses a release build while any company identity, origin, feed, icon or
 * signing input is still a template value or missing. A package built while this fails is a TEST
 * package, never a release candidate. It only reads files and the build environment; it never reads
 * a signing secret's contents (only whether one is configured).
 *
 *   MAIN_VITE_POS_API_ORIGIN=https://… MAIN_VITE_POS_UPDATE_FEED_URL=https://… npm run verify:release-inputs
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The electron-vite scaffold's icon (resources/icon.png at the first commit). */
const TEMPLATE_ICON_MD5 = 'a2cf889708d9c4959c6808b4584848e4'
const TEMPLATE_HOSTS = ['example.com', 'electron-vite.org', 'electronjs.org']

function topLevel(yaml, key) {
  return new RegExp(`^${key}:\\s*(\\S.*?)\\s*$`, 'm').exec(yaml)?.[1] ?? null
}

/** `key:` inside the top-level `section:` block (two-space indented). */
function nested(yaml, section, key) {
  const block = new RegExp(`^${section}:\\s*\\n((?:[ \\t]+.*\\n|\\s*\\n)*)`, 'm').exec(yaml)?.[1]
  return block ? (new RegExp(`^  ${key}:\\s*(\\S.*?)\\s*$`, 'm').exec(block)?.[1] ?? null) : null
}

function httpsOrigin(value) {
  try {
    const url = new URL(value)
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    return url.protocol === 'https:' && !loopback && !url.username && !url.password ? url : null
  } catch {
    return null
  }
}

function templated(value) {
  return TEMPLATE_HOSTS.some((host) => String(value ?? '').includes(host))
}

/**
 * Every problem that keeps this build from being a release candidate; empty when all inputs are
 * supplied. `files` maps a project-relative path to its bytes (or null when absent).
 */
export function releaseInputProblems({ packageJson, builderYaml, env, files }) {
  const problems = []
  const author = packageJson.author
  const authorText =
    typeof author === 'object' && author
      ? `${author.name ?? ''} <${author.email ?? ''}>`
      : String(author ?? '')

  if (packageJson.productName !== undefined && packageJson.productName !== 'Thinis POS') {
    problems.push('package.json productName must be "Thinis POS"')
  }
  if (topLevel(builderYaml, 'productName') !== 'Thinis POS') {
    problems.push('electron-builder productName must be "Thinis POS"')
  }

  const appId = topLevel(builderYaml, 'appId')
  if (
    !appId ||
    appId === 'com.electron.app' ||
    !/^[a-z][a-z0-9-]*(\.[a-z0-9-]+){2,}$/i.test(appId)
  ) {
    problems.push(`appId is not a company-owned reverse-DNS ID (${appId ?? 'missing'})`)
  }
  if (!authorText.trim() || templated(authorText) || !/<[^@\s>]+@[^@\s>]+>/.test(authorText)) {
    problems.push(
      'package.json author must be the legal publisher with a support e-mail ("Name <email>")'
    )
  }
  if (!httpsOrigin(packageJson.homepage) || templated(packageJson.homepage)) {
    problems.push(
      `package.json homepage is not the company's https homepage (${packageJson.homepage ?? 'missing'})`
    )
  }
  const maintainer = nested(builderYaml, 'linux', 'maintainer')
  if (!maintainer || templated(maintainer)) {
    problems.push(`linux.maintainer is a template value (${maintainer ?? 'missing'})`)
  }

  const icon = files['resources/icon.png']
  if (!icon || createHash('md5').update(icon).digest('hex') === TEMPLATE_ICON_MD5) {
    problems.push('resources/icon.png is the scaffold icon')
  }
  if (!files['build/icon.ico']) {
    problems.push('build/icon.ico (the Windows installer and program icon) is missing')
  }

  if (!httpsOrigin(env.MAIN_VITE_POS_API_ORIGIN)) {
    problems.push('MAIN_VITE_POS_API_ORIGIN is not a non-loopback https origin')
  }
  if (env.MAIN_VITE_POS_ALLOW_LOOPBACK_ORIGIN === 'true') {
    problems.push('MAIN_VITE_POS_ALLOW_LOOPBACK_ORIGIN=true makes a test package')
  }
  const feed = httpsOrigin(env.MAIN_VITE_POS_UPDATE_FEED_URL)
  if (!feed) {
    problems.push('MAIN_VITE_POS_UPDATE_FEED_URL is not an https update feed')
  }
  const publishUrl = nested(builderYaml, 'publish', 'url')
  if (!publishUrl || templated(publishUrl) || !httpsOrigin(publishUrl)) {
    problems.push(`publish.url is a template value (${publishUrl ?? 'missing'})`)
  } else if (feed && new URL(publishUrl).href.replace(/\/$/, '') !== feed.href.replace(/\/$/, '')) {
    problems.push('publish.url and MAIN_VITE_POS_UPDATE_FEED_URL name different feeds')
  }

  const signingConfigured =
    /^\s+(signtoolOptions|azureSignOptions):/m.test(builderYaml) ||
    Boolean(env.WIN_CSC_LINK || env.CSC_LINK)
  if (!signingConfigured) {
    problems.push('Windows code signing is not configured (certificate or signing service)')
  }

  return problems
}

function main() {
  const read = (path) => {
    const full = join(PROJECT_ROOT, path)
    return existsSync(full) ? readFileSync(full) : null
  }
  const problems = releaseInputProblems({
    packageJson: JSON.parse(read('package.json').toString('utf8')),
    builderYaml: read('electron-builder.yml').toString('utf8'),
    env: process.env,
    files: {
      'resources/icon.png': read('resources/icon.png'),
      'build/icon.ico': read('build/icon.ico')
    }
  })
  if (problems.length === 0) {
    console.log('[release-inputs] all release inputs are supplied')
    return
  }
  console.error('[release-inputs] NOT a release candidate; missing or template inputs:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
