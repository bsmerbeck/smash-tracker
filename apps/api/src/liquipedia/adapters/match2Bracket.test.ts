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
