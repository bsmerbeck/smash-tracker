import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { researchEnrichmentObservationRecordSchema } from '@smash-tracker/shared';
import { loadLiquipediaFixture } from '../__fixtures__/loadFixture.js';
import type { LiquipediaEventContext } from '../eventContext.js';
import { extractLegacyBracketObservations } from './legacyBracket.js';
import { extractMatch2BracketObservations } from './match2Bracket.js';

interface QueryRevisionFixture {
  query: {
    pages: Array<{
      revisions?: Array<{
        revid?: number;
        sha1?: string;
        slots: { main: { content: string } };
      }>;
    }>;
  };
}

function wikitextFromFixture(name: string): {
  wikitext: string;
  revisionId: number;
  sha1: string | null;
} {
  const fixture = loadLiquipediaFixture<QueryRevisionFixture>(name);
  const revision = fixture.query.pages[0]?.revisions?.[0];
  const content = revision?.slots.main.content;
  if (!content) {
    throw new Error(`fixture "${name}" has no revision content`);
  }
  return { wikitext: content, revisionId: revision.revid ?? 0, sha1: revision.sha1 ?? null };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const NOW_MS = 1_754_000_000_000;

/**
 * Full House 2025 is a real-world Melee major — the fixture's own page
 * carries no `game=` declaration (only `{{HiddenDataBox|phase=2}}`), so this
 * test supplies the source game explicitly to exercise the game-scope guard
 * (RESEARCH section 4.5): a Melee stage name that happens to also exist in
 * our Ultimate `StageList` (`Battlefield`, `Dream Land`, ...) must NOT map
 * onto that entry.
 */
function meleeEventContext(): LiquipediaEventContext {
  return {
    pageTitle: 'Full House/2025/Singles Bracket',
    pageUrl: 'https://liquipedia.net/smash/Full_House/2025/Singles_Bracket',
    revisionId: 533391,
    sha1: null,
    game: 'melee',
    tournamentPageTitle: 'Full House/2025',
    tournamentDisplayName: 'Full House 2025',
    startggSlug: null,
    startggSlugKey: null,
    startDateIso: '2025-05-16',
    endDateIso: '2025-05-18',
    aliasRemaps: [],
    rulesetStageRaw: [],
    phase: '2',
    reasons: [],
  };
}

describe('extractMatch2BracketObservations', () => {
  it('yields one observation per nested match block, each carrying both opponent tags, both scores and its game rows', () => {
    const { wikitext, revisionId, sha1 } = wikitextFromFixture(
      'query-full-house-2025-singles-bracket',
    );
    const eventContext = meleeEventContext();
    const { observations } = extractMatch2BracketObservations({
      wikitext,
      pageTitle: 'Full House/2025/Singles Bracket',
      revisionId,
      sha1,
      eventContext,
      targetGame: 'ultimate',
      nowMs: NOW_MS,
      hashHex: sha256Hex,
    });

    expect(observations.length).toBe(22);
    const r2m1 = observations.find((o) => o.bracketKey?.endsWith('R2M1'))!;
    expect(r2m1.players!.map((p) => p.rawTag)).toEqual(['moky', 'Salt']);
    expect(r2m1.rawScores).toEqual(['3', '0']);
    expect(r2m1.games!.length).toBe(3);
  });

  it('reads per-game stocks from the second field of the character template call, not from a separate stocks parameter', () => {
    const { wikitext, revisionId, sha1 } = wikitextFromFixture(
      'query-full-house-2025-singles-bracket',
    );
    const eventContext = meleeEventContext();
    const { observations } = extractMatch2BracketObservations({
      wikitext,
      pageTitle: 'Full House/2025/Singles Bracket',
      revisionId,
      sha1,
      eventContext,
      targetGame: 'ultimate',
      nowMs: NOW_MS,
      hashHex: sha256Hex,
    });
    const r2m1 = observations.find((o) => o.bracketKey?.endsWith('R2M1'))!;
    // map1: o1c1={{Chars|fox,1}}, o2c1={{Chars|cf,0}}
    const game1 = r2m1.games!.find((g) => g.ordinal === 1)!;
    expect(game1.rawChars).toEqual(['fox', 'cf']);
    expect(game1.stocks).toEqual([1, 0]);
  });

  it('derives the set winner from the two scores because no set-winner parameter exists in this family, and sets the derived flag', () => {
    const { wikitext, revisionId, sha1 } = wikitextFromFixture(
      'query-full-house-2025-singles-bracket',
    );
    const eventContext = meleeEventContext();
    const { observations } = extractMatch2BracketObservations({
      wikitext,
      pageTitle: 'Full House/2025/Singles Bracket',
      revisionId,
      sha1,
      eventContext,
      targetGame: 'ultimate',
      nowMs: NOW_MS,
      hashHex: sha256Hex,
    });
    const r2m1 = observations.find((o) => o.bracketKey?.endsWith('R2M1'))!;
    expect(r2m1.setWinnerSeat).toBe(1);
    expect(r2m1.setWinnerDerived).toBe(true);
  });

  it('reads the VOD and date from the match block directly, stripping the tracking parameter in the canonical value while preserving the raw value', () => {
    const { wikitext, revisionId, sha1 } = wikitextFromFixture(
      'query-full-house-2025-singles-bracket',
    );
    const eventContext = meleeEventContext();
    const { observations } = extractMatch2BracketObservations({
      wikitext,
      pageTitle: 'Full House/2025/Singles Bracket',
      revisionId,
      sha1,
      eventContext,
      targetGame: 'ultimate',
      nowMs: NOW_MS,
      hashHex: sha256Hex,
    });
    const r2m1 = observations.find((o) => o.bracketKey?.endsWith('R2M1'))!;
    expect(r2m1.rawVodUrl).toBe('https://youtu.be/JFOBV1Hb2E8?si=JkdgpFiE1BRvNLtN');
    expect(r2m1.vodUrl).toBe('https://www.youtube.com/watch?v=JFOBV1Hb2E8');
    expect(r2m1.rawDate).toBe('May 18, 2025');
    expect(r2m1.date).toBe('2025-05-18');
  });

  it('yields null canonical ids for Melee-era stage names under the game-scope guard, with the raw strings preserved', () => {
    const { wikitext, revisionId, sha1 } = wikitextFromFixture(
      'query-full-house-2025-singles-bracket',
    );
    const eventContext = meleeEventContext();
    const { observations } = extractMatch2BracketObservations({
      wikitext,
      pageTitle: 'Full House/2025/Singles Bracket',
      revisionId,
      sha1,
      eventContext,
      targetGame: 'ultimate',
      nowMs: NOW_MS,
      hashHex: sha256Hex,
    });
    const r2m1 = observations.find((o) => o.bracketKey?.endsWith('R2M1'))!;
    const dreamLandGame = r2m1.games!.find((g) => g.rawStage === 'Battlefield')!;
    expect(dreamLandGame.canonicalStageId).toBeNull();
    expect(dreamLandGame.rawStage).toBe('Battlefield');
  });

  it('flags a nested match block whose structure it cannot classify as an extraction failure with a reason naming the unclassified construct, and never sets a bracket-reset flag', () => {
    const wikitext = `{{Bracket|Bracket/test|id=TestId

|R1M1={{Match
|opponent1={{SoloOpponent|A|flag=us|score=1}}
|someWeirdBlock={{ThirdPartyThing|foo=bar}}
|date=May 18, 2025
}}
}}`;
    const eventContext = meleeEventContext();
    const { observations } = extractMatch2BracketObservations({
      wikitext,
      pageTitle: 'Test/Unclassifiable',
      revisionId: 1,
      sha1: null,
      eventContext,
      targetGame: 'ultimate',
      nowMs: NOW_MS,
      hashHex: sha256Hex,
    });
    expect(observations.length).toBe(1);
    const observation = observations[0]!;
    expect(observation.extractionFailed).toBe(true);
    expect(observation.resolutionReasons?.length).toBeGreaterThan(0);
    expect(observation.resolutionReasons?.[0]).toContain('R1M1');
    expect('isBracketReset' in observation).toBe(false);
  });

  it('never sets a bracket-reset flag on any successfully-extracted record either', () => {
    const { wikitext, revisionId, sha1 } = wikitextFromFixture(
      'query-full-house-2025-singles-bracket',
    );
    const eventContext = meleeEventContext();
    const { observations } = extractMatch2BracketObservations({
      wikitext,
      pageTitle: 'Full House/2025/Singles Bracket',
      revisionId,
      sha1,
      eventContext,
      targetGame: 'ultimate',
      nowMs: NOW_MS,
      hashHex: sha256Hex,
    });
    for (const observation of observations) {
      expect('isBracketReset' in observation).toBe(false);
    }
  });

  it('emits a record shape field-for-field assignable to the same schema the legacy adapter emits — a consumer cannot distinguish family except by the declared template family member', () => {
    const legacyFixture = wikitextFromFixture('query-supernova-2026-singles-bracket');
    const match2Fixture = wikitextFromFixture('query-full-house-2025-singles-bracket');

    const sharedEventContext: LiquipediaEventContext = {
      pageTitle: 'Test/Shared',
      pageUrl: 'https://liquipedia.net/smash/Test/Shared',
      revisionId: 1,
      sha1: null,
      game: 'ultimate',
      tournamentPageTitle: 'Test/Tournament',
      tournamentDisplayName: 'Test Tournament',
      startggSlug: 'test-tournament',
      startggSlugKey: 'startgg',
      startDateIso: '2025-01-01',
      endDateIso: '2025-01-02',
      aliasRemaps: [],
      rulesetStageRaw: [],
      phase: '1',
      reasons: [],
    };

    const { observations: legacyObservations } = extractLegacyBracketObservations({
      wikitext: legacyFixture.wikitext,
      pageTitle: 'Supernova/2026/Ultimate/Singles Bracket',
      revisionId: legacyFixture.revisionId,
      sha1: legacyFixture.sha1,
      eventContext: sharedEventContext,
      targetGame: 'ultimate',
      nowMs: NOW_MS,
      hashHex: sha256Hex,
    });
    const { observations: match2Observations } = extractMatch2BracketObservations({
      wikitext: match2Fixture.wikitext,
      pageTitle: 'Full House/2025/Singles Bracket',
      revisionId: match2Fixture.revisionId,
      sha1: match2Fixture.sha1,
      eventContext: sharedEventContext,
      targetGame: 'ultimate',
      nowMs: NOW_MS,
      hashHex: sha256Hex,
    });

    const legacyRecord = legacyObservations.find((o) => o.bracketKey === '8DEWBracketA r1m1')!;
    const match2Record = match2Observations.find((o) => o.bracketKey?.endsWith('R2M1'))!;

    const legacyParsed = researchEnrichmentObservationRecordSchema.parse(legacyRecord);
    const match2Parsed = researchEnrichmentObservationRecordSchema.parse(match2Record);

    // `sectionHeading` is excluded alongside the declared family/parser
    // version: it is populated from a real `==Heading==` line, a construct
    // that exists only in the legacy family's page layout — Family B pages
    // carry round hints only in COMMENTS, which neither adapter is allowed
    // to parse as authority (this module's header). Every other member is
    // held to strict parity.
    const legacyKeys = Object.keys(legacyParsed)
      .filter((k) => k !== 'templateFamily' && k !== 'parserVersion' && k !== 'sectionHeading')
      .sort();
    const match2Keys = Object.keys(match2Parsed)
      .filter((k) => k !== 'templateFamily' && k !== 'parserVersion' && k !== 'sectionHeading')
      .sort();

    expect(match2Keys).toEqual(legacyKeys);
    expect(legacyRecord.templateFamily).toBe('legacy');
    expect(match2Record.templateFamily).toBe('match2');
  });

  it('sets matchingStatus to the same initial unmatched value the legacy adapter uses', () => {
    const { wikitext, revisionId, sha1 } = wikitextFromFixture(
      'query-full-house-2025-singles-bracket',
    );
    const eventContext = meleeEventContext();
    const { observations } = extractMatch2BracketObservations({
      wikitext,
      pageTitle: 'Full House/2025/Singles Bracket',
      revisionId,
      sha1,
      eventContext,
      targetGame: 'ultimate',
      nowMs: NOW_MS,
      hashHex: sha256Hex,
    });
    expect(observations.length).toBeGreaterThan(0);
    for (const observation of observations) {
      expect(observation.matchingStatus).toBe('unmatched');
    }
  });
});

// ---------------------------------------------------------------------------
// 30.2 reliability gate — the write-boundary player-slot defect class,
// match2 equivalents of the legacy adapter's regression suite: missing,
// empty, whitespace-only, partially filled and TBD/bye opponents must never
// persist `rawTag: ""` and never fabricate a player — each becomes an
// extraction-failure record WITHOUT `players` that still passes the exact
// persistence schema.
// ---------------------------------------------------------------------------

describe('extractMatch2BracketObservations player-slot classification', () => {
  function extractHandBuilt(matchBody: string) {
    const wikitext = `{{Bracket|Bracket/test|id=TestId

|R1M1={{Match
${matchBody}
}}
}}`;
    const eventContext = meleeEventContext();
    return extractMatch2BracketObservations({
      wikitext,
      pageTitle: 'Test/PlayerSlots',
      revisionId: 1,
      sha1: null,
      eventContext,
      targetGame: 'ultimate',
      nowMs: NOW_MS,
      hashHex: sha256Hex,
    });
  }

  function expectFailureWithoutPlayers(
    observations: ReturnType<typeof extractMatch2BracketObservations>['observations'],
  ) {
    expect(observations.length).toBe(1);
    const observation = observations[0]!;
    expect(observation.extractionFailed).toBe(true);
    expect(observation.players).toBeUndefined();
    expect(observation.resolutionReasons?.length).toBeGreaterThan(0);
    expect(researchEnrichmentObservationRecordSchema.safeParse(observation).success).toBe(true);
  }

  // 30.3 verifier closure 4: these three inputs are rejected by
  // `parseSoloOpponent` ITSELF (an empty/whitespace-only first positional
  // segment yields a null parse) — the classifier never runs for them. The
  // labels state the path that actually fires; the OUTCOME contract (an
  // extraction failure without `players`, never `rawTag: ""`) is identical
  // either way, which is exactly what these lock in.
  it('both opponents present but empty are rejected by the SoloOpponent parse (null opponents) — an extraction failure, never rawTag ""', () => {
    const { observations } = extractHandBuilt(
      '|opponent1={{SoloOpponent||score=3}}\n|opponent2={{SoloOpponent||score=1}}',
    );
    expectFailureWithoutPlayers(observations);
    expect(observations[0]!.resolutionReasons?.join(' ')).toContain('could not be parsed');
  });

  it('one empty and one populated opponent: the empty side fails the SoloOpponent parse — extraction failure, never a half-fabricated pairing', () => {
    const { observations } = extractHandBuilt(
      '|opponent1={{SoloOpponent|moky|score=3}}\n|opponent2={{SoloOpponent||score=0}}',
    );
    expectFailureWithoutPlayers(observations);
    expect(observations[0]!.resolutionReasons?.join(' ')).toContain('could not be parsed');
  });

  it('a whitespace-only opponent tag fails the SoloOpponent parse (trimmed to empty) — extraction failure', () => {
    const { observations } = extractHandBuilt(
      '|opponent1={{SoloOpponent|   |score=3}}\n|opponent2={{SoloOpponent|Salt|score=0}}',
    );
    expectFailureWithoutPlayers(observations);
    expect(observations[0]!.resolutionReasons?.join(' ')).toContain('could not be parsed');
  });

  // The CLASSIFIER path (a parseable tag that is a placeholder) — the same
  // case variants the legacy suite covers.
  it.each(['TBD', 'tbd', 'Bye', 'BYE'])(
    'a %s placeholder opponent never persists as a player (classifier path)',
    (placeholder) => {
      const { observations } = extractHandBuilt(
        `|opponent1={{SoloOpponent|moky|score=3}}\n|opponent2={{SoloOpponent|${placeholder}|score=0}}`,
      );
      expectFailureWithoutPlayers(observations);
      expect(observations[0]!.resolutionReasons?.join(' ')).toContain('placeholder');
    },
  );

  it('a missing opponent2 parameter is an extraction failure, never a one-player set', () => {
    const { observations } = extractHandBuilt('|opponent1={{SoloOpponent|moky|score=3}}');
    expectFailureWithoutPlayers(observations);
  });

  it('BOTH opponent parameters missing entirely is an extraction failure, never a playerless set', () => {
    const { observations } = extractHandBuilt('|date=May 18, 2025');
    expectFailureWithoutPlayers(observations);
    expect(observations[0]!.resolutionReasons?.join(' ')).toContain('could not be parsed');
  });

  it('usable opponents keep their trimmed tags and conditional-spread flags', () => {
    const { observations } = extractHandBuilt(
      '|opponent1={{SoloOpponent|moky|flag=ca|score=3}}\n|opponent2={{SoloOpponent|Salt|score=0}}',
    );
    expect(observations.length).toBe(1);
    const observation = observations[0]!;
    expect(observation.players).toEqual([{ rawTag: 'moky', flag: 'ca' }, { rawTag: 'Salt' }]);
    expect(researchEnrichmentObservationRecordSchema.safeParse(observation).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 30.2 production defect C, match2 half: a page hosting MULTIPLE
// `{{Bracket}}` calls previously extracted only the FIRST (silent drop),
// and a shared layout name + shared R1M1 coordinates would have collided
// ids had they been processed. Every instance must extract, with distinct
// ids per instance.
// ---------------------------------------------------------------------------

describe('extractMatch2BracketObservations multi-bracket pages', () => {
  it('extracts EVERY {{Bracket}} instance on a page, with distinct observation ids for same-layout same-coordinate matches', () => {
    const wikitext = `{{Bracket|Bracket/test|id=PoolA

|R1M1={{Match
|opponent1={{SoloOpponent|Alice|score=3}}
|opponent2={{SoloOpponent|Bob|score=1}}
}}
}}
{{Bracket|Bracket/test|id=PoolB

|R1M1={{Match
|opponent1={{SoloOpponent|Carol|score=3}}
|opponent2={{SoloOpponent|Dave|score=2}}
}}
}}`;
    const eventContext = meleeEventContext();
    const { observations } = extractMatch2BracketObservations({
      wikitext,
      pageTitle: 'Test/MultiBracket',
      revisionId: 1,
      sha1: null,
      eventContext,
      targetGame: 'ultimate',
      nowMs: NOW_MS,
      hashHex: sha256Hex,
    });

    expect(observations).toHaveLength(2);
    const [poolA, poolB] = observations;
    expect(poolA!.observationId).not.toBe(poolB!.observationId);
    expect(poolA!.players!.map((p) => p.rawTag)).toEqual(['Alice', 'Bob']);
    expect(poolB!.players!.map((p) => p.rawTag)).toEqual(['Carol', 'Dave']);
    for (const observation of observations) {
      expect(researchEnrichmentObservationRecordSchema.safeParse(observation).success).toBe(true);
    }
  });
});
