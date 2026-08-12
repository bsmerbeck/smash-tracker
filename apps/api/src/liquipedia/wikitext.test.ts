import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadLiquipediaFixture } from './__fixtures__/loadFixture.js';
import {
  LIQUIPEDIA_PARAM_MAX_DEPTH,
  decodeWikiEntities,
  detectTemplateFamily,
  getGameParam,
  getSetParam,
  hashWikitext,
  parseTemplateParameters,
  splitTopLevelTemplates,
  stripWikiComments,
  stripWikiMarkup,
} from './wikitext.js';

interface QueryRevisionFixture {
  query: {
    pages: Array<{
      revisions?: Array<{ slots: { main: { content: string } } }>;
    }>;
  };
}

function wikitextFromFixture(name: string): string {
  const fixture = loadLiquipediaFixture<QueryRevisionFixture>(name);
  const content = fixture.query.pages[0]?.revisions?.[0]?.slots.main.content;
  if (!content) {
    throw new Error(`fixture "${name}" has no revision content`);
  }
  return content;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('stripWikiComments', () => {
  it('removes a comment sitting between a pipe and the next parameter name without merging the two parameters', () => {
    const input = '|a=1|<!-- Grand Finals -->|b=2';
    const stripped = stripWikiComments(input);
    const params = parseTemplateParameters(stripped);
    expect(params.get('a')).toBe('1');
    expect(params.get('b')).toBe('2');
  });

  it('removes a multi-line comment entirely', () => {
    const input = 'before<!--\nmultiline\ncomment\n-->after';
    expect(stripWikiComments(input)).toBe('beforeafter');
  });
});

describe('splitTopLevelTemplates', () => {
  it("returns the Supernova fixture's top-level template calls, including the three bracket templates and the tournament info block", () => {
    const source = wikitextFromFixture('query-supernova-2026-singles-bracket');
    const { templates } = splitTopLevelTemplates(source);
    const names = templates.map((t) => t.name);
    expect(names).toContain('TournamentInfo');
    expect(names).toContain('8DEWBracketA');
    expect(names).toContain('24DELBracketSmwA');
    expect(names).toContain('DEFinalSmwBracket');
  });

  it("does not descend into a nested template's braces when splitting at the top level", () => {
    const source = wikitextFromFixture('query-supernova-2026-singles-bracket');
    const { templates } = splitTopLevelTemplates(source);
    const names = templates.map((t) => t.name);
    // BracketMatchDetails is nested inside each bracket template's `...details=`
    // parameter — it must never surface as its own top-level entry.
    expect(names).not.toContain('BracketMatchDetails');
  });

  it('is bounded: a pathological input of deeply repeated opening braces terminates and reports truncated: true', () => {
    const pathological = '{{'.repeat(10_000);
    const result = splitTopLevelTemplates(pathological, { maxDepth: LIQUIPEDIA_PARAM_MAX_DEPTH });
    expect(result.truncated).toBe(true);
  });
});

describe('parseTemplateParameters', () => {
  it('proves the grand-final and reset scores parse to different values from the real Supernova fixture (no prefix merge)', () => {
    const source = wikitextFromFixture('query-supernova-2026-singles-bracket');
    const { templates } = splitTopLevelTemplates(source);
    const finalBracket = templates.find((t) => t.name === 'DEFinalSmwBracket');
    expect(finalBracket).toBeDefined();
    const params = parseTemplateParameters(finalBracket!.body);

    // Grand-final first-seat player is present, and the reset's first-seat
    // score is a DISTINCT value from the grand final's first-seat score.
    expect(params.get('r3m1p1')).toBe('Tweek');
    expect(params.get('r3m1p1score')).toBe('0');
    expect(params.get('r3m2p1score')).toBe('2');
    expect(params.get('r3m1p1score')).not.toBe(params.get('r3m2p1score'));
  });
});

describe('getSetParam / getGameParam — anchored accessors, no prefix collisions', () => {
  it('a set-winner lookup does not match a per-game winner parameter', () => {
    const params = new Map([
      ['r3m1win', '2'],
      ['r3m1win1', '2'],
      ['r3m1win2', '2'],
    ]);
    expect(getSetParam(params, 'r', 3, 1, 'win')).toBe('2');
    // getGameParam for ordinal 1 must read the DISTINCT key r3m1win1, not fall
    // back to matching r3m1win by prefix.
    expect(getGameParam(params, 'r', 3, 1, 'win', 1)).toBe('2');
  });

  it('a lookup for match 1 does not match matches 10 through 16 (two-digit match-index collision)', () => {
    const params = new Map([
      ['r1m1p1', 'MVD'],
      ['r1m10p1', 'someone-else'],
      ['r1m16p1', 'another'],
    ]);
    expect(getSetParam(params, 'r', 1, 1, 'p1')).toBe('MVD');
    expect(getSetParam(params, 'r', 1, 1, 'p1')).not.toBe('someone-else');
    expect(getSetParam(params, 'r', 1, 10, 'p1')).toBe('someone-else');
  });

  it('reads the real Supernova fixture set-winner vs per-game winner without collision', () => {
    const source = wikitextFromFixture('query-supernova-2026-singles-bracket');
    const { templates } = splitTopLevelTemplates(source);
    const winners = templates.find((t) => t.name === '8DEWBracketA');
    const params = parseTemplateParameters(winners!.body);
    expect(getSetParam(params, 'r', 1, 1, 'win')).toBe('1');
    expect(getGameParam(params, 'r', 1, 1, 'win', 1)).toBe('1');
    expect(getGameParam(params, 'r', 1, 1, 'win', 2)).toBe('2');
    expect(getGameParam(params, 'r', 1, 1, 'stage', 3)).toBe('Φ Town and City');
  });
});

describe('detectTemplateFamily', () => {
  it('returns the modern nested (match2) family for the Full House fixture', () => {
    const source = wikitextFromFixture('query-full-house-2025-singles-bracket');
    const result = detectTemplateFamily(source);
    expect(result.family).toBe('match2');
    expect(result.signature).not.toBeNull();
  });

  it('returns the legacy family for the Supernova and SCU pools bracket fixtures', () => {
    const supernova = wikitextFromFixture('query-supernova-2026-singles-bracket');
    const scuPools = wikitextFromFixture('query-scu-singles-pools-a3');
    expect(detectTemplateFamily(supernova).family).toBe('legacy');
    expect(detectTemplateFamily(scuPools).family).toBe('legacy');
  });

  it('returns the unknown family — with a null signature — for a page containing neither signature, and never falls back to a family', () => {
    const page = '{{DISPLAYTITLE:Some Random Page}}\nJust prose, no bracket templates at all.';
    const result = detectTemplateFamily(page);
    expect(result.family).toBe('unknown');
    expect(result.signature).toBeNull();
  });

  it('returns the unknown family for the real Super Smash Con 2019 tournament-info fixture, which transcludes its bracket rather than containing rNmM params itself', () => {
    // Real-world evidence, not a hand-built string: this fixture is the
    // TOURNAMENT page (Infobox league + s_stageN list), not the bracket
    // page — it has neither the match2 nor the legacy signature, and
    // correctly falls through to 'unknown' per RESEARCH section 3.3's
    // fixed two-signature detection rule.
    const ssc = wikitextFromFixture('query-ssc-2019-ultimate');
    const result = detectTemplateFamily(ssc);
    expect(result.family).toBe('unknown');
    expect(result.signature).toBeNull();
  });
});

describe('hashWikitext — the unknown outcome carries a content hash', () => {
  it('computes a stable, deterministic hash via an injected hash implementation', () => {
    const page = 'no signature here';
    const hash1 = hashWikitext(page, sha256Hex);
    const hash2 = hashWikitext(page, sha256Hex);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is countable and auditable: the unknown-family outcome is paired with its content hash by the caller', () => {
    const page = 'a page with no recognisable template family';
    const { family, signature } = detectTemplateFamily(page);
    const hash = hashWikitext(page, sha256Hex);
    expect(family).toBe('unknown');
    expect(signature).toBeNull();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('decodeWikiEntities', () => {
  it('converts a numeric apostrophe entity', () => {
    expect(decodeWikiEntities('Let&#39;s Make Big Moves/2025')).toBe("Let's Make Big Moves/2025");
  });

  it('converts a non-breaking-space entity', () => {
    expect(decodeWikiEntities('a&#160;b')).toBe('a b');
    expect(decodeWikiEntities('a&nbsp;b')).toBe('a b');
  });

  it('leaves an unrecognised entity byte-for-byte unchanged', () => {
    expect(decodeWikiEntities('a&unknownentity;b')).toBe('a&unknownentity;b');
  });
});

describe('stripWikiMarkup', () => {
  it('removes bold and italic quote runs and the pipe-escape template from a display string', () => {
    const input = "'''Supernova 2025'''{{!}}''Ultimate''";
    const stripped = stripWikiMarkup(input);
    expect(stripped).not.toContain("'''");
    expect(stripped).not.toContain("''");
    expect(stripped).not.toContain('{{!}}');
    expect(stripped).toContain('Supernova 2025');
    expect(stripped).toContain('|');
    expect(stripped).toContain('Ultimate');
  });

  it('removes a File/Image link', () => {
    const input = 'text [[File:VOD Icon.png|15px]] more text';
    const stripped = stripWikiMarkup(input);
    expect(stripped).not.toContain('[[File:');
    expect(stripped).toContain('text');
    expect(stripped).toContain('more text');
  });
});
