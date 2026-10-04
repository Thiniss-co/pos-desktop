import type { SqliteDatabase } from '../database/connection'

/**
 * What the server said it accepts, from the latest persisted bootstrap (`bootstrap_capabilities`,
 * migration 0030). Replaced as a whole inside the bootstrap persist transaction; an absent block clears
 * the capability, so the register stops using it until the server offers it again.
 */
export class BootstrapCapabilityRepository {
  constructor(private readonly database: SqliteDatabase) {}

  replaceAll(capabilities: Readonly<Record<string, number>>, fetchedAt: string): void {
    // Only a database stopped part-way through its migrations (the upgrade suites run today's code on
    // an older schema) lacks the table; the app migrates fully before any bootstrap. Nothing to record.
    const table = this.database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bootstrap_capabilities'"
      )
      .get()
    if (table === undefined) {
      return
    }
    this.database.prepare('DELETE FROM bootstrap_capabilities').run()
    const insert = this.database.prepare(
      'INSERT INTO bootstrap_capabilities (capability, version, updated_at) VALUES (?, ?, ?)'
    )
    for (const [capability, version] of Object.entries(capabilities)) {
      insert.run(capability, version, fetchedAt)
    }
  }

  getCapabilityVersion(capability: string): number | null {
    const row = this.database
      .prepare('SELECT version FROM bootstrap_capabilities WHERE capability = ?')
      .get(capability) as { version: number } | undefined
    return row?.version ?? null
  }
}
