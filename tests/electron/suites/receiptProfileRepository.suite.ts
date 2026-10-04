import { equal, ok } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import type { IncomingReceiptProfileVersion } from '../../../src/main/repositories/receiptProfile.repository'
import { databaseTest } from '../support/sandbox'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories } from '../support/realRepositories'

/**
 * Receipt-printing plan §D-11 "Correction B" — the monotonic-revision mirror-ingest protocol,
 * exercised through the real repository (not raw SQL) against a real temp SQLite database.
 */

const COMPANY_A = '00000000-0000-4000-8000-000000000001'
const COMPANY_B = '00000000-0000-4000-8000-000000000002'
const USER_A = '00000000-0000-4000-9000-000000000001'
const NOW = '2026-09-23T12:00:00.000Z'
const LATER = '2026-09-23T12:05:00.000Z'

function version(
  overrides: Partial<IncomingReceiptProfileVersion> = {}
): IncomingReceiptProfileVersion {
  return {
    versionUuid: '10000000-0000-4000-8000-000000000001',
    revision: 1,
    addressLines: ['123 Main St'],
    phone: '+1-555-0100',
    taxIdentifierLabel: 'VAT',
    taxIdentifierValue: 'TAX-1',
    footerLines: ['Thank you'],
    logo: null,
    ...overrides
  }
}

databaseTest('ingest with an undefined block makes no mirror change', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repo = realRepositories(database).receiptProfile

  const outcome = repo.ingest(COMPANY_A, USER_A, null, null, NOW)
  equal(outcome.kind, 'no_profile')
  equal(repo.getCurrent(COMPANY_A)?.capability, 'supported')
  equal(repo.getCurrent(COMPANY_A)?.versionUuid, null)
  closeDatabase(database)
})

databaseTest('a fresh version is inserted and the pointer advances', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repo = realRepositories(database).receiptProfile

  const outcome = repo.ingest(COMPANY_A, USER_A, true, version(), NOW)
  equal(outcome.kind, 'applied')
  ok(outcome.kind === 'applied' && outcome.pointerMoved)
  equal(repo.getCurrent(COMPANY_A)?.versionUuid, version().versionUuid)
  equal(repo.getAuthority(COMPANY_A, USER_A), true)
  closeDatabase(database)
})

databaseTest('the same revision, uuid and content is an idempotent replay', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repo = realRepositories(database).receiptProfile

  repo.ingest(COMPANY_A, USER_A, true, version(), NOW)
  const replay = repo.ingest(COMPANY_A, USER_A, true, version(), LATER)

  equal(replay.kind, 'idempotent_replay')
  equal(
    (
      database.prepare('SELECT COUNT(*) AS n FROM receipt_profile_versions').get() as
        { n: number } | undefined
    )?.n,
    1
  )
  closeDatabase(database)
})

databaseTest('the same revision with a different uuid is rejected, never inserted', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repo = realRepositories(database).receiptProfile

  repo.ingest(COMPANY_A, USER_A, true, version(), NOW)
  const conflict = repo.ingest(
    COMPANY_A,
    USER_A,
    true,
    version({ versionUuid: '10000000-0000-4000-8000-000000000099' }),
    LATER
  )

  equal(conflict.kind, 'rejected_revision_conflict')
  equal(repo.getCurrent(COMPANY_A)?.versionUuid, version().versionUuid)
  equal(
    (
      database.prepare('SELECT COUNT(*) AS n FROM receipt_profile_versions').get() as
        { n: number } | undefined
    )?.n,
    1
  )
  closeDatabase(database)
})

databaseTest(
  'the same revision with different field content is rejected, never inserted',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repo = realRepositories(database).receiptProfile

    repo.ingest(COMPANY_A, USER_A, true, version(), NOW)
    const conflict = repo.ingest(COMPANY_A, USER_A, true, version({ phone: '+1-555-9999' }), LATER)

    equal(conflict.kind, 'rejected_revision_conflict')
    equal(repo.getVersion(version().versionUuid, COMPANY_A)?.phone, '+1-555-0100')
    closeDatabase(database)
  }
)

