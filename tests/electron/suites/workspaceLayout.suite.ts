import { deepEqual, equal, throws } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import { WorkspaceLayoutService } from '../../../src/main/services/workspaceLayout.service'
import {
  clonePreset,
  defaultWorkspaceLayout
} from '../../../src/shared/contracts/posWorkspace.contract'
import { databaseTest } from '../support/sandbox'
import { openTestDatabase, openExistingTestDatabase } from '../support/openTestDatabase'
import { realRepositories } from '../support/realRepositories'

/**
 * POS workspace — the layout table (migration 0033) on the real schema: one row per company + user +
 * workstation, survives reopening, a stale context token never writes, restore defaults deletes the
 * row, a corrupted row is salvaged on read, and the database itself enforces JSON validity and size.
 */
databaseTest(
  'workspace layouts are isolated by company, user and device and survive reopening',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    let context = {
      isAuthenticated: true,
      companyUuid: 'company-a',
      userUuid: 'cashier-1',
      deviceUuid: 'device-1',
      serverDeviceId: 11
    }
    let epoch = 1
    try {
      const { workspaceLayout } = realRepositories(database)
      const service = new WorkspaceLayoutService({
        session: { getContext: () => context },
        epoch: { current: () => epoch },
        repository: workspaceLayout,
        now: () => new Date('2026-10-06T12:00:00Z')
      })

      const first = service.read()
      deepEqual(first.layout, defaultWorkspaceLayout())
      equal(first.stored, false)

      const scanner = { ...clonePreset('scanner'), cartSide: 'start' as const }
      deepEqual(
        service.write({ layout: scanner, contextToken: first.contextToken! }).layout,
        scanner
      )

      for (const other of [
        { userUuid: 'cashier-2' },
        { companyUuid: 'company-b' },
        { deviceUuid: 'device-2' }
      ]) {
        const previous = context
        context = { ...context, ...other }
        deepEqual(service.read().layout, defaultWorkspaceLayout())
        context = previous
      }

      // A token from before a session change never writes.
      const stale = service.read().contextToken!
      epoch = 2
      throws(() => service.write({ layout: clonePreset('balanced'), contextToken: stale }))
      deepEqual(service.read().layout, scanner)

      // Updates in place: one row per owner.
      const balanced = clonePreset('balanced')
      service.write({ layout: balanced, contextToken: service.read().contextToken! })
      equal(database.prepare('SELECT COUNT(*) FROM user_workspace_layouts').pluck().get(), 1)
      equal(database.prepare('SELECT schema_version FROM user_workspace_layouts').pluck().get(), 1)
    } finally {
      closeDatabase(database)
    }

    const reopened = openExistingTestDatabase(sandbox)
    try {
      const service = new WorkspaceLayoutService({
        session: { getContext: () => context },
        epoch: { current: () => epoch },
        repository: realRepositories(reopened).workspaceLayout
      })
      deepEqual(service.read().layout, clonePreset('balanced'))

      // Restore defaults removes the row.
      deepEqual(
        service.write({ layout: null, contextToken: service.read().contextToken! }).layout,
        defaultWorkspaceLayout()
      )
      equal(reopened.prepare('SELECT COUNT(*) FROM user_workspace_layouts').pluck().get(), 0)

      // A hand-edited (valid JSON, bad values) row is salvaged, not fatal.
      reopened
        .prepare(
          `INSERT INTO user_workspace_layouts VALUES ('company-a', 'cashier-1', 'device-1',
             '{"version":1,"cartSide":"start","cartShare":5,"sections":{"cart":["lines"]}}', 1, 'now')`
        )
        .run()
      deepEqual(service.read().layout, { ...defaultWorkspaceLayout(), cartSide: 'start' })

      // The schema refuses invalid JSON, oversized blobs, empty owners and unknown versions.
      const insert = (json: string, version = 1, user = 'u'): unknown =>
        reopened
          .prepare(`INSERT INTO user_workspace_layouts VALUES ('c', ?, 'd', ?, ?, 'now')`)
          .run(user, json, version)
      throws(() => insert('{not json'))
      throws(() => insert(JSON.stringify({ padding: 'x'.repeat(2100) })))
      throws(() => insert('{}', 2))
      throws(() => insert('{}', 1, ''))
    } finally {
      closeDatabase(reopened)
    }
  }
)
