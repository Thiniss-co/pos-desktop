import { describe, expect, it } from 'vitest'
import {
  buildPrepareRequest,
  replayBodyFromCanonical,
  PREPARE_CONTRACT_VERSION
} from './preparationRequest'

/*
 * CP3 — the canonical prepare request (plan §5.2, §5.3).
 *
 * These are byte-level assertions on purpose. The hash is the operation's identity across restarts,
 * process death, and ambiguous retry, so anything that silently changes these bytes would break
 * replay for every operation already in flight in the field.
 */

const OPERATION = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'
const PRODUCT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PRODUCT_C = 'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC'
const CATALOG = 'a'.repeat(64)

describe('the canonical prepare request', () => {
  it('fixes key order and normalizes case and ordering', () => {
    const request = buildPrepareRequest({
      operationUuid: OPERATION,
      requestedPolicyRevision: 17,
      // Deliberately unsorted and mixed-case on the way in.
      productUuids: [PRODUCT_C, PRODUCT_B],
      licenseValidationUuid: '22222222-2222-4222-8222-222222222222',
      catalogRevision: CATALOG
    })

    expect(request.canonicalJson).toBe(
      '{"prepare_contract_version":1,"requested_policy_revision":17,' +
        `"authority":{"authority_reference_version":1,"license_validation_uuid":"22222222-2222-4222-8222-222222222222","catalog_revision":"${CATALOG}"},` +
        `"selection":{"selection_version":1,"kind":"products","product_uuids":["${PRODUCT_B}","${PRODUCT_C.toLowerCase()}"]}}`
    )
  })

  it('excludes the operation uuid and the response representation from business identity', () => {
    // §5.2: the operation UUID is the replay *scope*, not a hashed field — it is what the hash is
    // compared within. The response representation selects a shape and grants no authority.
    const first = buildPrepareRequest({
      operationUuid: OPERATION,
      requestedPolicyRevision: 1,
      productUuids: [PRODUCT_B],
      licenseValidationUuid: null,
      catalogRevision: null
    })
    const second = buildPrepareRequest({
      operationUuid: '99999999-9999-4999-8999-999999999999',
      requestedPolicyRevision: 1,
      productUuids: [PRODUCT_B],
      licenseValidationUuid: null,
      catalogRevision: null
    })

    expect(second.requestHash).toBe(first.requestHash)
    expect(first.canonicalJson).not.toContain('response_representation_version')
    expect(first.canonicalJson).not.toContain(OPERATION.toLowerCase())
    // ...but the wire body carries both.
    expect(first.body.operation_uuid).toBe(OPERATION.toLowerCase())
    expect(first.body.response_representation_version).toBe(1)
  })

  it('never lets two different eligible sets hash alike', () => {
    // The withdrawn `{"kind":"all","product_uuids":[]}` form made exactly this happen (§5.3), which
    // is why `kind` is now a constant and the members are always carried verbatim.
    const one = buildPrepareRequest({
      operationUuid: OPERATION,
      requestedPolicyRevision: 1,
      productUuids: [PRODUCT_B],
      licenseValidationUuid: null,
      catalogRevision: null
    })
    const both = buildPrepareRequest({
      operationUuid: OPERATION,
      requestedPolicyRevision: 1,
      productUuids: [PRODUCT_B, PRODUCT_C],
      licenseValidationUuid: null,
      catalogRevision: null
    })

    expect(one.requestHash).not.toBe(both.requestHash)
  })

  it('is order-independent but not membership-independent', () => {
    const forward = buildPrepareRequest({
      operationUuid: OPERATION,
      requestedPolicyRevision: 1,
      productUuids: [PRODUCT_B, PRODUCT_C],
      licenseValidationUuid: null,
      catalogRevision: null
    })
    const reversed = buildPrepareRequest({
      operationUuid: OPERATION,
      requestedPolicyRevision: 1,
      productUuids: [PRODUCT_C, PRODUCT_B],
      licenseValidationUuid: null,
      catalogRevision: null
    })

    expect(reversed.requestHash).toBe(forward.requestHash)
  })

  it('rejects an empty or duplicated selection', () => {
    expect(() =>
      buildPrepareRequest({
        operationUuid: OPERATION,
        requestedPolicyRevision: 1,
        productUuids: [],
        licenseValidationUuid: null,
        catalogRevision: null
      })
    ).toThrow(/non-empty explicit product selection/)

    // Silently collapsing duplicates would let two different client intents produce one hash.
    expect(() =>
      buildPrepareRequest({
        operationUuid: OPERATION,
        requestedPolicyRevision: 1,
        productUuids: [PRODUCT_B, PRODUCT_B],
        licenseValidationUuid: null,
        catalogRevision: null
      })
    ).toThrow(/same product twice/)
  })

  it('changes the hash when any hashed authority reference changes', () => {
    const base = {
      operationUuid: OPERATION,
      requestedPolicyRevision: 1,
      productUuids: [PRODUCT_B],
      licenseValidationUuid: null,
      catalogRevision: null
    }
    const withCatalog = buildPrepareRequest({ ...base, catalogRevision: CATALOG })
    const withRevision = buildPrepareRequest({ ...base, requestedPolicyRevision: 2 })

    expect(withCatalog.requestHash).not.toBe(buildPrepareRequest(base).requestHash)
    expect(withRevision.requestHash).not.toBe(buildPrepareRequest(base).requestHash)
  })

  it('replays the exact stored bytes rather than rebuilding from current state', () => {
    // §7.2 step 5: recovery replays the frozen bytes verbatim. It never re-partitions, re-freezes,
    // or re-hashes, however much local state has moved on since.
    const original = buildPrepareRequest({
      operationUuid: OPERATION,
      requestedPolicyRevision: 17,
      productUuids: [PRODUCT_C, PRODUCT_B],
      licenseValidationUuid: null,
      catalogRevision: CATALOG
    })

    expect(replayBodyFromCanonical(original.operationUuid, original.canonicalJson)).toEqual(
      original.body
    )
    expect(PREPARE_CONTRACT_VERSION).toBe(1)
  })
})
