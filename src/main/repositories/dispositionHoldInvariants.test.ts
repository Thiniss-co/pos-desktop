import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * PS6b — structural guards on the invariants this checkpoint must not disturb.
 *
 * These are source assertions rather than behavioural ones on purpose. The properties below are
 * about what the code does NOT do, and an absence cannot be observed by exercising a happy path:
 * a regression here would not fail any functional test, it would quietly make an unaccepted
 * allocation quantity look reusable.
 */
/**
 * Strip comments before scanning.
 *
 * These files explain AT LENGTH why they leave the consumption journal alone, and those explanations
 * legitimately name the very identifiers the guards below forbid. Scanning raw text would therefore
 * fail on the documentation rather than on the code — and, worse, would pressure a future author to
 * delete the explanation in order to make the guard pass.
 */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/--.*$/gm, '')
}

describe('PS6b allocation journal invariants', () => {
  const discovery = code('src/main/services/invoiceDispositionDiscovery.service.ts')
  const repository = code('src/main/repositories/stockAllocation.repository.ts')
  const migration = code('src/main/database/migrations/0013_disposition_discovery.ts')

  it('never writes to the immutable consumption journal', () => {
    // Review finding T1. Excluding an overridden row from a quantity sum cannot repair a broken
    // server sequence and cannot reproduce the local chain hash — it would make the quantity look
    // reusable while the chain stayed broken, which is the worst of both.
    for (const forbidden of [
      'UPDATE local_stock_allocation_consumptions',
      'DELETE FROM local_stock_allocation_consumptions',
      'INSERT INTO local_stock_allocation_consumptions'
    ]) {
      expect(discovery).not.toContain(forbidden)
    }

    // The migration adds no column to it and does not rebuild it either.
    expect(migration).not.toContain('local_stock_allocation_consumptions')
  })

  it('leaves committed-quantity, next-sequence and chain-hash arithmetic untouched', () => {
    // The discovery path must not participate in any of these calculations at all.
    for (const untouched of [
      'committedQuantityAboveSequence',
      'nextConsumptionSequence',
      'chain_hash',
      'entry_hash'
    ]) {
      expect(discovery).not.toContain(untouched)
    }
  })

  it('uses a hold table ordinary reconciliation cannot clear', () => {
    // `stock_allocation_holds` is deleted by reconciliation, so a later verifying boundary would
    // silently clear a hold that must never clear (review finding T7).
    expect(migration).toContain('CREATE TABLE stock_allocation_disposition_holds')
    expect(discovery).toContain('stock_allocation_disposition_holds')
    expect(discovery).not.toContain('INSERT INTO stock_allocation_holds')
  })

  it('offers no path that clears a disposition hold', () => {
    // There is no clearing path in this scope, by design: closing one requires a separately proven
    // consumption or release, under a gate that stays disabled.
    for (const forbidden of [
      'DELETE FROM stock_allocation_disposition_holds',
      'UPDATE stock_allocation_disposition_holds'
    ]) {
      expect(discovery).not.toContain(forbidden)
      expect(repository).not.toContain(forbidden)
    }

    // And `release_allowed` is structurally pinned rather than merely defaulted.
    expect(migration).toContain('CHECK (release_allowed = 0)')
  })

  it('gates BOTH grant selection and spendability on the hold', () => {
    // Either alone would leave the grant reachable through the other path.
    const usableGrants = repository.slice(
      repository.indexOf('usableGrantsForProduct('),
      repository.indexOf('hasDispositionHold(allocationUuid: string')
    )
    const spendable = repository.slice(repository.indexOf('spendableMilli(allocationUuid: string)'))

    expect(usableGrants).toContain('stock_allocation_disposition_holds')
    expect(spendable).toContain('hasDispositionHold')
  })

  it('performs exactly one narrow, guarded queue transition', () => {
    // A generic "clear rejected rows" helper would apply to failures no operator ever decided.
    expect(discovery).toContain("UPDATE sync_queue SET state = 'synced'")
    expect(discovery).toContain("WHERE local_queue_uuid = ? AND state = 'rejected'")

    const transitions = discovery.match(/UPDATE sync_queue/g) ?? []
    expect(transitions).toHaveLength(1)
  })

  it('never rewrites a frozen payload or an idempotency key', () => {
    for (const forbidden of [
      'UPDATE sync_queue SET payload_json',
      'UPDATE sync_queue SET idempotency_key'
    ]) {
      expect(discovery).not.toContain(forbidden)
    }
  })
})
