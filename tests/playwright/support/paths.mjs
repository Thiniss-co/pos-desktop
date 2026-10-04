import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

export const DESKTOP_ROOT = resolve(HERE, '..', '..', '..')
// PW_BACKEND_ROOT points the journeys at another backend tree (e.g. a disposable export), so a run never
// writes logs or caches into a working checkout; the sibling ../pos-backend is the default.
export const BACKEND_ROOT = process.env.PW_BACKEND_ROOT
  ? resolve(process.env.PW_BACKEND_ROOT)
  : resolve(DESKTOP_ROOT, '..', 'pos-backend')
export const SANDBOX_SUPPORT = join(DESKTOP_ROOT, 'tests', 'electron', 'support', 'sandbox')
// PW_EVIDENCE_ROOT redirects journey evidence to another audit folder; pp-selling-integration is the default.
export const EVIDENCE_ROOT = process.env.PW_EVIDENCE_ROOT
  ? resolve(process.env.PW_EVIDENCE_ROOT)
  : join(DESKTOP_ROOT, 'docs', 'audits', 'pp-selling-integration')
