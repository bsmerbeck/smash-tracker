import { createHash } from 'node:crypto';

/**
 * Phase 30.3 registry-operator hardening: the ONE canonicalization law every
 * registry hash obeys — the reviewed manifest's `contentHash`, a per-account
 * `rowSetHash`, the foreign-row digest, and a receipt's `contentHash`.
 *
 * Having a single implementation matters because these hashes are compared
 * ACROSS tools: the operator seals them, and a separate audit tool (which
 * imports this module rather than re-deriving the rule) verifies them. Two
 * "obviously equivalent" canonicalizers that disagree on one edge case would
 * make an honest apply look like tampering, or worse, the reverse.
 *
 * The law:
 * - object keys sorted lexicographically, recursively;
 * - array order preserved (it is content);
 * - an object member whose value is `undefined` is OMITTED, exactly as
 *   `JSON.stringify` omits it — so a builder that conditional-spreads an
 *   absent member and one that assigns `undefined` hash identically (the
 *   house RTDB conditional-spread rule makes the first form the norm, but a
 *   hash must not depend on which form a caller used);
 * - an `undefined` ARRAY element serializes as `null`, again mirroring
 *   `JSON.stringify`.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** sha256 of the canonical JSON encoding of `value`, lowercase hex. */
export function canonicalDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
