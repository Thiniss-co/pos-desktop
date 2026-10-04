import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

export const DESKTOP_ROOT = resolve(HERE, '..', '..', '..')
export const BACKEND_ROOT = resolve(DESKTOP_ROOT, '..', 'pos-backend')
export const SANDBOX_SUPPORT = join(DESKTOP_ROOT, 'tests', 'electron', 'support', 'sandbox')
export const EVIDENCE_ROOT = join(DESKTOP_ROOT, 'docs', 'audits', 'pp-selling-integration')
