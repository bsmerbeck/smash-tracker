import { describe, expect, it, vi } from 'vitest';
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

  it('CR-01/WR-04: follows a chained alias map (unflattened: a key is also a value) to its TERMINAL name, not the intermediate hop', () => {
    // This fixture is deliberately unflattened: 'leo' -> 'mkleo', and
    // 'mkleo' is ALSO a key (mapping elsewhere) — the exact shape
    // `RtdbService.setOpponentAlias` can produce across two separate merge
    // actions (merge "leo" into "mkleo", then later merge "mkleo" into
    // "somebody-else"; the write side does not re-point the first edge).
    //
    // DELIBERATE CHANGE FROM THE PRIOR EXPECTATION (recorded per fix
    // instructions): the previous "value-set shortcut" implementation
    // stopped resolving `'mkleo'` the moment it saw `'mkleo'` was already a
    // VALUE somewhere in the map, returning it UNCHANGED — silently
    // re-splitting "leo"/"mkleo" matches away from "somebody-else" and
    // violating ROADMAP SC1 ("one alias-merged opponent shows as one
    // row"). The correct behaviour is a full chain walk to the terminal
    // name: both `'leo'` and `'mkleo'` must resolve to `'somebody-else'`.
    const aliasMap = { leo: 'mkleo', mkleo: 'somebody-else' };
    expect(canonicalOpponentName('leo', aliasMap)).toBe('somebody-else');
    expect(canonicalOpponentName('mkleo', aliasMap)).toBe('somebody-else');
    expect(canonicalOpponentName('somebody-else', aliasMap)).toBe('somebody-else');
    expect(canonicalOpponentName('unrelated-tag', aliasMap)).toBe('unrelated-tag');
  });

  it('is idempotent over a map whose value set intersects its key set (R1-MEDIUM-7)', () => {
    const aliasMap = { leo: 'mkleo', mkleo: 'somebody-else' };
    const tags = ['leo', 'mkleo', 'somebody-else', 'unrelated-tag'];
    for (const tag of tags) {
      const once = canonicalOpponentName(tag, aliasMap);
      const twice = canonicalOpponentName(once, aliasMap);
      expect(twice, `idempotence for tag "${tag}"`).toBe(once);
    }
  });

  it('follows a three-hop chain to its terminal name', () => {
    const aliasMap = { a: 'b', b: 'c', c: 'd' };
    expect(canonicalOpponentName('a', aliasMap)).toBe('d');
    expect(canonicalOpponentName('b', aliasMap)).toBe('d');
    expect(canonicalOpponentName('c', aliasMap)).toBe('d');
    expect(canonicalOpponentName('d', aliasMap)).toBe('d');
  });

  it('rejects a direct self-alias defensively: resolving a name that maps to itself terminates rather than looping', () => {
    // The write side (`RtdbService.setOpponentAlias`) already rejects a
    // direct self-merge with a `ValidationError` before it can ever be
    // stored — this is a defense-in-depth read-side proof that IF such a
    // map ever existed (a manually-edited or corrupted RTDB node), the
    // resolver still terminates deterministically instead of looping.
    const aliasMap = { rival: 'rival' };
    expect(canonicalOpponentName('rival', aliasMap)).toBe('rival');
  });

  it('resolves a 2-member cycle to its lexicographically smallest member, the same way from either starting point', () => {
    // Not reachable through the current write path (see the module doc
    // comment), but a corrupted/hand-edited map must still terminate
    // deterministically rather than loop.
    const aliasMap = { zeta: 'alpha', alpha: 'zeta' };
    expect(canonicalOpponentName('zeta', aliasMap)).toBe('alpha');
    expect(canonicalOpponentName('alpha', aliasMap)).toBe('alpha');
  });

  it('resolves a 3-member cycle to its lexicographically smallest member, the same way from every starting point', () => {
    const aliasMap = { charlie: 'alpha', alpha: 'bravo', bravo: 'charlie' };
    expect(canonicalOpponentName('charlie', aliasMap)).toBe('alpha');
    expect(canonicalOpponentName('alpha', aliasMap)).toBe('alpha');
    expect(canonicalOpponentName('bravo', aliasMap)).toBe('alpha');
  });

  it('is idempotent over a synthetic cyclic map: resolving the cycle representative again is a no-op', () => {
    const aliasMap = { charlie: 'alpha', alpha: 'bravo', bravo: 'charlie' };
    for (const tag of ['charlie', 'alpha', 'bravo']) {
      const once = canonicalOpponentName(tag, aliasMap);
      const twice = canonicalOpponentName(once, aliasMap);
      expect(twice, `idempotence for tag "${tag}"`).toBe(once);
    }
  });

  it('IN-01-i2: warns exactly once, with no tag content, when the hop cap is reached without a terminal or a cycle', () => {
    // An implausibly deep, deliberately ACYCLIC chain (100 hops, well past
    // MAX_ALIAS_HOPS) — no legitimate write path produces this today, but
    // the fallback should not fail silently if it's ever exercised.
    const aliasMap: Record<string, string> = {};
    for (let i = 0; i < 100; i += 1) {
      aliasMap[`sentinel-tag-${i}`] = `sentinel-tag-${i + 1}`;
    }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = canonicalOpponentName('sentinel-tag-0', aliasMap);
      // Still resolves to SOME deterministic value — the hop cap is a
      // fail-safe, never a throw.
      expect(typeof result).toBe('string');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [message] = warnSpy.mock.calls[0]!;
      expect(String(message)).toContain('hop cap');
      // Never leaks any opponent tag/name from the map into the log line.
      for (const key of Object.keys(aliasMap)) {
        expect(String(message)).not.toContain(key);
      }
    } finally {
      warnSpy.mockRestore();
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

  it('CR-01/WR-04: follows the full chain to the terminal name, same as canonicalOpponentName', () => {
    const aliasMap = { leo: 'mkleo', mkleo: 'somebody-else' };
    const canonicalize = makeCanonicalizer(aliasMap);
    expect(canonicalize('leo')).toBe('somebody-else');
    expect(canonicalize('mkleo')).toBe('somebody-else');
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

describe('web/API/engine parity over one shared alias map (WR-04)', () => {
  // The same chained alias map every one of the three surfaces named in
  // WR-04 must resolve identically for: `canonicalOpponentName` (the
  // engine's direct entry point), `makeCanonicalizer` (what
  // `apps/api/src/reports/generate.ts`, `reports/synthesis.ts`, and
  // `routes/prepBindings.ts` all call), and a hand-rolled equivalent of
  // `apps/web/src/hooks/useFilteredMatches.ts`'s `applyOpponentAliases`
  // (which now calls `canonicalOpponentName` directly — see that module).
  const SHARED_ALIAS_MAP = { leo: 'mkleo', mkleo: 'somebody-else' };
  const RAW_TAGS = ['leo', 'mkleo', 'somebody-else', 'unrelated-tag'];

  it('canonicalOpponentName and makeCanonicalizer agree for every tag', () => {
    const canonicalize = makeCanonicalizer(SHARED_ALIAS_MAP);
    for (const tag of RAW_TAGS) {
      expect(canonicalize(tag), `parity for tag "${tag}"`).toBe(
        canonicalOpponentName(tag, SHARED_ALIAS_MAP),
      );
    }
  });

  it('every raw tag in a chain converges on the same terminal identity, regardless of which hop it started from', () => {
    const resolved = RAW_TAGS.filter((tag) => tag !== 'unrelated-tag').map((tag) =>
      canonicalOpponentName(tag, SHARED_ALIAS_MAP),
    );
    expect(new Set(resolved)).toEqual(new Set(['somebody-else']));
  });
});
