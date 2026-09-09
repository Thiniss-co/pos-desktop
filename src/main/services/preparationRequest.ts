import { createHash } from 'node:crypto'

/**
 * CP3 (plan §5.2, §5.3): the canonical prepare request, and the only place its hash is derived.
 *
 * This module is deliberately pure — no database, no clock, no network. The bytes it produces are
 * frozen into `prepare_operations.canonical_request_json` before any dispatch and replayed verbatim
 * thereafter, so anything non-deterministic in here would silently break ambiguous retry.
 *
 * Two rules the shape encodes:
 *
 *  1. **Key order is part of the contract.** §5.3 fixes the order of every key and nested key, and
 *     JavaScript object literals preserve insertion order under `JSON.stringify`, so the literal in
 *     `canonicalBusinessObject` *is* the specification. Reordering it changes every hash.
 *  2. **Only business identity is hashed.** `operation_uuid` is the replay *scope*, not a hashed
 *     field — it is what the hash is compared within. `response_representation_version` selects a
 *     response shape and grants no authority, so it is excluded. Owner, company, and warehouse are
 *     derived server-side from the device context and are never client claims.
 *
 * The withdrawn `{"kind":"all","product_uuids":[]}` form is unrepresentable here: `kind` is the
 * literal `'products'` and the array is always non-empty and sorted. That form made two different
 * eligible sets hash identically, which is exactly the defect §5.3 removed.
 */

export const PREPARE_CONTRACT_VERSION = 1
export const PREPARE_SELECTION_VERSION = 1
export const PREPARE_AUTHORITY_REFERENCE_VERSION = 1
export const PREPARE_RESPONSE_REPRESENTATION_VERSION = 1

export interface PrepareRequestInput {
  readonly operationUuid: string
  readonly requestedPolicyRevision: number
  readonly productUuids: readonly string[]
  readonly licenseValidationUuid: string | null
  readonly catalogRevision: string | null
}

export interface CanonicalPrepareRequest {
  readonly operationUuid: string
  readonly productUuids: readonly string[]
  readonly canonicalJson: string
  readonly requestHash: string
  /** The complete HTTP body, including the fields excluded from business identity. */
  readonly body: Record<string, unknown>
}

function normalizeUuid(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * Freeze one request.
 *
 * Duplicates are rejected rather than silently collapsed: two different client intents must never
 * produce one hash, and §5.3 rejects a duplicated selection outright.
 */
export function buildPrepareRequest(input: PrepareRequestInput): CanonicalPrepareRequest {
  const productUuids = input.productUuids.map(normalizeUuid)

  if (productUuids.length === 0) {
    throw new Error('A preparation request requires a non-empty explicit product selection.')
  }

  if (new Set(productUuids).size !== productUuids.length) {
    throw new Error('A preparation request may not select the same product twice.')
  }

  const sorted = [...productUuids].sort()
  const operationUuid = normalizeUuid(input.operationUuid)
  const licenseValidationUuid =
    input.licenseValidationUuid === null ? null : normalizeUuid(input.licenseValidationUuid)
  const catalogRevision =
    input.catalogRevision === null ? null : normalizeUuid(input.catalogRevision)

  // §5.3, verbatim, in exactly this key order.
  const canonical = {
    prepare_contract_version: PREPARE_CONTRACT_VERSION,
    requested_policy_revision: input.requestedPolicyRevision,
    authority: {
      authority_reference_version: PREPARE_AUTHORITY_REFERENCE_VERSION,
      license_validation_uuid: licenseValidationUuid,
      catalog_revision: catalogRevision
    },
    selection: {
      selection_version: PREPARE_SELECTION_VERSION,
      kind: 'products',
      product_uuids: sorted
    }
  }

  const canonicalJson = JSON.stringify(canonical)

  return {
    operationUuid,
    productUuids: sorted,
    canonicalJson,
    requestHash: createHash('sha256').update(canonicalJson, 'utf8').digest('hex'),
    body: {
      operation_uuid: operationUuid,
      prepare_contract_version: PREPARE_CONTRACT_VERSION,
      requested_policy_revision: input.requestedPolicyRevision,
      selection_version: PREPARE_SELECTION_VERSION,
      product_uuids: sorted,
      authority_reference_version: PREPARE_AUTHORITY_REFERENCE_VERSION,
      license_validation_uuid: licenseValidationUuid,
      catalog_revision: catalogRevision,
      response_representation_version: PREPARE_RESPONSE_REPRESENTATION_VERSION
    }
  }
}

/**
 * Rebuild the exact HTTP body for a frozen operation, from its stored canonical bytes.
 *
 * §7.2 step 5: recovery replays *those* bytes; it never re-partitions, re-freezes, or re-hashes. So
 * this reads the stored canonical object and reassembles the wire body around it, rather than
 * re-deriving anything from current local state — which by definition may have moved on.
 */
export function replayBodyFromCanonical(
  operationUuid: string,
  canonicalJson: string
): Record<string, unknown> {
  const canonical = JSON.parse(canonicalJson) as {
    prepare_contract_version: number
    requested_policy_revision: number
    authority: {
      authority_reference_version: number
      license_validation_uuid: string | null
      catalog_revision: string | null
    }
    selection: { selection_version: number; kind: string; product_uuids: string[] }
  }

  return {
    operation_uuid: operationUuid,
    prepare_contract_version: canonical.prepare_contract_version,
    requested_policy_revision: canonical.requested_policy_revision,
    selection_version: canonical.selection.selection_version,
    product_uuids: canonical.selection.product_uuids,
    authority_reference_version: canonical.authority.authority_reference_version,
    license_validation_uuid: canonical.authority.license_validation_uuid,
    catalog_revision: canonical.authority.catalog_revision,
    response_representation_version: PREPARE_RESPONSE_REPRESENTATION_VERSION
  }
}
