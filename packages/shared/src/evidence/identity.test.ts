import { describe, expect, it } from 'vitest';
import { canonicalOpponentName, makeCanonicalizer, normalizeOpponentTag } from './identity.js';

describe('normalizeOpponentTag', () => {
  it('returns "unknown" for undefined, null, and empty input', () => {
    expect(normalizeOpponentTag(undefined)).toBe('unknown');
    expect(normalizeOpponentTag(null)).toBe('unknown');
    expect(normalizeOpponentTag('')).toBe('unknown');
  });

  it('keeps the segment after the last "|" (sponsor prefix)', () => {
    expect(normalizeOpponentTag('Sponsor | MkLeo')).toBe('mkleo');
    expect(normalizeOpponentTag('Team A | Team B | Player')).toBe('player');
  });

  it('lowercases and trims', () => {
    expect(normalizeOpponentTag('  MKLeo  ')).toBe('mkleo');
  });

  it('strips RTDB-reserved characters and control characters', () => {
    expect(normalizeOpponentTag('mk.leo#$[]/')).toBe('mkleo');
  });

  it('falls back to "unknown" when stripping leaves nothing', () => {
    expect(normalizeOpponentTag('.#$[]/')).toBe('unknown');
  });
});

describe('canonicalOpponentName (EVID-12)', () => {
  it('normalizes with an empty alias map', () => {
    expect(canonicalOpponentName(undefined, {})).toBe('unknown');
    expect(canonicalOpponentName('Sponsor | MkLeo', {})).toBe('mkleo');
  });

  it('applies a single alias hop', () => {
    expect(canonicalOpponentName('MKLEO', { mkleo: 'leo' })).toBe('leo');
  });

  it('returns the normalized tag unchanged when the alias map has no entry for it', () => {
    expect(canonicalOpponentName('rival', { mkleo: 'leo' })).toBe('rival');
  });

  it('is idempotent over a map whose value set intersects its key set (R1-MEDIUM-7)', () => {
    // Deliberately unflattened: 'leo' -> 'mkleo', and 'mkleo' is ALSO a key
    // (mapping elsewhere). apps/web's `useFilteredMatches.applyOpponentAliases`
    // already rewrites `match.opponent` on a raw-key lookup before the
    // engine ever sees it — the engine's hop must be a no-op on an
    // already-canonical value, or the two would double-hop and disagree.
    const aliasMap = { leo: 'mkleo', mkleo: 'somebody-else' };
    const tags = ['leo', 'mkleo', 'somebody-else', 'unrelated-tag'];
    for (const tag of tags) {
      const once = canonicalOpponentName(tag, aliasMap);
      const twice = canonicalOpponentName(once, aliasMap);
      expect(twice, `idempotence for tag "${tag}"`).toBe(once);
    }
  });
});

describe('makeCanonicalizer', () => {
  it('is equivalent to canonicalOpponentName for the same alias map', () => {
    const aliasMap = { mkleo: 'leo' };
    const canonicalize = makeCanonicalizer(aliasMap);
    expect(canonicalize('MKLEO')).toBe(canonicalOpponentName('MKLEO', aliasMap));
    expect(canonicalize(undefined)).toBe(canonicalOpponentName(undefined, aliasMap));
  });

  it('is idempotent over an unflattened map (same proof as canonicalOpponentName)', () => {
    const aliasMap = { leo: 'mkleo', mkleo: 'somebody-else' };
    const canonicalize = makeCanonicalizer(aliasMap);
    for (const tag of ['leo', 'mkleo', 'somebody-else']) {
      const once = canonicalize(tag);
      expect(canonicalize(once)).toBe(once);
    }
  });
});