databaseTest(
  'a lower revision arriving after a higher one is retained as history but never becomes current',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repo = realRepositories(database).receiptProfile

    // Revision 2 arrives first (e.g. a faster admin-publish response).
    repo.ingest(
      COMPANY_A,
      USER_A,
      true,
      version({ versionUuid: '10000000-0000-4000-8000-000000000002', revision: 2 }),
      NOW
    )
    // Revision 1 arrives late (e.g. an overtaken, slower bootstrap response).
    const outcome = repo.ingest(COMPANY_A, USER_A, true, version({ revision: 1 }), LATER)

    ok(outcome.kind === 'applied' && !outcome.pointerMoved)
    equal(repo.getCurrent(COMPANY_A)?.versionUuid, '10000000-0000-4000-8000-000000000002')
    // Still retained as history.
    equal(repo.getVersion(version().versionUuid, COMPANY_A)?.revision, 1)
    closeDatabase(database)
  }
)

databaseTest('an explicit null profile never erases an already-known newer version', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repo = realRepositories(database).receiptProfile

  repo.ingest(COMPANY_A, USER_A, true, version(), NOW)
  const outcome = repo.ingest(COMPANY_A, USER_A, true, null, LATER)

  equal(outcome.kind, 'no_profile')
  equal(repo.getCurrent(COMPANY_A)?.versionUuid, version().versionUuid)
  closeDatabase(database)
})

databaseTest(
  'a pending logo asset is created alongside a fresh version, and pending -> available once',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repo = realRepositories(database).receiptProfile

    repo.ingest(
      COMPANY_A,
      USER_A,
      true,
      version({
        logo: {
          sha256: 'b'.repeat(64),
          mediaType: 'image/png',
          widthPx: 64,
          heightPx: 32,
          byteLength: 100
        }
      }),
      NOW
    )

    const pending = repo.findPendingAssets(COMPANY_A)
    equal(pending.length, 1)
    equal(pending[0]?.sha256, 'b'.repeat(64))

    const applied = repo.markAssetAvailable(
      COMPANY_A,
      'b'.repeat(64),
      Buffer.from('png-bytes'),
      LATER
    )
    equal(applied, true)

    const reapplied = repo.markAssetAvailable(
      COMPANY_A,
      'b'.repeat(64),
      Buffer.from('other'),
      LATER
    )
    equal(reapplied, false, 'a second fetch of an already-available asset must not re-apply')

    const asset = repo.getAsset(COMPANY_A, 'b'.repeat(64))
    equal(asset?.status, 'available')
    equal(asset?.content?.toString(), 'png-bytes')

    const withVersion = repo.getVersion(version().versionUuid, COMPANY_A)
    equal(withVersion?.logoAvailable, true)
    closeDatabase(database)
  }
)

databaseTest('authority reads false (fail-closed) for an unknown company/user pair', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repo = realRepositories(database).receiptProfile
  equal(repo.getAuthority(COMPANY_A, USER_A), false)
  closeDatabase(database)
})

databaseTest(
  'authority is scoped to the exact (company, user) pair -- never contaminates another tenant',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repo = realRepositories(database).receiptProfile

    repo.ingest(COMPANY_A, USER_A, true, version(), NOW)
    repo.ingest(COMPANY_B, USER_A, false, null, NOW)

    equal(repo.getAuthority(COMPANY_A, USER_A), true)
    equal(repo.getAuthority(COMPANY_B, USER_A), false)
    equal(repo.getCurrent(COMPANY_B)?.versionUuid, null)
    closeDatabase(database)
  }
)

databaseTest(
  'POS improvements Stage 6: a v2 version mirrors its display choices with the (insert-only) row; v1 keeps none',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    try {
      const repo = realRepositories(database).receiptProfile
      const displayOptions = {
        show_branch: true,
        show_address: false,
        show_phone: true,
        show_cashier: false,
        show_customer: true,
        show_footer: true,
        logo_size: 'large' as const
      }
      const v1 = version()
      equal(repo.ingest(COMPANY_A, USER_A, true, v1, NOW).kind, 'applied')
      const v2 = {
        ...version(),
        versionUuid: '00000000-0000-4000-8000-0000000000b2',
        revision: 2,
        displayOptions
      }
      const outcome = repo.ingest(COMPANY_A, USER_A, true, v2, LATER)

      equal(outcome.kind, 'applied')
      equal(repo.getVersion(v1.versionUuid, COMPANY_A)?.displayOptions ?? null, null)
      equal(repo.getVersion(v2.versionUuid, COMPANY_A)?.displayOptions?.show_cashier, false)
      equal(repo.getVersion(v2.versionUuid, COMPANY_A)?.displayOptions?.logo_size, 'large')
      // A replay of the same version (same content) stays an idempotent replay.
      equal(repo.ingest(COMPANY_A, USER_A, true, v2, LATER).kind, 'idempotent_replay')
    } finally {
      closeDatabase(database)
    }
  }
)
