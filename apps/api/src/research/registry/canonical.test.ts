import { describe, expect, it } from 'vitest';
import { canonicalDigest, canonicalJson } from './canonical.js';

/**
 * The canonicalization law is compared ACROSS tools (the operator seals a
 * hash; audit tooling recomputes it), so its edge cases are contract, not
 * implementation detail.
 */
describe('canonicalJson', () => {
  it('sorts object keys recursively and preserves array order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, 1, 2] } })).toBe(
      '{"a":{"c":[3,1,2],"d":2},"b":1}',
    );
  });

  it('omits object members whose value is undefined, exactly as JSON.stringify does', () => {
    // The house RTDB rule conditional-spreads absent members, but a hash must
    // not depend on which form the caller used.
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it('serializes an undefined array element as null, mirroring JSON.stringify', () => {
    expect(canonicalJson([1, undefined, 2])).toBe('[1,null,2]');
  });

  it('distinguishes null from an absent member', () => {
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}));
  });

  it('encodes scalars as JSON', () => {
    expect(canonicalJson('x')).toBe('"x"');
    expect(canonicalJson(4)).toBe('4');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(undefined)).toBe('null');
  });
});

describe('canonicalDigest', () => {
  it('is a stable 64-hex sha256 that ignores key order', () => {
    const first = canonicalDigest({ b: 1, a: 2 });
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(canonicalDigest({ a: 2, b: 1 })).toBe(first);
    expect(canonicalDigest({ a: 2, b: 2 })).not.toBe(first);
  });
});
